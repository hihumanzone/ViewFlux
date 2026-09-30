import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import shaka from 'shaka-player'
import { isAudioItagUrl, languageName } from '../../../../shared/media'
import {
  audioCode,
  normLang,
  sameLanguage,
  type AudioTrack,
  type PlayerProps,
  type TextTrack,
  type VariantTrack
} from './types'

export interface UseShakaPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  /**
   * The player root element. Shaka needs it to build a `UITextDisplayer`, which
   * is what makes captions real DOM we can position and style.
   */
  containerRef: React.RefObject<HTMLDivElement | null>
  videoId: string
  manifestUrl: string
  startPosition: number
  autoplay: boolean
  /**
   * Hint from the main process (`basic_info.is_live`). Manifest-level live
   * settings (presentation delay, `hls.sequenceMode`, `disableText`) are only
   * read while the manifest is being parsed, so they have to be configured
   * *before* `load()` — which means we cannot wait for `player.isLive()`.
   * The authoritative answer still comes from Shaka after loading; this hint
   * only decides what to ask for up front.
   */
  isLive: boolean
  preferredQuality: PlayerProps['preferredQuality']
  alwaysShowCaptions: boolean
  defaultAudioLanguage: string | null
  captions: PlayerProps['captions']
  initialVolume: number
  safeInitialSpeed: number
  preservePitch: boolean
  scrubbingRef: React.RefObject<boolean>
  onTimeUpdate: (position: number, duration: number) => void
  onEnded: () => void
  maybeSkip: (time: number) => void
  onCaptionsToggle?: (visible: boolean) => void
  onOsd?: (text: string, icon?: string) => void
}

/**
 * Live streams arrive from the main process as YouTube's own DASH MPD
 * (`type="dynamic"`, `minimumUpdatePeriod="PT5S"`, `timeShiftBufferDepth` of up
 * to 4 hours, fMP4 segments) and only fall back to YouTube's classic HLS master
 * (`#EXT-X-VERSION:3`, 5 s `#EXTINF`, a 30 s DVR window, demuxed MPEG-TS video +
 * raw `ID3` audio) when no DASH manifest is available for the broadcast.
 *
 * Everything in this block is timeline-agnostic and applies to both, but the
 * *reasons* differ, so they are worth spelling out:
 *
 * - `bufferBehind` / `rebufferingGoal` are measured in seconds of *media*. The
 *   VOD values (60 s behind, 2 s clear of the back) are sized for a long file;
 *   on the HLS fallback they reach past the end of a 30 s window, which makes
 *   Shaka stall at the back edge or evict what it just downloaded.
 * - `safeSeekEndOffset` parks the playhead a couple of seconds inside the window
 *   rather than exactly on the sliding edge.
 * - `returnToEndOfLiveWindowWhenOutside` is what snaps us back to the live edge
 *   when the window slides past the playhead. NewPipe does the same thing
 *   (re-preparing on `ERROR_CODE_BEHIND_LIVE_WINDOW`).
 * - `stallThreshold` drops from the VOD 5 s to 1 s so a freeze is caught inside a
 *   single segment.
 * - `disableText` / `disableIFrames` / `disableThumbnails`: the only subtitles
 *   we ever show are the separately fetched VTT tracks added through
 *   `addTextTrackAsync`, and re-parsing the extra renditions out of a manifest
 *   that rewrites itself every few seconds is a well-known source of
 *   intermittent live stalls.
 *
 * The `manifest.hls.*` keys in {@link LIVE_MANIFEST_CONFIG} are inert unless the
 * HLS fallback is actually used — Shaka only consults them when parsing HLS.
 *
 * `liveSync` is deliberately left off. It trims latency *relative to
 * `seekRange().end`*, which already sits `presentationDelay` behind the true
 * live edge — pairing it with an explicit presentation delay would count the
 * cushion twice and slowly walk the stream away from live. The playhead
 * already follows the edge on its own, so we pin the delay and expose an
 * explicit "Go live" control instead.
 */
const buildLiveStreamingConfig = (): Record<string, unknown> => ({
  rebufferingGoal: 2,
  bufferingGoal: 10,
  bufferBehind: 15,
  // Land a couple of seconds inside the window instead of exactly on its edge.
  safeSeekEndOffset: 2,
  // Already the Shaka default, but load-bearing here: it is what snaps us back
  // to the live edge when the DVR window slides past the playhead (NewPipe
  // does the same thing on ERROR_CODE_BEHIND_LIVE_WINDOW).
  returnToEndOfLiveWindowWhenOutside: true,
  // React to a freeze in ~2 s.
  stallThreshold: 2,
  stallEnabled: true
})

/**
 * Manifest-parser settings for live. Only consulted while Shaka parses the
 * manifest, so this has to be applied before `load()` — the streaming half of
 * the live config is separate because it stays adjustable afterwards.
 *
 * The `hls` block configures Shaka's HLS parser: `sequenceMode: false` ensures
 * segments are appended in 'segments' mode, preserving presentation timestamps
 * and keeping demuxed audio and video tracks synchronized.
 */
const LIVE_MANIFEST_CONFIG = {
  // The only subtitles we ever show are the separately fetched VTT tracks added
  // through `addTextTrackAsync`; re-parsing the extra renditions out of a
  // manifest that rewrites itself every few seconds is a well-known source of
  // intermittent live stalls.
  disableText: true,
  disableIFrames: true,
  disableThumbnails: true,
  hls: {
    sequenceMode: false,
    liveSegmentsDelay: 2
  }
}

/** `shaka.util.Error.Code.LOAD_INTERRUPTED` — see `onPlayerError` for why. */
const CODE_LOAD_INTERRUPTED = 7000

/**
 * Networking (1001 `BAD_HTTP_STATUS`, 1002 `HTTP_ERROR`, 1003 `TIMEOUT`) and
 * MSE/transform failures (3014-3019). All of these clear up on a fresh
 * manifest, and on a live stream a fresh manifest is exactly what the playlist
 * refresh would have produced anyway — so they must not be fatal.
 */
const RECOVERABLE_CODES = new Set([1001, 1002, 1003, 3014, 3015, 3016, 3017, 3018, 3019])

/**
 * Codes that only make sense to retry on a live stream, where the resource in
 * question is regenerated constantly: 1011 `SEGMENT_MISSING` (a segment aged
 * out of the 30 s window between the playlist poll and the fetch) and 4053
 * `HLS_EMPTY_MEDIA_PLAYLIST` (emitted for the first poll of a broadcast that
 * has not produced a segment yet).
 */
const LIVE_RECOVERABLE_CODES = new Set([1011, 4053])

/** How far behind the live edge we still count as "live" for the UI. */
const LIVE_EDGE_TOLERANCE = 8

/* ---- Audio language helpers ------------------------------------------------
 *
 * The original-dub logic used to be spelled out inline at every call site, which
 * let the three copies drift. They all reduce to the same two questions —
 * "are these the same language?" and "which track is the original?" — so they
 * live here now.
 *
 * `normLang` / `sameLanguage` live in `./types` next to `audioCode` because the
 * audio menu has to compare codes the same way; see the note there.
 */

/**
 * The audio track we want by default: the video's original dub, falling back to
 * English and then to whatever the manifest offers first. `wanted` comes from
 * the main process, which resolves it from the player response's
 * `audioIsDefault`/`is_original` markers.
 */
const resolveOriginalTrack = (
  audio: AudioTrack[],
  wanted: string | null
): AudioTrack | undefined => {
  if (audio.length === 0) return undefined
  const target = normLang(wanted)
  if (target) {
    const exact = audio.find((track) => normLang(audioCode(track)) === target)
    if (exact) return exact
    const loose = audio.find((track) => sameLanguage(audioCode(track), target))
    if (loose) return loose
  }
  return audio.find((track) => sameLanguage(audioCode(track), 'en')) ?? audio[0]
}

/**
 * The audio language Shaka is *actually* playing right now, read back from the
 * player rather than remembered.
 *
 * This has to be authoritative. `player.selectAudioTrack()` can be silently
 * overridden by the ABR manager (Shaka itself warns about this in `player.js`:
 * "Changing tracks while abr manager is enabled will likely result in the
 * selected track being overridden"), by a later `selectVariantTrack()`, or by
 * the fresh adaptation set criteria that every `load()` rebuilds. Any of those
 * leave the UI confidently reporting a track that is not the one on screen, so
 * the menu must ask the player instead of trusting its own optimistic state.
 *
 * `getAudioTracks()` already marks the live one (`active` is derived from the
 * current variant). The variant scan is a fallback for the window between a
 * variant switch and that flag settling.
 */
const activeAudioCode = (player: shaka.Player): string | null => {
  const activeTrack = player.getAudioTracks().find((track) => track.active)
  if (activeTrack) return normLang(audioCode(activeTrack))
  const activeVariant = player.getVariantTracks().find((track) => track.active)
  return activeVariant?.audioLanguage ? normLang(activeVariant.audioLanguage) : null
}

export function useShakaPlayer({
  videoRef,
  containerRef,
  videoId,
  manifestUrl,
  startPosition,
  autoplay,
  isLive,
  preferredQuality,
  alwaysShowCaptions,
  defaultAudioLanguage,
  captions,
  initialVolume,
  safeInitialSpeed,
  preservePitch,
  scrubbingRef,
  onTimeUpdate,
  onEnded,
  maybeSkip,
  onCaptionsToggle,
  onOsd
}: UseShakaPlayerProps) {
  const playerRef = useRef<shaka.Player | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [busy, setBusy] = useState(true)
  const [statusText, setStatusText] = useState('Loading video…')
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState<[number, number][]>([])
  /** Authoritative liveness, as reported by Shaka after the manifest loads. */
  const [live, setLive] = useState(false)
  /** DVR window `[start, end]`, in presentation time. `null` until live. */
  const [liveWindow, setLiveWindow] = useState<{ start: number; end: number } | null>(null)

  const [variantTracks, setVariantTracks] = useState<VariantTrack[]>([])
  const [selectedHeight, setSelectedHeight] = useState<number | null>(null)
  const [selectedAudioTier, setSelectedAudioTier] = useState<string | null>(null)
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([])
  const [selectedAudioLang, setSelectedAudioLang] = useState<string | null>(null)
  const [textTracks, setTextTracks] = useState<TextTrack[]>([])
  const [activeTextId, setActiveTextId] = useState<number | null>(null)
  const [textVisible, setTextVisible] = useState(false)

  // Recovery & watchdog refs
  const statusRef = useRef(status)
  statusRef.current = status
  const playingRef = useRef(playing)
  playingRef.current = playing
  const recoveryCount = useRef(0)
  const lastRecoveryRef = useRef(0)
  const lastProgressRef = useRef({ t: 0, at: Date.now() })
  const liveRef = useRef(false)
  liveRef.current = live
  const recoverPlaybackRef = useRef<((reason: string) => Promise<void>) | null>(null)
  /**
   * The audio language we want playing: the viewer's explicit pick, or else the
   * original dub. Survives manifest reloads (which rebuild Shaka's adaptation
   * set criteria from scratch) so recovery lands on the same track instead of
   * wherever the manifest happens to list first.
   */
  const audioLangRef = useRef<string | null>(null)
  const defaultLangRef = useRef(defaultAudioLanguage)
  defaultLangRef.current = defaultAudioLanguage
  /**
   * Guards the "Shaka drifted off our language, put it back" re-pin against
   * fighting itself: if a language genuinely cannot be selected, retrying on
   * every adaptation event would spin forever.
   */
  const repinAttemptsRef = useRef(0)
  const lastReportRef = useRef(0)
  const lastDurationRef = useRef(0)
  const onTimeUpdateRef = useRef(onTimeUpdate)
  onTimeUpdateRef.current = onTimeUpdate
  const onEndedRef = useRef(onEnded)
  onEndedRef.current = onEnded

  const levelHeights = useMemo(() => {
    const byHeight = new Map<number, number>()
    for (const track of variantTracks) {
      if (!track.height) continue
      byHeight.set(track.height, Math.max(byHeight.get(track.height) ?? 0, track.bandwidth))
    }
    return [...byHeight.entries()]
      .map(([height, bandwidth]) => ({ height, bandwidth }))
      .sort((a, b) => b.height - a.height)
  }, [variantTracks])

  const audioTiers = useMemo(() => {
    const tierOf = (bps: number): string =>
      bps < 96_000 ? 'Low' : bps < 192_000 ? 'Medium' : 'High'
    const present = new Set<string>()
    for (const track of variantTracks) {
      if (track.audioBandwidth) present.add(tierOf(track.audioBandwidth))
    }
    return (['High', 'Medium', 'Low'] as const).filter((tier) => present.has(tier))
  }, [variantTracks])

  const audioLanguages = useMemo(() => {
    const seen = new Set<string>()
    const unique: { code: string; label: string }[] = []
    for (const track of audioTracks) {
      // Normalized so menu codes are canonical: the same codes are compared
      // against the language read back from the player, and the manifest is
      // free to spell them `en-US` where the player says `en-us`.
      const code = normLang(audioCode(track))
      if (seen.has(code)) continue
      seen.add(code)
      unique.push({
        code,
        label: code === 'und' ? 'Original' : languageName(code)
      })
    }
    return unique
  }, [audioTracks])

  const isOriginalLanguage = useCallback(
    (code: string): boolean => {
      const wanted = normLang(defaultAudioLanguage)
      return wanted !== '' && sameLanguage(code, wanted)
    },
    [defaultAudioLanguage]
  )

  /**
   * Tell *Shaka* which language we want, not just ask it for a one-off switch.
   *
   * `selectAudioTrack()` alone is not a setting, it is a request. Shaka builds
   * every later variant decision — the initial one, each ABR quality switch,
   * each `selectVariantTrack()` — from `config.preferredAudio`, which defaults
   * to `[{language: ''}]` (i.e. "no preference, take whatever the manifest
   * lists first"). Worse, `selectVariantTrack()` *overwrites* that preference
   * with the language of the variant it was handed (Shaka's own workaround in
   * `player.js` for issue #1299), so a quality change could quietly repin the
   * player onto a dubbed track. Declaring the language up front makes the
   * preference survive all of that.
   */
  const pinAudioLanguage = useCallback((code: string): void => {
    const player = playerRef.current
    if (!player) return
    player.configure({
      preferredAudio: [
        { language: code, role: '', label: '', channelCount: 0, spatialAudio: false }
      ]
    } as unknown as shaka.extern.PlayerConfiguration)
  }, [])

  /**
   * Put the wanted language on screen, then report back what actually happened.
   *
   * `reconcile` reads the active track from the player instead of trusting the
   * code we just asked for, so a silently-ignored switch can never leave the
   * menu showing a checkmark on a track that isn't playing.
   */
  const applyAudioSelection = useCallback(
    (code: string | null, { select = true }: { select?: boolean } = {}): void => {
      const player = playerRef.current
      if (!player) return
      audioLangRef.current = code
      if (code) pinAudioLanguage(code)
      if (select) {
        const track = player
          .getAudioTracks()
          .find((a) => sameLanguage(audioCode(a), code))
        if (track) {
          try {
            player.selectAudioTrack(track)
          } catch {
            /* single rendition — there is nothing to switch to */
          }
        }
      }
      // Report what the player is really playing, falling back to the requested
      // language only when the player cannot name an active track at all (the
      // brief window around a variant switch). Showing nothing there is worse
      // than showing the intent, and the next `adaptation` event corrects it.
      setSelectedAudioLang(activeAudioCode(player) ?? code)
    },
    [pinAudioLanguage]
  )

  /**
   * Re-state the audio choice after a `load()`. A reload rebuilds Shaka's
   * adaptation set criteria from scratch, so the language has to be applied
   * again; if the remembered track is not in the fresh manifest, fall back to
   * the original dub rather than to whatever the new manifest lists first.
   */
  const reapplyAudioAfterLoad = useCallback((): void => {
    const player = playerRef.current
    if (!player) return
    const fresh = player.getAudioTracks()
    if (fresh.length === 0) return
    setAudioTracks(fresh)
    const remembered = audioLangRef.current
    const stillOffered =
      remembered != null &&
      fresh.some((a) => sameLanguage(audioCode(a), remembered))
    const fallback = resolveOriginalTrack(fresh, defaultLangRef.current)
    // `fresh` is non-empty, so `resolveOriginalTrack` always yields a track.
    const target = stillOffered || !fallback ? remembered : normLang(audioCode(fallback))
    repinAttemptsRef.current = 0
    applyAudioSelection(target)
  }, [applyAudioSelection])

  /**
   * Shaka is authoritative. Whenever it changes tracks on its own (ABR, a
   * quality switch, a manifest update) we re-read the active language, and if it
   * wandered off the wanted one we put it back. The attempt counter stops that
   * from looping when the wanted language genuinely cannot be selected.
   */
  const reconcileAudioSelection = useCallback((): void => {
    const player = playerRef.current
    if (!player) return
    const actual = activeAudioCode(player)
    const wanted = audioLangRef.current
    setSelectedAudioLang(actual ?? wanted)
    if (!wanted || !actual || sameLanguage(actual, wanted)) return
    if (repinAttemptsRef.current >= 3) return
    repinAttemptsRef.current += 1
    applyAudioSelection(wanted)
  }, [applyAudioSelection])

  /**
   * Best variant for a quality/tier request, preferring ones that already carry
   * the wanted audio language.
   *
   * The fallback matters: handing Shaka a variant from another language is what
   * repinned the player onto a dub, but refusing to switch quality at all
   * because the top rendition happens to be on a different track would be its
   * own bug. So try the wanted language first, then accept whatever the viewer
   * explicitly asked for and let the audio re-pin immediately afterwards.
   */
  const pickVariant = useCallback(
    (
      tracks: VariantTrack[],
      matches: (t: VariantTrack) => boolean = () => true,
      rank: (a: VariantTrack, b: VariantTrack) => number = (a, b) => b.bandwidth - a.bandwidth
    ): VariantTrack | undefined => {
      const wanted = audioLangRef.current
      const inLanguage = (t: VariantTrack): boolean =>
        !wanted || sameLanguage(normLang(t.audioLanguage ?? t.language), normLang(wanted))
      return (
        tracks.filter((t) => matches(t) && inLanguage(t)).sort(rank)[0] ??
        tracks.filter(matches).sort(rank)[0]
      )
    },
    []
  )

  // Track selection
  const selectStream = useCallback(
    (height: number | null, audioTier: string | null) => {
      const player = playerRef.current
      if (!player) return
      if (height == null && audioTier == null) {
        player.configure({ abr: { enabled: true } } as unknown as shaka.extern.PlayerConfiguration)
        setSelectedHeight(null)
        setSelectedAudioTier(null)
        // Re-enabling ABR hands Shaka the whole variant list again, so the
        // language it is allowed to land on has to be re-stated here too.
        applyAudioSelection(audioLangRef.current, { select: false })
        reconcileAudioSelection()
        return
      }
      const inTier = (track: VariantTrack): boolean => {
        if (audioTier == null) return true
        const bps = track.audioBandwidth ?? 0
        if (audioTier === 'Low') return bps < 96_000
        if (audioTier === 'Medium') return bps >= 96_000 && bps < 192_000
        return bps >= 192_000
      }
      const best = pickVariant(
        player.getVariantTracks(),
        (track) => (height == null || track.height === height) && inTier(track)
      )
      if (!best) return
      player.configure({ abr: { enabled: false } } as unknown as shaka.extern.PlayerConfiguration)
      player.selectVariantTrack(best, true)
      setSelectedHeight(height)
      setSelectedAudioTier(audioTier)
      repinAttemptsRef.current = 0
      applyAudioSelection(audioLangRef.current)
    },
    [applyAudioSelection, pickVariant, reconcileAudioSelection]
  )

  const selectHeight = useCallback(
    (height: number | null) => {
      selectStream(height, selectedAudioTier)
      onOsd?.(`Quality: ${height ? `${height}p` : 'Auto'}`, 'hd')
    },
    [selectStream, selectedAudioTier, onOsd]
  )

  const selectAudioTier = useCallback(
    (tier: string | null) => {
      selectStream(selectedHeight, tier)
      onOsd?.(`Audio: ${tier ?? 'Auto'}`, 'volume')
    },
    [selectStream, selectedHeight, onOsd]
  )

  const selectAudio = useCallback(
    (code: string) => {
      const player = playerRef.current
      if (!player) return
      // Matched by language, not string: the menu hands us a normalized code
      // while the manifest track carries its own spelling (`en-US` vs `en-us`).
      const track = player.getAudioTracks().find((a) => sameLanguage(audioCode(a), code))
      if (!track) return
      // An explicit pick is a fresh decision, so give the drift-correction
      // counter a clean slate.
      repinAttemptsRef.current = 0
      applyAudioSelection(code)
      onOsd?.(`Audio: ${code === 'und' ? 'Original' : languageName(code)}`, 'volume')
    },
    [applyAudioSelection, onOsd]
  )

  const selectCaption = useCallback(
    (id: number | null) => {
      const player = playerRef.current
      if (!player) return
      if (id == null) {
        player.selectTextTrack(null)
        setActiveTextId(null)
        setTextVisible(false)
        onOsd?.('Subtitles: Off', 'captions')
        onCaptionsToggle?.(false)
      } else {
        const track = player.getTextTracks().find((t) => t.id === id)
        if (track) {
          player.selectTextTrack(track)
          setActiveTextId(id)
          setTextVisible(true)
          onOsd?.(`Subtitles: ${track.label || track.language}`, 'captions')
          onCaptionsToggle?.(true)
        }
      }
    },
    [onOsd, onCaptionsToggle]
  )

  const toggleCaptions = useCallback(() => {
    if (textTracks.length === 0) return
    if (textVisible) selectCaption(null)
    else selectCaption(textTracks[0]?.id ?? null)
  }, [textTracks, textVisible, selectCaption])

  // Playback control
  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused || video.ended) {
      void video.play().catch(() => undefined)
      onOsd?.('Play', 'play')
    } else {
      video.pause()
      onOsd?.('Pause', 'pause')
    }
  }, [onOsd, videoRef])

  /**
   * Clamp a requested position to what is actually seekable. For VOD that is
   * `[0, duration]`; for live it is the DVR window, which slides forward
   * constantly — reading it live from the player (rather than from the
   * `liveWindow` state) keeps a click on the seek bar accurate even mid-scrub.
   */
  const clampToSeekable = useCallback(
    (time: number): number => {
      const player = playerRef.current
      if (player && liveRef.current) {
        const range = player.seekRange()
        if (range.end > range.start) {
          return Math.min(Math.max(time, range.start), range.end - 0.5)
        }
      }
      const video = videoRef.current
      return Math.max(0, Math.min(video?.duration || Infinity, time))
    },
    [videoRef]
  )

  const seekTo = useCallback(
    (time: number) => {
      const video = videoRef.current
      if (!video) return
      const target = clampToSeekable(time)
      video.currentTime = target
      setCurrentTime(target)
    },
    [clampToSeekable, videoRef]
  )

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current
      if (!video) return
      const target = clampToSeekable(video.currentTime + delta)
      video.currentTime = target
      setCurrentTime(target)
      onOsd?.(`${delta > 0 ? `+${delta}s` : `${delta}s`}`, delta > 0 ? 'forward' : 'back')
    },
    [clampToSeekable, onOsd, videoRef]
  )

  /**
   * Jump to the live edge. `seekRange().end` is Shaka's *safe* edge (the true
   * edge minus the presentation delay), which is the furthest-forward position
   * that is guaranteed to have media behind it.
   */
  const goToLive = useCallback(() => {
    const video = videoRef.current
    const player = playerRef.current
    if (!video || !player || !liveRef.current) return
    const range = player.seekRange()
    const target = Math.max(range.start, range.end - 2)
    video.currentTime = target
    setCurrentTime(target)
    lastProgressRef.current = { t: target, at: Date.now() }
    onOsd?.('Jumped to live', 'play')
  }, [onOsd, videoRef])

  // Shaka Lifecycle
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let disposed = false

    // A new video starts from its own original dub, not from whatever language
    // the previous one happened to be left on.
    audioLangRef.current = null
    repinAttemptsRef.current = 0
    setSelectedAudioLang(null)
    setAudioTracks([])

    if (!shaka.Player.isBrowserSupported()) {
      setStatus('error')
      setErrorMsg('This system does not support the required media playback APIs.')
      return
    }

    const player = new shaka.Player()
    playerRef.current = player

    // Without a video container Shaka falls back to `NativeTextDisplayer`, which
    // renders captions as <track> children *inside* the <video> element: they land
    // at the very bottom of the frame (buried under our control bar) and cannot be
    // styled from CSS at all. Passing the player root makes Shaka build a
    // `UITextDisplayer` instead, which appends a `.shaka-text-container` div that
    // our stylesheet can position above the controls and restyle per user
    // preference. The trade-off is the standard web-player one: DOM captions do
    // not appear in the Picture-in-Picture window.
    if (containerRef.current) {
      player.setVideoContainer(containerRef.current)
    }

    const recoverPlayback = async (reason: string): Promise<void> => {
      const attempt = recoveryCount.current
      if (disposed || attempt >= 3 || statusRef.current !== 'ready') return
      recoveryCount.current = attempt + 1
      lastRecoveryRef.current = Date.now()
      const resumeAt = video.currentTime
      // A live stream has no fixed position to resume: `load()` without a
      // start time puts us back on the live edge, which is the only sensible
      // landing spot after the stream URLs have been regenerated.
      const startAt =
        !player.isLive() && Number.isFinite(resumeAt) && resumeAt > 0.5 ? resumeAt : undefined
      setBusy(true)
      try {
        if (attempt < 2) {
          setStatusText(attempt === 0 ? 'Connection lost — refreshing stream…' : 'Still failing — trying fresh stream URLs…')
          await window.api.refreshManifest(videoId)
          if (disposed) return
          const sep = manifestUrl.includes('?') ? '&' : '?'
          const reloadStartAt = player.isLive() ? -2 : startAt
          await player.load(`${manifestUrl}${sep}refresh=1`, reloadStartAt)
        } else {
          if (player.isLive()) {
            throw new Error('live stream cannot use progressive fallback')
          }
          setStatusText('Stream keeps failing — trying direct playback…')
          const direct = await window.api.getProgressiveUrl(videoId)
          if (!direct) throw new Error('no progressive stream available')
          if (disposed) return
          await player.load(direct, startAt)
        }
        if (disposed) return
        // `load()` rebuilds Shaka's adaptation set criteria from the player
        // config, which drops any per-load track choice. Re-apply the language
        // the viewer is on (or the original dub) before resuming playback,
        // otherwise recovery silently switches to another language while the
        // audio menu keeps showing the old one as selected.
        reapplyAudioAfterLoad()
        try {
          if (player.isLive()) {
            const seekRange = player.seekRange()
            const liveEdge = Math.max(seekRange.start, seekRange.end - 2)
            video.currentTime = liveEdge
          } else {
            const end = player.seekRange().end || video.duration || 0
            if (Number.isFinite(resumeAt) && resumeAt > 0.5 && (!end || resumeAt < end - 1)) {
              video.currentTime = resumeAt
            }
          }
        } catch {
          /* keep position */
        }
        lastProgressRef.current = { t: video.currentTime, at: Date.now() }
        setBusy(false)
        setStatusText('')
        try {
          await video.play()
        } catch {
          /* user can press play */
        }
        if (
          !disposed &&
          !player.isLive() &&
          Number.isFinite(resumeAt) &&
          resumeAt > 0.5 &&
          Math.abs(video.currentTime - resumeAt) > 3
        ) {
          try {
            video.currentTime = resumeAt
          } catch {
            /* keep playing */
          }
        }
      } catch {
        if (disposed) return
        if (recoveryCount.current >= 3) {
          setBusy(false)
          setStatusText('')
          setErrorMsg(`Playback failed (${reason}). The stream is unreachable right now.`)
          setStatus('error')
        } else {
          setStatusText('Retrying…')
        }
      }
    }
    recoverPlaybackRef.current = recoverPlayback

    const onPlayerError = (event: Event): void => {
      const detail = (event as unknown as { detail?: { message?: string; severity?: number; code?: number } }).detail
      // Shaka raises LOAD_INTERRUPTED for *every* `player.load()` we issue
      // ourselves — our own recovery path, and the initial-retry path below.
      // It means "the load you cancelled lost a race", not "the stream is
      // broken", so surfacing it would flash an error on every successful
      // recovery.
      if (detail?.code === CODE_LOAD_INTERRUPTED) return
      console.error('[player-shaka-error]', detail)
      if ((detail?.severity ?? 2) < 2) {
        if (statusRef.current === 'ready' && !playingRef.current) {
          setBusy(true)
          setStatusText('Buffering…')
        }
        return
      }
      if (
        detail?.code != null &&
        (RECOVERABLE_CODES.has(detail.code) ||
          (liveRef.current && LIVE_RECOVERABLE_CODES.has(detail.code)))
      ) {
        void recoverPlayback(`error ${detail.code}`)
        return
      }
      setBusy(false)
      setStatusText('')
      setErrorMsg(detail?.message ?? 'Playback failed.')
      setStatus('error')
    }
    player.addEventListener('error', onPlayerError)

    let bufferingTimer: ReturnType<typeof setTimeout> | null = null

    const clearBufferingWatchdog = (): void => {
      if (bufferingTimer) {
        clearTimeout(bufferingTimer)
        bufferingTimer = null
      }
    }

    const startBufferingWatchdog = (): void => {
      clearBufferingWatchdog()
      if (disposed || video.paused || scrubbingRef.current) return
      bufferingTimer = setTimeout(() => {
        bufferingTimer = null
        if (disposed || video.paused || scrubbingRef.current) return
        console.warn('[player] buffering stall detected, initiating recovery')
        void recoverPlayback('buffering stall')
      }, 15000)
    }

    const onShakaBuffering = (event: Event): void => {
      const isBuffering = (event as unknown as { buffering?: boolean }).buffering ?? false
      if (disposed || statusRef.current !== 'ready') return
      if (isBuffering) {
        setBusy(true)
        setStatusText((prev) => (prev === '' || prev === 'Buffering…' ? 'Buffering…' : prev))
        startBufferingWatchdog()
      } else {
        clearBufferingWatchdog()
        if (!scrubbingRef.current) {
          setBusy(false)
          setStatusText('')
        }
      }
    }
    player.addEventListener('buffering', onShakaBuffering)
    video.addEventListener('playing', clearBufferingWatchdog)
    video.addEventListener('pause', clearBufferingWatchdog)

    /**
     * Keep the audio menu honest. Shaka can change the playing audio language on
     * its own — the ABR manager re-decides on every quality switch, and a
     * `selectVariantTrack()` repins the preference to whatever variant it was
     * given. Without listening for that, the menu keeps its checkmark on a
     * track that is no longer the one on screen, which is exactly the symptom
     * this replaced: "the original is selected, but a different language plays".
     */
    const onAudioMaybeChanged = (): void => {
      if (!disposed) reconcileAudioSelection()
    }
    player.addEventListener('audiotrackschanged', onAudioMaybeChanged)
    player.addEventListener('adaptation', onAudioMaybeChanged)

    const buildConfig = (forLive: boolean): shaka.extern.PlayerConfiguration =>
      ({
        streaming: {
          rebufferingGoal: 2,
          bufferingGoal: 30,
          bufferBehind: 60,
          returnToEndOfLiveWindowWhenOutside: true,
          retryParameters: {
            maxAttempts: 10,
            baseDelay: 500,
            backoffFactor: 2,
            fuzzFactor: 0.5,
            timeout: 10000
          },
          stallEnabled: true,
          stallThreshold: 5,
          stallSkip: 0.1,
          // `failureCallback` is deliberately not used: it fires for the same
          // critical failures as the `error` event, so wiring recovery to both
          // would make every droppable live segment trigger two concurrent
          // manifest reloads. `onPlayerError` is the single recovery entry point.
          ...(forLive ? buildLiveStreamingConfig() : {})
        },
        manifest: {
          retryParameters: {
            maxAttempts: 4,
            baseDelay: 300,
            backoffFactor: 2,
            fuzzFactor: 0.5,
            timeout: 15000
          },
          // A live playlist is re-requested forever, so one bad response must
          // not be escalated into a fatal manifest error.
          ...(forLive ? { raiseFatalErrorOnManifestUpdateRequestFailure: false } : {}),
          ...(forLive ? LIVE_MANIFEST_CONFIG : {})
        },
        abr: { enabled: true },
        /**
         * Declared *before* `load()` on purpose. Shaka seeds its adaptation set
         * criteria from this and uses it for the very first variant decision,
         * so the original dub is in place from the first frame rather than
         * being patched in afterwards — which is what used to let whichever
         * language the manifest happened to list first win the opening
         * moments, and is the "sometimes" in this bug.
         *
         * The `role: ''` / `channelCount: 0` / `label: ''` fields matter: they
         * mean "any rendition within this language", leaving Shaka free to
         * pick the best audio bitrate for the bandwidth available.
         */
        preferredAudio: [
          {
            language: normLang(defaultLangRef.current),
            role: '',
            label: '',
            channelCount: 0,
            spatialAudio: false
          }
        ]
      }) as unknown as shaka.extern.PlayerConfiguration

    const config = buildConfig(isLive)

    let proxyBase = ''
    try {
      proxyBase = new URL(manifestUrl).origin
    } catch {
      /* ignore */
    }

    const requestFilter: shaka.extern.RequestFilter = (_type, request) => {
      if (!proxyBase) return
      request.uris = request.uris.map((uri) => {
        if (
          (uri.includes('.googlevideo.com') || uri.includes('.youtube.com')) &&
          !uri.startsWith(proxyBase)
        ) {
          const isSegment =
            uri.includes('/sq/') ||
            uri.includes('/file/seg.ts') ||
            uri.includes('/seg.ts') ||
            uri.includes('/govp/') ||
            uri.includes('/goap/')
          const isAudio = isAudioItagUrl(uri)
          const ext =
            uri.includes('.m3u8') && !isSegment
              ? '.m3u8'
              : isAudio
                ? '.aac'
                : uri.includes('.ts') || uri.includes('/seg.ts') || uri.includes('/sq/') || uri.includes('/govp/')
                  ? '.ts'
                  : ''
          return `${proxyBase}/media${ext}?u=${encodeURIComponent(uri)}`
        }
        return uri
      })
    }
    player.getNetworkingEngine()?.registerRequestFilter(requestFilter)

    const responseFilter: shaka.extern.ResponseFilter = (type, response) => {
      const rangeHeader =
        response.originalRequest?.headers?.['Range'] ||
        response.originalRequest?.headers?.['range']
      if (!rangeHeader) return

      const range = rangeHeader
        .replace('bytes=', '')
        .split('-')
        .filter(Boolean)
        .map((r) => parseInt(r, 10))
      if (range.length !== 2 || Number.isNaN(range[0]) || Number.isNaN(range[1])) return

      const expectedLength = range[1] - range[0] + 1
      const data = response.data
      const currentLength =
        data instanceof ArrayBuffer
          ? data.byteLength
          : ArrayBuffer.isView(data)
            ? data.byteLength
            : 0

      if (currentLength === expectedLength) return

      // If upstream returned full content or larger buffer, slice it down to the requested range
      if (currentLength > expectedLength) {
        if (data instanceof ArrayBuffer) {
          if (data.byteLength >= range[1] + 1) {
            response.data = data.slice(range[0], range[1] + 1)
            response.status = 206
            return
          } else if (data.byteLength >= expectedLength) {
            response.data = data.slice(0, expectedLength)
            response.status = 206
            return
          }
        } else if (ArrayBuffer.isView(data)) {
          if (data.byteLength >= range[1] + 1) {
            response.data = new Uint8Array(
              data.buffer,
              data.byteOffset + range[0],
              expectedLength
            )
            response.status = 206
            return
          } else if (data.byteLength >= expectedLength) {
            response.data = new Uint8Array(
              data.buffer,
              data.byteOffset,
              expectedLength
            )
            response.status = 206
            return
          }
        }
      }

      // If response payload is truncated (less than requested range), signal a recoverable error to trigger a clean retry
      throw new shaka.util.Error(
        shaka.util.Error.Severity.RECOVERABLE,
        shaka.util.Error.Category.NETWORK,
        shaka.util.Error.Code.BAD_HTTP_STATUS,
        response.uri,
        response.status,
        response.headers,
        type
      )
    }
    player.getNetworkingEngine()?.registerResponseFilter(responseFilter)

    void (async () => {
      try {
        // Starting 2 seconds behind the live edge ensures buffered media is
        // immediately available to decode without stalling.
        const mountStartAt =
          !isLive && Number.isFinite(startPosition) && startPosition > 0.5
            ? startPosition
            : isLive
              ? -2
              : undefined
        await player.attach(video)
        player.configure(config)
        await player.load(manifestUrl, mountStartAt)
        if (disposed) return

        // The hint can be wrong (a replayed broadcast is served as a live
        // playlist for a while, and vice versa), so trust Shaka from here on.
        const isLiveStream = player.isLive()
        if (isLiveStream !== liveRef.current) {
          liveRef.current = isLiveStream
          setLive(isLiveStream)
        }
        if (isLiveStream && !isLive) {
          // The manifest is already parsed, so the parse-time settings above are
          // locked in; only the live-adjustable streaming knobs can still be
          // applied. Retrying the load would be far more disruptive than the
          // difference between the VOD and live buffer goals.
          player.configure({ streaming: buildLiveStreamingConfig() } as unknown as shaka.extern.PlayerConfiguration)
        }

        const tracks = player.getVariantTracks()
        setVariantTracks(tracks)

        const audio = player.getAudioTracks()
        setAudioTracks(audio)
        if (audio.length > 0) {
          // `preferredAudio` in the pre-load config has already steered the
          // first variant decision; this resolves the language we actually want
          // against the tracks this manifest really offers (the MPD code may be
          // a looser match than the player response suggested) and records it so
          // a later reload can restore it.
          const original = resolveOriginalTrack(audio, defaultLangRef.current)
          if (original) {
            repinAttemptsRef.current = 0
            applyAudioSelection(normLang(audioCode(original)))
          }
        }

        for (const caption of captions) {
          try {
            await player.addTextTrackAsync(
              caption.url,
              caption.languageCode,
              'subtitles',
              'text/vtt',
              undefined,
              caption.name
            )
          } catch {
            /* ignore individual failure */
          }
        }
        if (disposed) return
        const added = player.getTextTracks()
        setTextTracks(added)

        if (alwaysShowCaptions && added.length > 0) {
          const first = added[0]
          player.selectTextTrack(first)
          setActiveTextId(first.id)
          setTextVisible(true)
        }

        video.preservesPitch = preservePitch
        video.playbackRate = safeInitialSpeed
        video.volume = Math.min(1, Math.max(0, initialVolume))

        const dur = video.duration
        if (isLiveStream) {
          // `video.duration` is `Infinity` while live and `seekRange().end` is an
          // ever-growing presentation timestamp, so neither is a duration. The
          // DVR window length is only meaningful for the live UI, which reads
          // `liveWindow` directly.
          setDuration(0)
        } else if (Number.isFinite(dur) && dur > 0) {
          setDuration(dur)
        }

        /**
         * Pinning a quality hands Shaka one specific variant, and Shaka copies
         * that variant's audio language into the adaptation set criteria. Picking
         * inside the language we already selected keeps that from repinning the
         * player onto a dub; if nothing matches, the viewer's explicit quality
         * still wins and the audio is re-applied straight afterwards.
         */
        const pinQuality = (best: VariantTrack | undefined): void => {
          if (!best) return
          player.configure({ abr: { enabled: false } } as unknown as shaka.extern.PlayerConfiguration)
          player.selectVariantTrack(best, true)
          setSelectedHeight(best.height)
          // `selectVariantTrack()` has just repinned the criteria to `best`'s
          // language, so restate ours. Cheap and idempotent when they agree.
          repinAttemptsRef.current = 0
          applyAudioSelection(audioLangRef.current)
        }

        if (preferredQuality === 'max') {
          pinQuality(
            pickVariant(
              tracks.filter((t) => t.height != null),
              undefined,
              (a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth
            )
          )
        } else if (
          preferredQuality !== 'auto' &&
          tracks.some((t) => t.height === Number(preferredQuality))
        ) {
          pinQuality(
            pickVariant(tracks, (t) => t.height === Number(preferredQuality))
          )
        }

        if (isLiveStream) {
          // The DVR window slides forward on every playlist poll, so a position
          // from history is either outside the window or points at a different
          // moment of the broadcast. Either way the only useful landing spot is
          // the live edge; `goToLive` exists for the viewer to come back.
          const range = player.seekRange()
          const liveEdge = Math.max(range.start, range.end - 2)
          if (Math.abs(video.currentTime - liveEdge) > 2) {
            try {
              video.currentTime = liveEdge
            } catch {
              /* the playhead is already inside the window */
            }
          }
          setCurrentTime(liveEdge)
          setLiveWindow(range)
        } else if (
          startPosition > 0.5 &&
          (!dur || (startPosition < dur - 5 && startPosition / dur < 0.95))
        ) {
          setCurrentTime(startPosition)
          if (Math.abs(video.currentTime - startPosition) > 2) {
            try {
              video.currentTime = startPosition
            } catch {
              /* keep */
            }
          }
        }

        setStatus('ready')
        setBusy(false)
        setStatusText('')
        lastProgressRef.current = { t: video.currentTime, at: Date.now() }
        if (autoplay) {
          try {
            await video.play()
          } catch {
            /* autoplay rejected */
          }
        }
      } catch (err) {
        if (disposed) return
        setStatusText('Stream failed to start — retrying with fresh URLs…')
        try {
          await window.api.refreshManifest(videoId)
          if (disposed) return
          const sep = manifestUrl.includes('?') ? '&' : '?'
          const retryStartAt =
            !isLive && Number.isFinite(startPosition) && startPosition > 0.5
              ? startPosition
              : isLive
                ? -2
                : undefined
          await player.load(`${manifestUrl}${sep}refresh=1`, retryStartAt)
          if (disposed) return
          // Same as recovery: the retry is a fresh manifest, so the original
          // dub has to be named again before playback starts.
          reapplyAudioAfterLoad()
          if (player.isLive()) {
            const seekRange = player.seekRange()
            const liveEdge = Math.max(seekRange.start, seekRange.end - 2)
            video.currentTime = liveEdge
            setCurrentTime(liveEdge)
            setLiveWindow(seekRange)
            setDuration(0)
            liveRef.current = true
            setLive(true)
          } else if (startPosition > 0.5) {
            try {
              video.currentTime = startPosition
              setCurrentTime(startPosition)
            } catch {
              /* keep */
            }
          }
          setStatus('ready')
          setBusy(false)
          setStatusText('')
          lastProgressRef.current = { t: video.currentTime, at: Date.now() }
          if (autoplay) {
            try {
              await video.play()
            } catch {
              /* rejected */
            }
          }
          return
        } catch {
          /* error */
        }
        if (disposed) return
        setBusy(false)
        setStatusText('')
        setStatus('error')
        setErrorMsg(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      disposed = true
      clearBufferingWatchdog()
      video.removeEventListener('playing', clearBufferingWatchdog)
      video.removeEventListener('pause', clearBufferingWatchdog)
      recoverPlaybackRef.current = null
      player.removeEventListener('error', onPlayerError)
      player.removeEventListener('buffering', onShakaBuffering)
      player.removeEventListener('audiotrackschanged', onAudioMaybeChanged)
      player.removeEventListener('adaptation', onAudioMaybeChanged)
      player.getNetworkingEngine()?.unregisterRequestFilter(requestFilter)
      player.getNetworkingEngine()?.unregisterResponseFilter(responseFilter)
      playerRef.current = null
      void player.destroy().catch(() => undefined)
    }
    // The three audio callbacks are referentially stable (each depends only on
    // refs and stable setters), so listing them does not re-create the player.
  }, [
    containerRef,
    videoId,
    manifestUrl,
    applyAudioSelection,
    reapplyAudioAfterLoad,
    reconcileAudioSelection
  ])

  /**
   * Track the live window while a stream is playing. The DVR window slides
   * forward on every playlist poll, so it has to be re-read on a timer rather
   * than captured once at load — the seek bar maps positions against it and the
   * "behind live" badge is measured from it. 500 ms keeps the badge from
   * visibly stuttering between `timeupdate` ticks.
   */
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => {
      const player = playerRef.current
      const video = videoRef.current
      if (!player || !video) return
      const range = player.seekRange()
      if (range.end <= range.start) return
      setLiveWindow(range)
      // The window slid past the playhead (paused too long, a long stall, or a
      // rate change). `returnToEndOfLiveWindowWhenOutside` normally handles
      // this, but it only nudges the playhead forward — it does not resync the
      // clock when the position has already aged out, so do it explicitly.
      if (video.currentTime < range.start - 0.5) {
        const liveEdge = Math.max(range.start, range.end - 2)
        video.currentTime = liveEdge
        setCurrentTime(liveEdge)
        lastProgressRef.current = { t: liveEdge, at: Date.now() }
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [live])

  // Watchdog
  useEffect(() => {
    const id = window.setInterval(() => {
      const video = videoRef.current
      if (!video || statusRef.current !== 'ready') return
      if (document.hidden || scrubbingRef.current) {
        lastProgressRef.current = { t: video.currentTime, at: Date.now() }
        return
      }
      if (video.paused && !video.seeking) {
        lastProgressRef.current = { t: video.currentTime, at: Date.now() }
        return
      }
      const now = Date.now()
      const lp = lastProgressRef.current
      const deltaT = Math.abs(video.currentTime - lp.t)
      const elapsedMs = now - lp.at
      if (deltaT > 0.2) {
        lastProgressRef.current = { t: video.currentTime, at: now }
        return
      }
      if (elapsedMs < 12_000) return
      if (now - lastRecoveryRef.current < 15_000) return
      void recoverPlaybackRef.current?.(`stall: frozen at ${video.currentTime.toFixed(1)}s for ${(elapsedMs / 1000).toFixed(0)}s`)
    }, 2000)
    return () => window.clearInterval(id)
  }, [videoId, manifestUrl, scrubbingRef, videoRef])

  // Video listeners
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const collectBuffered = (): void => {
      const ranges: [number, number][] = []
      for (let i = 0; i < video.buffered.length; i++) {
        ranges.push([video.buffered.start(i), video.buffered.end(i)])
      }
      setBuffered(ranges)
    }

    const onTime = (): void => {
      setCurrentTime(video.currentTime)
      const dur = video.duration
      if (Number.isFinite(dur) && dur > 0 && Math.abs(dur - lastDurationRef.current) > 0.5) {
        lastDurationRef.current = dur
        setDuration(dur)
      }
      maybeSkip(video.currentTime)
      if (statusRef.current === 'ready' && !scrubbingRef.current && !video.seeking && (video.readyState >= 3 || !video.paused)) {
        setBusy(false)
        setStatusText('')
      }
      const now = Date.now()
      // A live position is a timestamp on a timeline that keeps moving, so there
      // is nothing meaningful to hand upwards: resuming "where I left off" on a
      // broadcast that is still running would land in the wrong place. Skipping
      // the report also keeps `Infinity` — what `video.duration` reports while
      // live — out of the history and media-session writers.
      if (liveRef.current) return
      if (now - lastReportRef.current > 2000) {
        lastReportRef.current = now
        onTimeUpdateRef.current(video.currentTime, video.duration || 0)
      }
    }
    const onPlay = (): void => {
      setPlaying(true)
      if (statusRef.current === 'ready' && (video.readyState >= 3 || !video.seeking)) {
        setBusy(false)
        setStatusText('')
      }
    }
    const onPause = (): void => {
      setPlaying(false)
      if (!liveRef.current && video.currentTime > 0) {
        lastReportRef.current = Date.now()
        onTimeUpdateRef.current(video.currentTime, video.duration || 0)
      }
      if (statusRef.current === 'ready' && !video.seeking) {
        setBusy(false)
        setStatusText('')
      }
    }
    const onWaiting = (): void => {
      if (statusRef.current === 'ready' && !scrubbingRef.current) {
        setBusy(true)
        setStatusText('Buffering…')
      }
    }
    const onPlaying = (): void => {
      if (statusRef.current === 'ready') {
        setBusy(false)
        setStatusText('')
      }
    }
    const onSeeking = (): void => {
      if (statusRef.current === 'ready' && !scrubbingRef.current) {
        setBusy(true)
        setStatusText('Seeking…')
      }
    }
    const onSeeked = (): void => {
      if (statusRef.current === 'ready' && !scrubbingRef.current) {
        setBusy(false)
        setStatusText('')
      }
    }
    const handleEnded = (): void => {
      setPlaying(false)
      setBusy(false)
      setStatusText('')
      onEndedRef.current()
    }

    video.addEventListener('timeupdate', onTime)
    video.addEventListener('progress', collectBuffered)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('seeking', onSeeking)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('ended', handleEnded)

    return () => {
      if (!liveRef.current && video.currentTime > 0) {
        onTimeUpdateRef.current(video.currentTime, video.duration || 0)
      }
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('progress', collectBuffered)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('ended', handleEnded)
    }
  }, [maybeSkip, scrubbingRef, videoRef])

  // Seconds behind the live edge, and whether that is close enough to still
  // read as "live". Derived rather than stored so it tracks `currentTime` at
  // `timeupdate` rate without a second timer.
  const behindLive = live && liveWindow ? Math.max(0, liveWindow.end - currentTime) : 0

  return {
    playerRef,
    status,
    errorMsg,
    busy,
    statusText,
    playing,
    currentTime,
    duration,
    buffered,
    live,
    liveWindow,
    behindLive,
    atLiveEdge: live && behindLive <= LIVE_EDGE_TOLERANCE,
    goToLive,
    variantTracks,
    selectedHeight,
    selectedAudioTier,
    audioTracks,
    selectedAudioLang,
    textTracks,
    activeTextId,
    textVisible,
    audioLanguages,
    audioTiers,
    levelHeights,
    isOriginalLanguage,
    selectStream,
    selectHeight,
    selectAudioTier,
    selectAudio,
    selectCaption,
    togglePlay,
    toggleCaptions,
    seekTo,
    seekBy
  }
}
