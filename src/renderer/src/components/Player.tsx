import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import shaka from 'shaka-player'
import { Icon } from './Icons'
import { Menu, MenuItem } from './Menu'
import { SliderField } from './SliderField'
import { Switch } from './Switch'
import { useMediaSession } from '../lib/mediaSession'
import {
  SILENCE_SKIP_MULTIPLIER,
  createSilenceSkipper,
  type SilenceSkipper
} from '../lib/silenceSkipper'
import {
  SPONSOR_CATEGORY_COLORS,
  sponsorCategoryLabel,
  type CaptionTrack,
  type Chapter,
  type Settings,
  type SponsorSegment
} from '../../../shared/types'
import {
  isAudioItagUrl,
  languageName,
  PLAYBACK_SPEEDS as SPEEDS
} from '../../../shared/media'
import { formatTime as fmt } from '../lib/format'

export interface PlayerHandle {
  seekTo: (time: number) => void
  unskip: (segment: SponsorSegment) => void
  play: () => void
  pause: () => void
  seekBy: (delta: number) => void
  /** Jump to the next chapter. */
  nextChapter: () => void
  /** Jump to the start of the current (or the previous) chapter. */
  previousChapter: () => void
}

/* ---- Keyboard shortcut targeting ------------------------------------------ */

/** Chromium reports a single space, but legacy/IME paths have used these. */
const SPACE_KEYS = new Set([' ', 'Spacebar', 'Space'])
const isSpaceKey = (event: KeyboardEvent): boolean =>
  SPACE_KEYS.has(event.key) || event.code === 'Space'

const TYPING_TAGS = new Set(['TEXTAREA', 'SELECT'])
const ACTIVATABLE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY'])

/**
 * Input types that never accept free text. The player's own sliders are
 * `<input type="range">`, and treating those as "typing" would kill every
 * shortcut as soon as someone touched the volume or quality slider.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit'
])

/** True only for fields the user is actually typing into. */
const isTypingTarget = (el: Element): boolean => {
  if (TYPING_TAGS.has(el.tagName)) return true
  if ((el as HTMLElement).isContentEditable) return true
  if (el.tagName !== 'INPUT') return false
  const type = (el as HTMLInputElement).type?.toLowerCase() ?? 'text'
  return !NON_TEXT_INPUT_TYPES.has(type)
}

/** Controls that the browser itself activates with Space. */
const isActivatable = (el: Element): boolean =>
  ACTIVATABLE_TAGS.has(el.tagName) || el.getAttribute('role') === 'button'

/** Metadata surfaced to the OS media session (Windows SMTC flyout). */
interface MediaSessionMeta {
  title: string
  artist: string
  album?: string
  artwork?: string | null
  /** Skips chapter navigation for the media keys and uses the queue instead. */
  onNextTrack?: () => void
  onPreviousTrack?: () => void
}

interface PlayerProps {
  videoId: string
  manifestUrl: string
  poster?: string
  captions: CaptionTrack[]
  chapters?: Chapter[]
  startPosition: number
  autoplay: boolean
  segments: SponsorSegment[]
  autoSkip: boolean
  sponsorBlockEnabled: boolean
  alwaysShowCaptions: boolean
  initialVolume: number
  initialSpeed: number
  preferredQuality: Settings['preferredQuality']
  preservePitch: boolean
  skipSilence: boolean
  /**
   * Language of the video's original audio track (main-process resolved from
   * the player response's `audioIsDefault`/`is_original` markers — the same
   * sources NewPipe uses). Used to pick the original dub by default.
   */
  defaultAudioLanguage: string | null
  onPitchChange: (value: boolean) => void
  onSkipSilenceChange: (value: boolean) => void
  onTimeUpdate: (position: number, duration: number) => void
  onEnded: () => void
  onSkipped: (segment: SponsorSegment) => void
  /** Optional OS media-session metadata; omit to hide the Windows "now playing" card. */
  mediaSession?: MediaSessionMeta | null
}

type VariantTrack = ReturnType<shaka.Player['getVariantTracks']>[number]
type TextTrack = ReturnType<shaka.Player['getTextTracks']>[number]
type AudioTrack = ReturnType<shaka.Player['getAudioTracks']>[number]

type MenuKind = 'quality' | 'captions' | 'audio' | 'settings'

// Skip-silence itself lives in public/silence-skipping-worklet.js: a port of Media3's
// SilenceSkippingAudioProcessor (what NewPipe and LibreTube Android enable via
// ExoPlayer's skipSilenceEnabled). The worklet gates the audio and reports when it is
// safe to change the media rate; the rate ramp itself is driven from
// lib/silenceSkipper.ts. See the comment there for why time can only be saved by
// touching video.playbackRate in a Web Audio renderer.

/** Fallback for a category SponsorBlock adds that we have no colour for. */
const SPONSOR_COLOR_FALLBACK = '#2ba640'

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))
const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))
const clampVolume = (n: number): number => clamp(n, 0, 3)

/**
 * Language code of an audio track, normalised. 'und' (undefined) means the
 * manifest's original audio. Selection is tracked by code because Shaka does
 * not guarantee stable numeric ids (AudioTrack.id is optional and usually
 * undefined), which made id-based selection silently do nothing.
 */
function audioCode(track: AudioTrack): string {
  return (track.language ?? '').trim() || 'und'
}

/**
 * The SponsorBlock markers drawn over the seek bar.
 *
 * Extracted because the identical block was inlined twice — once for the
 * chapter-segmented track and once for the plain track — and the two copies had
 * already started to drift. `.seek__sponsor` is absolutely positioned and both
 * `.seek__track` and `.seek__chapters` are the containing block, so the same
 * wrapper works for both without any special casing.
 */
function SponsorLayer({
  segments,
  duration
}: {
  segments: SponsorSegment[]
  duration: number
}): React.JSX.Element | null {
  if (duration <= 0 || segments.length === 0) return null
  return (
    <div className="seek__sponsor-layer" aria-hidden="true">
      {segments.map((seg) => {
        const left = clamp01(seg.segment[0] / duration) * 100
        // A sub-second segment still needs to be visible on the bar.
        const width = clamp01((seg.segment[1] - seg.segment[0]) / duration) * 100
        return (
          <div
            key={seg.uuid}
            className="seek__sponsor"
            style={{
              left: `${left}%`,
              width: `${Math.max(0.4, width)}%`,
              background: SPONSOR_CATEGORY_COLORS[seg.category] ?? SPONSOR_COLOR_FALLBACK
            }}
            title={sponsorCategoryLabel(seg.category)}
          />
        )
      })}
    </div>
  )
}

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(props, ref): React.JSX.Element {
  const {
    videoId,
    manifestUrl,
    captions,
    poster,
    startPosition,
    autoplay,
    segments,
    autoSkip,
    sponsorBlockEnabled,
    alwaysShowCaptions,
    initialVolume,
    initialSpeed = 1,
    preferredQuality,
    preservePitch,
    skipSilence,
    defaultAudioLanguage,
    chapters = [],
    onPitchChange,
    onSkipSilenceChange
  } = props

  const safeInitialSpeed = Number.isFinite(initialSpeed) && initialSpeed >= 0.25 ? initialSpeed : 1

  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<shaka.Player | null>(null)
  const skipRef = useRef<Map<string, 'skipped' | 'unskipped'>>(new Map())
  const hideTimerRef = useRef<number | null>(null)
  const lastReportRef = useRef(0)
  const scrubTimeRef = useRef(0)
  const clickTimerRef = useRef<number | null>(null)

  // Latest-value refs so the (mount-only) media listeners never go stale.
  const segmentsRef = useRef(segments)
  const autoSkipRef = useRef(autoSkip)
  const enabledRef = useRef(sponsorBlockEnabled)
  const onTimeUpdateRef = useRef(props.onTimeUpdate)
  const onEndedRef = useRef(props.onEnded)
  const onSkippedRef = useRef(props.onSkipped)
  const menuRef = useRef<string | null>(null)
  const audioLangRef = useRef<string | null>(null)
  segmentsRef.current = segments
  autoSkipRef.current = autoSkip
  enabledRef.current = sponsorBlockEnabled
  onTimeUpdateRef.current = props.onTimeUpdate
  onEndedRef.current = props.onEnded
  onSkippedRef.current = props.onSkipped

  // Audio graph refs for volume booster (up to 300%) & silence skipping
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const limiterRef = useRef<DynamicsCompressorNode | null>(null)
  const skipperRef = useRef<SilenceSkipper | null>(null)
  const skipperPendingRef = useRef(false)
  const skipperEnabledRef = useRef(false)
  const boostRef = useRef(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [subtitlesBottom, setSubtitlesBottom] = useState(118)
  const rateRef = useRef(safeInitialSpeed)
  const pitchRef = useRef(preservePitch)
  const skipSilenceRef = useRef(skipSilence)
  pitchRef.current = preservePitch
  skipSilenceRef.current = skipSilence

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState<[number, number][]>([])
  // ---- OS media session (Windows SMTC) --------------------------------------
  // The Player owns the <video> element and the transport controls, so the
  // media session is wired up here rather than in WatchPage. The transport
  // callbacks are declared further down; refs bridge the two.
  const seekToRef = useRef<(time: number) => void>(() => undefined)
  const seekByRef = useRef<(delta: number) => void>(() => undefined)
  const seekToPreviousChapterRef = useRef<() => void>(() => undefined)
  const seekToNextChapterRef = useRef<() => void>(() => undefined)
  const media = props.mediaSession
  useMediaSession(
    {
      title: media?.title ?? props.videoId,
      artist: media?.artist ?? '',
      album: media?.album,
      artwork: media?.artwork ?? props.poster ?? null,
      playing,
      position: currentTime,
      duration,
      active: Boolean(media) && status === 'ready'
    },
    {
      play: () => videoRef.current?.play().catch(() => undefined),
      pause: () => videoRef.current?.pause(),
      seekBackward: (seconds) => seekByRef.current(-seconds),
      seekForward: (seconds) => seekByRef.current(seconds),
      seekTo: (time) => seekToRef.current(time),
      previous: media?.onPreviousTrack
        ? media.onPreviousTrack
        : () => seekToPreviousChapterRef.current(),
      next: media?.onNextTrack ? media.onNextTrack : () => seekToNextChapterRef.current()
    }
  )
  const [volume, setVolume] = useState(initialVolume)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(safeInitialSpeed)
  const [variantTracks, setVariantTracks] = useState<VariantTrack[]>([])
  const [selectedHeight, setSelectedHeight] = useState<number | null>(null)
  const [selectedAudioTier, setSelectedAudioTier] = useState<string | null>(null)
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([])
  const [selectedAudioLang, setSelectedAudioLang] = useState<string | null>(null)
  const [textTracks, setTextTracks] = useState<TextTrack[]>([])
  const [activeTextId, setActiveTextId] = useState<number | null>(null)
  const [textVisible, setTextVisible] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [menu, setMenu] = useState<MenuKind | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubTime, setScrubTime] = useState(0)
  // Target time of a completed seek — held until the video confirms it.
  const [seekTarget, setSeekTarget] = useState<number | null>(null)
  const [posterVisible, setPosterVisible] = useState(true)
  // Non-fatal playback activity shown in the center overlay (buffering,
  // seeking, recovering…). Separate from `status` so transient states never
  // tear the player down — the user always sees what the player is doing.
  const [busy, setBusy] = useState(true)
  const [statusText, setStatusText] = useState('Loading video…')
  // Mutable mirrors so interval / event callbacks always see fresh values.
  const statusRef = useRef(status)
  statusRef.current = status
  const playingRef = useRef(playing)
  playingRef.current = playing
  const scrubbingRef = useRef(scrubbing)
  scrubbingRef.current = scrubbing
  // Stall watchdog + recovery ladder bookkeeping.
  const recoveryCount = useRef(0)
  const lastRecoveryRef = useRef(0)
  const lastProgressRef = useRef({ t: 0, at: Date.now() })
  const recoverPlaybackRef = useRef<((reason: string) => Promise<void>) | null>(null)
  const defaultLangRef = useRef(defaultAudioLanguage)
  defaultLangRef.current = defaultAudioLanguage
  rateRef.current = Number.isFinite(rate) && rate >= 0.25 ? rate : 1

  menuRef.current = menu

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

  /**
   * Audio quality tiers actually present in the manifest — at most Low, Medium
   * and High. Bucketing by range (instead of exact bitrate) avoids showing the
   * same label several times when bitrates differ slightly.
   */
  const audioTiers = useMemo(() => {
    const tierOf = (bps: number): string =>
      bps < 96_000 ? 'Low' : bps < 192_000 ? 'Medium' : 'High'
    const present = new Set<string>()
    for (const track of variantTracks) {
      if (track.audioBandwidth) present.add(tierOf(track.audioBandwidth))
    }
    return (['High', 'Medium', 'Low'] as const).filter((tier) => present.has(tier))
  }, [variantTracks])

  /**
   * Shaka reports one audio track per AdaptationSet, so the same language can show
   * up several times (once per bitrate). Collapse them into one entry per language.
   */
  const audioLanguages = useMemo(() => {
    const seen = new Set<string>()
    const unique: { code: string; label: string }[] = []
    for (const track of audioTracks) {
      const code = audioCode(track)
      if (seen.has(code)) continue
      seen.add(code)
      unique.push({
        code,
        label: code === 'und' ? 'Original' : languageName(code)
      })
    }
    return unique
  }, [audioTracks])

  /**
   * Whether a language code is the video's original audio (resolved by main
   * from YouTube's default-track marker). Used for the 'original' hint in the
   * audio menu — exact match first, then primary-subtag match (en-US ≈ en).
   */
  const isOriginalLanguage = useCallback(
    (code: string): boolean => {
      const wanted = (defaultAudioLanguage ?? '').toLowerCase()
      if (wanted === '') return false
      const prime = (s: string): string => s.split('-')[0].split('_')[0].split('.')[0]
      return code === wanted || prime(code) === prime(wanted)
    },
    [defaultAudioLanguage]
  )

  const maybeSkip = useCallback((time: number) => {
    if (!enabledRef.current || !autoSkipRef.current) return
    for (const seg of segmentsRef.current) {
      if (skipRef.current.has(seg.uuid)) continue
      const [start, end] = seg.segment
      if (time >= start - 0.2 && time < end - 0.5) {
        skipRef.current.set(seg.uuid, 'skipped')
        const video = videoRef.current
        if (video) video.currentTime = end + 0.01
        onSkippedRef.current(seg)
        return
      }
    }
  }, [])

  // ---- Shaka lifecycle (mount only — component is keyed by videoId) ----------
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let disposed = false

    if (!shaka.Player.isBrowserSupported()) {
      setStatus('error')
      setErrorMsg('This system does not support the required media playback APIs.')
      return
    }

    const player = new shaka.Player()
    playerRef.current = player
    // Recovery ladder for fatal streaming failures. transient Shaka errors are
    // retried by Shaka itself, but 1001 (BAD_HTTP_STATUS, e.g. an expired
    // googlevideo URL after a long session) and 1003 (TIMEOUT, e.g. a stalled
    // upstream fetch) need fresh stream URLs. Attempts, in order:
    //   1-2. fresh DASH manifest from main, resume in place;
    //   3.   direct progressive stream (muxed, lower quality) as a last resort;
    //   4.   give up and show the error overlay.
    // `recoveryCount` lives in a ref so the error listener, the watchdog and
    // the mount effect all share one attempt budget per video.
    const recoverPlayback = async (reason: string): Promise<void> => {
      const attempt = recoveryCount.current
      if (disposed || attempt >= 3 || statusRef.current !== 'ready') return
      recoveryCount.current = attempt + 1
      lastRecoveryRef.current = Date.now()
      const resumeAt = video.currentTime
      setBusy(true)
      // Shaka's load() accepts a start time — pass the resume position so a
      // mid-video recovery NEVER restarts at 0 (the "seek sends me back to the
      // start" bug was a load-without-startTime plus a too-early manual seek).
      const startAt =
        Number.isFinite(resumeAt) && resumeAt > 0.5 ? resumeAt : undefined
      try {
        if (attempt < 2) {
          setStatusText(attempt === 0 ? 'Connection lost — refreshing stream…' : 'Still failing — trying fresh stream URLs…')
          await window.api.refreshManifest(videoId)
          if (disposed) return
          const sep = manifestUrl.includes('?') ? '&' : '?'
          await player.load(`${manifestUrl}${sep}refresh=1`, startAt)
        } else {
          // Last resort: a direct progressive stream. Lower quality than the
          // adaptive DASH renditions, but a single file that always plays.
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
          /* keep whatever position the reload landed on */
        }
        lastProgressRef.current = { t: video.currentTime, at: Date.now() }
        setBusy(false)
        setStatusText('')
        try {
          await video.play()
        } catch {
          /* the user can press play */
        }
        // Belt-and-braces: if the reload landed at the start despite startAt,
        // seek back to the resume position instead of playing from 0 (non-live only).
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
            /* keep playing where it landed */
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
          // A later trigger (error event or watchdog) may still use the
          // remaining attempts; keep the busy indicator honest meanwhile.
          setStatusText('Retrying…')
        }
      }
    }
    recoverPlaybackRef.current = recoverPlayback
    const onPlayerError = (event: Event): void => {
      const detail = (event as unknown as { detail?: { message?: string; severity?: number; code?: number; category?: number; data?: unknown } }).detail
      console.error('[player-shaka-error]', detail)
      if ((detail?.severity ?? 2) < 2) {
        if (statusRef.current === 'ready' && !playingRef.current) {
          setBusy(true)
          setStatusText('Buffering…')
        }
        return
      }
      if (detail?.code === 1001 || detail?.code === 1003) {
        void recoverPlayback(`error ${detail.code}`)
        return
      }
      setBusy(false)
      setStatusText('')
      setErrorMsg(detail?.message ?? 'Playback failed.')
      setStatus('error')
    }
    player.addEventListener('error', onPlayerError)
    const onShakaBuffering = (event: Event): void => {
      const buffering = (event as unknown as { buffering?: boolean }).buffering ?? false
      if (disposed || statusRef.current !== 'ready') return
      if (buffering) {
        setBusy(true)
        setStatusText((prev) => (prev === '' || prev === 'Buffering…' ? 'Buffering…' : prev))
      } else if (!scrubbingRef.current) {
        setBusy(false)
        setStatusText('')
      }
    }
    player.addEventListener('buffering', onShakaBuffering)

    const config = {
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
        stallSkip: 0.1
      },
      manifest: {
        retryParameters: {
          maxAttempts: 4,
          baseDelay: 300,
          backoffFactor: 2,
          fuzzFactor: 0.5,
          timeout: 15000
        }
      },
      abr: { enabled: true }
    } as unknown as shaka.extern.PlayerConfiguration

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
          const isAudio = isAudioItagUrl(uri)
          const ext = uri.includes('.m3u8')
            ? '.m3u8'
            : isAudio
              ? '.aac'
              : uri.includes('.ts') || uri.includes('/seg.ts') || uri.includes('/sq/')
                ? '.ts'
                : ''
          return `${proxyBase}/media${ext}?u=${encodeURIComponent(uri)}`
        }
        return uri
      })
    }
    player.getNetworkingEngine()?.registerRequestFilter(requestFilter)

    void (async () => {
      try {
        // Pass the resume position as Shaka's start time: Shaka's Playhead
        // treats the load start time as authoritative and repositions the
        // element to it on loadedmetadata — a manual currentTime set alone
        // gets clobbered back to 0 (the restart-from-start bug).
        const mountStartAt =
          Number.isFinite(startPosition) && startPosition > 0.5 ? startPosition : undefined
        await player.attach(video)
        player.configure(config)
        await player.load(manifestUrl, mountStartAt)
        if (disposed) return

        const tracks = player.getVariantTracks()
        setVariantTracks(tracks)

        // Play the ORIGINAL audio by default: main resolves the language of the
        // track YouTube marks as default/original (same marker NewPipe reads).
        // Fall back to English, then to whatever comes first.
        const audio = player.getAudioTracks()
        setAudioTracks(audio)
        if (audio.length > 0) {
          const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase()
          const prime = (s: string): string => s.split('-')[0].split('_')[0].split('.')[0]
          const wanted = norm(defaultLangRef.current)
          const original =
            (wanted ? audio.find((track) => norm(audioCode(track)) === wanted) : undefined) ??
            (wanted ? audio.find((track) => prime(norm(audioCode(track))) === prime(wanted)) : undefined) ??
            audio.find((track) => prime(norm(audioCode(track))) === 'en') ??
            audio[0]
          try {
            player.selectAudioTrack(original)
            audioLangRef.current = audioCode(original)
            setSelectedAudioLang(audioCode(original))
          } catch {
            /* the stream may only carry one audio rendition */
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
            /* ignore individual caption failures */
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
        video.volume = clamp01(initialVolume)
        rateRef.current = safeInitialSpeed
        setRate(safeInitialSpeed)

        const dur = player.seekRange().end || video.duration || 0
        if (Number.isFinite(dur) && dur > 0) setDuration(dur)

        if (preferredQuality === 'max') {
          const videoTracks = tracks.filter((t) => t.height != null)
          const best = videoTracks.sort(
            (a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth
          )[0]
          if (best) {
            player.configure({ abr: { enabled: false } } as unknown as shaka.extern.PlayerConfiguration)
            player.selectVariantTrack(best, true)
            setSelectedHeight(best.height)
          }
        } else if (
          preferredQuality !== 'auto' &&
          tracks.some((t) => t.height === Number(preferredQuality))
        ) {
          const best = tracks
            .filter((t) => t.height === Number(preferredQuality))
            .sort((a, b) => b.bandwidth - a.bandwidth)[0]
          if (best) {
            player.configure({ abr: { enabled: false } } as unknown as shaka.extern.PlayerConfiguration)
            player.selectVariantTrack(best, true)
            setSelectedHeight(best.height)
          }
        }

        const isLiveStream = player.isLive()
        if (isLiveStream) {
          const seekRange = player.seekRange()
          if (!startPosition || startPosition < seekRange.start || startPosition > seekRange.end) {
            const liveEdge = Math.max(seekRange.start, seekRange.end - 2)
            video.currentTime = liveEdge
            setCurrentTime(liveEdge)
          }
        } else if (
          startPosition > 0.5 &&
          (!dur || (startPosition < dur - 5 && startPosition / dur < 0.95))
        ) {
          setCurrentTime(startPosition)
          if (Math.abs(video.currentTime - startPosition) > 2) {
            try {
              video.currentTime = startPosition
            } catch {
              /* keep loaded position */
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
            /* autoplay can be rejected */
          }
        }
      } catch (err) {
        if (disposed) return
        // The very first load failed (e.g. the manifest minted minutes ago
        // already rotted). One refresh-and-reload before showing an error.
        setStatusText('Stream failed to start — retrying with fresh URLs…')
        try {
          await window.api.refreshManifest(videoId)
          if (disposed) return
          const sep = manifestUrl.includes('?') ? '&' : '?'
          const startAt =
            Number.isFinite(startPosition) && startPosition > 0.5 ? startPosition : undefined
          await player.load(`${manifestUrl}${sep}refresh=1`, startAt)
          if (disposed) return
          if (player.isLive()) {
            const seekRange = player.seekRange()
            const liveEdge = Math.max(seekRange.start, seekRange.end - 2)
            video.currentTime = liveEdge
            setCurrentTime(liveEdge)
          } else if (startPosition > 0.5) {
            try {
              video.currentTime = startPosition
              setCurrentTime(startPosition)
            } catch {
              /* keep the loaded position */
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
              /* autoplay can be rejected */
            }
          }
          return
        } catch {
          /* fall through to the error overlay */
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
      recoverPlaybackRef.current = null
      player.removeEventListener('error', onPlayerError)
      player.removeEventListener('buffering', onShakaBuffering)
      player.getNetworkingEngine()?.unregisterRequestFilter(requestFilter)
      playerRef.current = null
      void player.destroy().catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Stall watchdog --------------------------------------------------------
  // Seeks into unloaded regions (or a dying upstream) can leave Shaka retrying
  // quietly forever. If the clock doesn't advance while playback is expected,
  // run the unified recovery ladder. Spaced at least 15s apart so a persistently
  // dead stream can't loop forever.
  useEffect(() => {
    const id = window.setInterval(() => {
      const video = videoRef.current
      if (!video || statusRef.current !== 'ready') return
      // User scrub drag or hidden tab: defer watchdog
      if (document.hidden || scrubbingRef.current) {
        lastProgressRef.current = { t: video.currentTime, at: Date.now() }
        return
      }
      // Natural paused or ended state (when not waiting for a seek): no stall
      if (video.paused && !video.seeking) {
        lastProgressRef.current = { t: video.currentTime, at: Date.now() }
        return
      }
      if (video.ended) {
        lastProgressRef.current = { t: video.currentTime, at: Date.now() }
        return
      }
      const now = Date.now()
      const last = lastProgressRef.current

      if (playerRef.current?.isLive()) {
        const sr = playerRef.current.seekRange()
        if (sr.end > sr.start && (video.currentTime < sr.start - 0.5 || video.currentTime > sr.end + 2)) {
          const target = Math.max(sr.start, sr.end - 2)
          video.currentTime = target
          lastProgressRef.current = { t: target, at: now }
          return
        }
      }

      // If clock is advancing during normal playback, reset clock and replenish recovery budget after 15s
      if (video.currentTime !== last.t && !video.seeking) {
        lastProgressRef.current = { t: video.currentTime, at: now }
        if (recoveryCount.current > 0 && now - lastRecoveryRef.current > 15000) {
          recoveryCount.current = 0
        }
        return
      }
      // If readyState is satisfied and not seeking:
      if (video.readyState >= 3 && !video.seeking) {
        lastProgressRef.current = { t: video.currentTime, at: now }
        return
      }

      // If we are stuck (either currentTime not advancing while playing, or seeking never completing):
      const stuckMs = now - last.at
      if (stuckMs > 4000 && stuckMs <= 10000) {
        setBusy(true)
        setStatusText(video.seeking ? 'Seeking…' : 'Buffering…')
      } else if (
        stuckMs > 10000 &&
        now - lastRecoveryRef.current > 15000 &&
        recoveryCount.current < 3 &&
        playerRef.current
      ) {
        if (recoverPlaybackRef.current) {
          void recoverPlaybackRef.current(video.seeking ? 'seek stall' : 'playback stall')
        }
      }
    }, 2000)
    return () => window.clearInterval(id)
  }, [videoId, manifestUrl])

  // ---- Silence boost: fast-forward speed driven by worklet detection ----
  // When sustained silence is confirmed (> 150ms), the worklet applies smooth fade-out
  // padding down to 10% volume, then signals `boost: true`. The media rate is then
  // safely sped up. When speech returns, the worklet's lookahead delay buffer signals
  // `boost: false` immediately and retroactively fades in the pre-speech padding,
  // restoring normal rate and 100% volume BEFORE speech exits the buffer.
  const boostTarget = (): number => {
    const video = videoRef.current
    const baseRate = Number.isFinite(rateRef.current) && rateRef.current >= 0.25 ? rateRef.current : 1
    if (!video) return baseRate
    return Math.min(3.5, Math.max(2.25, baseRate * SILENCE_SKIP_MULTIPLIER))
  }

  const setBoost = useCallback((on: boolean) => {
    const video = videoRef.current
    if (!video) return
    boostRef.current = on
    const baseRate = Number.isFinite(rateRef.current) && rateRef.current >= 0.25 ? rateRef.current : 1
    if (on) {
      const target = boostTarget()
      if (video.playbackRate !== target) {
        video.playbackRate = target
      }
    } else {
      if (video.playbackRate !== baseRate) {
        video.playbackRate = baseRate
      }
    }
  }, [])

  const endBoost = useCallback(() => {
    const wasBoosting = boostRef.current
    boostRef.current = false
    const video = videoRef.current
    const baseRate = Number.isFinite(rateRef.current) && rateRef.current >= 0.25 ? rateRef.current : 1
    if (video && wasBoosting && video.playbackRate !== baseRate) {
      video.playbackRate = baseRate
    }
  }, [])

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
      if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration)
      maybeSkip(video.currentTime)
      if (statusRef.current === 'ready' && !scrubbingRef.current && !video.seeking && (video.readyState >= 3 || !video.paused)) {
        setBusy(false)
        setStatusText('')
      }
      const now = Date.now()
      if (now - lastReportRef.current > 4000) {
        lastReportRef.current = now
        onTimeUpdateRef.current(video.currentTime, video.duration || 0)
      }
    }
    const onPlay = (): void => {
      setPlaying(true)
      setPosterVisible(false)
      setBusy(false)
      setStatusText('')
      // NOTE: deliberately does NOT reset lastProgressRef. The stall watchdog
      // must measure genuine clock advancement — transient 'playing' blips
      // while Shaka struggles would otherwise reset its clock forever and the
      // watchdog would never fire. timeupdate/seeked keep the clock honest.
      const ctx = audioCtxRef.current
      if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    }
    const onPause = (): void => {
      setPlaying(false)
      if (video.readyState >= 3 || !video.seeking) {
        setBusy(false)
        setStatusText('')
      }
    }
    const onVolume = (): void => {
      if (!gainNodeRef.current) {
        setVolume(video.volume)
        setMuted(video.muted)
      }
    }
    const onRate = (): void => {
      // A silence boost owns playbackRate until it is released. Ignore the boost
      // so the menu keeps showing the user's chosen speed.
      if (boostRef.current) return
      const r = video.playbackRate
      if (!Number.isFinite(r) || r < 0.25) return
      setRate(Math.min(5, Math.max(0.25, r)))
    }
    const onDuration = (): void => {
      if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration)
    }
    const onEnded = (): void => {
      setPlaying(false)
      onTimeUpdateRef.current(0, video.duration || 0)
      onEndedRef.current()
    }

    // A seek or a stall throws away whatever the detector had accumulated, and it also
    // means the element is not playing steadily, so drop any boost immediately.
    const onTimelineReset = (): void => {
      skipperRef.current?.flush()
      endBoost()
    }
    const onEmptied = (): void => {
      onTimelineReset()
    }

    const onSeeked = (): void => {
      onTimelineReset()
      setSeekTarget(null)
      lastProgressRef.current = { t: video.currentTime, at: Date.now() }
      if (video.readyState >= 3 || video.paused) {
        setBusy(false)
        setStatusText('')
      } else {
        setBusy(true)
        setStatusText('Buffering…')
      }
    }
    // The element ran out of frames: show the spinner immediately instead of a
    // frozen picture. Cleared by playing/canplay/seeked or the watchdog.
    const onWaiting = (): void => {
      if (statusRef.current !== 'ready') return
      setBusy(true)
      setStatusText('Buffering…')
    }
    // A user seek into an unloaded region: label it as seeking. (Scrub drags
    // already show the preview + target time, so stay quiet for those.)
    const onSeeking = (): void => {
      lastProgressRef.current = { t: video.currentTime, at: Date.now() }
      onTimelineReset()
      if (statusRef.current !== 'ready' || scrubbingRef.current) return
      setBusy(true)
      setStatusText('Seeking…')
    }
    const onStalled = (): void => {
      if (statusRef.current !== 'ready' || video.paused) return
      onTimelineReset()
      setBusy(true)
      setStatusText('Connection slow — buffering…')
    }
    const onCanPlay = (): void => {
      if (video.readyState >= 3 && !scrubbingRef.current) {
        setBusy(false)
        setStatusText('')
      }
    }
    video.addEventListener('emptied', onEmptied)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('seeking', onSeeking)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('stalled', onStalled)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('progress', collectBuffered)
    video.addEventListener('durationchange', onDuration)
    video.addEventListener('play', onPlay)
    video.addEventListener('playing', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('volumechange', onVolume)
    video.addEventListener('ratechange', onRate)
    video.addEventListener('ended', onEnded)
    return () => {
      video.removeEventListener('emptied', onEmptied)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('stalled', onStalled)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('progress', collectBuffered)
      video.removeEventListener('durationchange', onDuration)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('playing', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('volumechange', onVolume)
      video.removeEventListener('ratechange', onRate)
      video.removeEventListener('ended', onEnded)
    }
  }, [maybeSkip, endBoost])

  useEffect(() => {
    const onFsChange = (): void => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  // ---- Audio graph + Volume booster (up to 300%) + Limiter -----------------
  const initAudioGraph = useCallback(() => {
    const video = videoRef.current
    if (!video) return null
    if (audioCtxRef.current && gainNodeRef.current) {
      if (audioCtxRef.current.state === 'suspended') {
        void audioCtxRef.current.resume().catch(() => undefined)
      }
      return audioCtxRef.current
    }

    try {
      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioCtor) return null

      const ctx = new AudioCtor()
      audioCtxRef.current = ctx

      const source = ctx.createMediaElementSource(video)
      sourceNodeRef.current = source

      const gain = ctx.createGain()
      gain.gain.value = muted ? 0 : volume
      gainNodeRef.current = gain

      // DynamicsCompressor acts as a brickwall limiter to ensure 300% volume sounds clean without distortion/clipping
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.setValueAtTime(-1.0, ctx.currentTime)
      limiter.knee.setValueAtTime(0, ctx.currentTime)
      limiter.ratio.setValueAtTime(20, ctx.currentTime)
      limiter.attack.setValueAtTime(0.003, ctx.currentTime)
      limiter.release.setValueAtTime(0.1, ctx.currentTime)
      limiterRef.current = limiter

      // Signal flow:
      // source -> [skip-skipping worklet] -> gain (0-300%) -> limiter (brickwall) -> destination
      // The worklet loads asynchronously; it is spliced in below once ready.
      source.connect(gain)
      gain.connect(limiter)
      limiter.connect(ctx.destination)

      // Let Web Audio handle volume and boosting cleanly
      video.volume = 1
      video.muted = false

      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined)
      }

      if (!skipperPendingRef.current) {
        skipperPendingRef.current = true
        void createSilenceSkipper(ctx, {
          onBoostChange: setBoost
        })
          .then((skipper) => {
            skipperPendingRef.current = false
            // The graph may have been torn down while the module was loading.
            if (audioCtxRef.current !== ctx || !sourceNodeRef.current) {
              skipper?.dispose()
              return
            }
            if (!skipper) return
            skipperRef.current = skipper
            try {
              source.disconnect()
              source.connect(skipper.node)
              skipper.node.connect(gain)
            } catch {
              // Rewiring failed: keep the ungated graph rather than silence the video.
              skipper.dispose()
              skipperRef.current = null
              return
            }
            skipper.setEnabled(skipperEnabledRef.current)
          })
          .catch(() => {
            skipperPendingRef.current = false
          })
      }

      return ctx
    } catch {
      return null
    }
  }, [muted, volume, setBoost])

  // Initialize audio graph on video element mount or when ready
  useEffect(() => {
    if (status === 'ready') {
      initAudioGraph()
    }
  }, [status, initAudioGraph])

  // ---- Skip silence: Media3's SilenceSkippingAudioProcessor, ported to an AudioWorklet ----
  // The worklet detects silence sample-by-sample and gates the audio; this effect only
  // turns the detector on/off. Turning it off flushes the detector so a paused or
  // disabled player always resumes at the user's rate.
  useEffect(() => {
    const wanted = skipSilence && playing
    skipperEnabledRef.current = wanted
    if (wanted) {
      initAudioGraph()
    } else {
      endBoost()
    }
    const skipper = skipperRef.current
    if (!skipper) return
    skipper.setEnabled(wanted)
    skipper.flush()
  }, [skipSilence, playing, initAudioGraph, endBoost])

  // ---- Subtitle positioning: dynamically adjust bottom offset based on overlay height ----
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const updateHeight = (): void => {
      const h = el.offsetHeight || 96
      if (controlsVisible) {
        setSubtitlesBottom(Math.round(h) + 8)
      } else {
        setSubtitlesBottom(fullscreen ? 24 : 16)
      }
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(el)
    return () => observer.disconnect()
  }, [controlsVisible, fullscreen])

  useEffect(() => {
    return () => {
      endBoost()
      skipperRef.current?.dispose()
      skipperRef.current = null
      skipperPendingRef.current = false
      void audioCtxRef.current?.close().catch(() => undefined)
      audioCtxRef.current = null
      gainNodeRef.current = null
      limiterRef.current = null
      sourceNodeRef.current = null
    }
  }, [endBoost])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // The silence boost never overrides this: the worklet has the audio gated while the
    // rate is ramped, so pitch preservation only matters during real speech.
    video.preservesPitch = preservePitch
  }, [preservePitch])

  const seekTo = useCallback((time: number) => {
    const video = videoRef.current
    if (video) {
      setSeekTarget(time)
      video.currentTime = time
    }
  }, [])

  const seekToPreviousChapter = useCallback(() => {
    if (!chapters || chapters.length === 0) return
    const video = videoRef.current
    const cur = video ? video.currentTime : 0
    for (let i = chapters.length - 1; i >= 0; i--) {
      const ch = chapters[i]
      if (cur > ch.start + 3) {
        seekTo(ch.start)
        return
      } else if (cur > ch.start) {
        const prev = chapters[i - 1]
        seekTo(prev ? prev.start : 0)
        return
      }
    }
    seekTo(0)
  }, [chapters, seekTo])

  const seekToNextChapter = useCallback(() => {
    if (!chapters || chapters.length === 0) return
    const video = videoRef.current
    const cur = video ? video.currentTime : 0
    const next = chapters.find((ch) => ch.start > cur + 0.5)
    if (next) {
      seekTo(next.start)
    }
  }, [chapters, seekTo])

  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta))
  }, [])

  seekToRef.current = seekTo
  seekByRef.current = seekBy
  seekToPreviousChapterRef.current = seekToPreviousChapter
  seekToNextChapterRef.current = seekToNextChapter

  // ---- Imperative API --------------------------------------------------------
  useImperativeHandle(
    ref,
    () => ({
      seekTo,
      unskip: (segment: SponsorSegment) => {
        skipRef.current.set(segment.uuid, 'unskipped')
        const video = videoRef.current
        if (video) video.currentTime = segment.segment[0]
      },
      play: () => {
        void videoRef.current?.play().catch(() => undefined)
      },
      pause: () => videoRef.current?.pause(),
      seekBy,
      nextChapter: seekToNextChapter,
      previousChapter: seekToPreviousChapter
    }),
    [seekTo, seekBy, seekToNextChapter, seekToPreviousChapter]
  )
  // ---- Controls --------------------------------------------------------------
  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => {
      // Keep the bar (and any open popover) visible while a menu is in use.
      if (menuRef.current) return
      setControlsVisible(false)
    }, 3000)
  }, [])

  const revealControls = useCallback(() => {
    setControlsVisible(true)
    const video = videoRef.current
    if (video && !video.paused) scheduleHide()
  }, [scheduleHide])

  useEffect(() => {
    if (playing) {
      setControlsVisible(true)
      scheduleHide()
    } else {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
      setControlsVisible(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, scheduleHide])

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    }
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }, [])

  const changeVolume = useCallback(
    (next: number) => {
      const video = videoRef.current
      if (!video) return
      const v = clampVolume(next)
      setVolume(v)
      const isMuted = v === 0
      setMuted(isMuted)

      initAudioGraph()
      if (gainNodeRef.current && audioCtxRef.current) {
        gainNodeRef.current.gain.setValueAtTime(isMuted ? 0 : v, audioCtxRef.current.currentTime)
        video.volume = 1
        video.muted = false
      } else {
        video.volume = Math.min(1, v)
        video.muted = isMuted
      }
    },
    [initAudioGraph]
  )

  const toggleMute = useCallback(() => {
    const nextMuted = !muted
    setMuted(nextMuted)
    initAudioGraph()
    if (gainNodeRef.current && audioCtxRef.current) {
      gainNodeRef.current.gain.setValueAtTime(
        nextMuted ? 0 : (volume || 1),
        audioCtxRef.current.currentTime
      )
    } else if (videoRef.current) {
      videoRef.current.muted = nextMuted
    }
  }, [muted, volume, initAudioGraph])

  const changeRate = useCallback(
    (value: number) => {
      const video = videoRef.current
      const clamped = Math.min(5, Math.max(0.25, value))
      rateRef.current = clamped
      setRate(clamped)
      if (!video) return
      if (boostRef.current) {
        // Retarget the boost so the new speed takes effect immediately instead of
        // waiting for the current silence to end.
        setBoost(true)
      } else {
        video.playbackRate = clamped
      }
    },
    [setBoost]
  )

  const stepSpeed = useCallback(
    (direction: -1 | 1) => {
      const currentIndex = SPEEDS.findIndex((s) => Math.abs(s - rate) < 0.01)
      if (currentIndex !== -1) {
        const nextIndex = Math.max(0, Math.min(SPEEDS.length - 1, currentIndex + direction))
        changeRate(SPEEDS[nextIndex])
      } else {
        const target =
          direction > 0
            ? SPEEDS.find((s) => s > rate) ?? 5
            : [...SPEEDS].reverse().find((s) => s < rate) ?? 0.25
        changeRate(target)
      }
    },
    [rate, changeRate]
  )

  const closeMenu = useCallback((): void => {
    setMenu(null)
    setMenuAnchor(null)
  }, [])

  const toggleMenu = useCallback(
    (kind: MenuKind, element: HTMLElement): void => {
      if (menuRef.current === kind) {
        closeMenu()
        return
      }
      setMenu(kind)
      setMenuAnchor(element)
    },
    [closeMenu]
  )

  /**
   * Applies a video height and/or audio quality tier. Passing null for both returns
   * to adaptive streaming. The chosen audio language is re-applied afterwards
   * because switching variants can reset it.
   */
  const selectStream = useCallback((height: number | null, audioTier: string | null) => {
    const player = playerRef.current
    if (!player) return
    if (height == null && audioTier == null) {
      player.configure({ abr: { enabled: true } } as unknown as shaka.extern.PlayerConfiguration)
      setSelectedHeight(null)
      setSelectedAudioTier(null)
      return
    }
    const inTier = (track: VariantTrack): boolean => {
      if (audioTier == null) return true
      const bps = track.audioBandwidth ?? 0
      if (audioTier === 'Low') return bps < 96_000
      if (audioTier === 'Medium') return bps >= 96_000 && bps < 192_000
      return bps >= 192_000
    }
    const best = player
      .getVariantTracks()
      .filter(
        (track) =>
          (height == null || track.height === height) && inTier(track)
      )
      .sort((a, b) => b.bandwidth - a.bandwidth)[0]
    if (!best) return
    player.configure({ abr: { enabled: false } } as unknown as shaka.extern.PlayerConfiguration)
    player.selectVariantTrack(best, true)
    setSelectedHeight(height)
    setSelectedAudioTier(audioTier)
    if (audioLangRef.current != null) {
      const track = player.getAudioTracks().find((a) => audioCode(a) === audioLangRef.current)
      if (track) {
        try {
          player.selectAudioTrack(track)
        } catch {
          /* keep going with whatever the variant provides */
        }
      }
    }
  }, [])

  const selectHeight = useCallback(
    (height: number | null) => {
      selectStream(height, selectedAudioTier)
      closeMenu()
    },
    [selectStream, selectedAudioTier, closeMenu]
  )

  const selectAudioTier = useCallback(
    (tier: string | null) => {
      selectStream(selectedHeight, tier)
      closeMenu()
    },
    [selectStream, selectedHeight, closeMenu]
  )

  const selectAudio = useCallback(
    (code: string) => {
      const player = playerRef.current
      if (!player) return
      const track = player.getAudioTracks().find((a) => audioCode(a) === code)
      if (!track) return
      try {
        player.selectAudioTrack(track)
        audioLangRef.current = code
        setSelectedAudioLang(code)
      } catch {
        /* unsupported rendition */
      }
      closeMenu()
    },
    [closeMenu]
  )

  const selectCaption = useCallback(
    (id: number | null) => {
      const player = playerRef.current
      if (!player) return
      if (id == null) {
        player.selectTextTrack(null)
        setActiveTextId(null)
        setTextVisible(false)
      } else {
        const track = player.getTextTracks().find((t) => t.id === id)
        if (track) {
          player.selectTextTrack(track)
          setActiveTextId(id)
          setTextVisible(true)
        }
      }
      closeMenu()
    },
    [closeMenu]
  )

  const toggleCaptions = useCallback(() => {
    if (textTracks.length === 0) return
    if (textVisible) selectCaption(null)
    else selectCaption(textTracks[0]?.id ?? null)
  }, [textTracks, textVisible, selectCaption])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen().catch(() => undefined)
  }, [])

  const togglePip = useCallback(() => {
    const video = videoRef.current
    if (!video || !('requestPictureInPicture' in video)) return
    if (document.pictureInPictureElement) void document.exitPictureInPicture()
    else void video.requestPictureInPicture().catch(() => undefined)
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (/^[0-9]$/.test(event.key) && duration > 0) {
        event.preventDefault()
        seekTo((Number(event.key) / 10) * duration)
        revealControls()
        return
      }
      switch (event.key) {
        // ' ' is the modern value; the aliases keep the shortcut alive if an
        // older engine or an IME reports a named key instead.
        case ' ':
        case 'Spacebar':
        case 'Space':
        case 'k':
        case 'K':
          event.preventDefault()
          togglePlay()
          break
        case 'j':
        case 'J':
          event.preventDefault()
          seekBy(-10)
          break
        case 'l':
        case 'L':
          event.preventDefault()
          seekBy(10)
          break
        case 'ArrowLeft':
          event.preventDefault()
          if (event.ctrlKey && chapters && chapters.length > 0) {
            seekToPreviousChapter()
          } else {
            seekBy(-5)
          }
          break
        case 'ArrowRight':
          event.preventDefault()
          if (event.ctrlKey && chapters && chapters.length > 0) {
            seekToNextChapter()
          } else {
            seekBy(5)
          }
          break
        case '[':
          event.preventDefault()
          seekToPreviousChapter()
          break
        case ']':
          event.preventDefault()
          seekToNextChapter()
          break
        case 'ArrowUp':
          event.preventDefault()
          changeVolume(volume + 0.05)
          break
        case 'ArrowDown':
          event.preventDefault()
          changeVolume(volume - 0.05)
          break
        case 'm':
        case 'M':
          event.preventDefault()
          toggleMute()
          break
        case 'f':
        case 'F':
          event.preventDefault()
          toggleFullscreen()
          break
        case 'c':
        case 'C':
          event.preventDefault()
          toggleCaptions()
          break
        case 'i':
        case 'I':
          event.preventDefault()
          togglePip()
          break
        case '<':
        case ',':
          event.preventDefault()
          stepSpeed(-1)
          break
        case '>':
        case '.':
          event.preventDefault()
          stepSpeed(1)
          break
        case 'Home':
          event.preventDefault()
          seekTo(0)
          break
        case 'End':
          if (duration > 0) {
            event.preventDefault()
            seekTo(duration - 0.1)
          }
          break
        case 'Escape':
          if (menuRef.current) {
            event.preventDefault()
            closeMenu()
          }
          break
        default:
          break
      }
      revealControls()
    },
    [
      togglePlay,
      seekBy,
      seekTo,
      seekToPreviousChapter,
      seekToNextChapter,
      chapters,
      changeVolume,
      toggleMute,
      toggleFullscreen,
      toggleCaptions,
      togglePip,
      stepSpeed,
      volume,
      revealControls,
      closeMenu,
      duration
    ]
  )

  useEffect(() => {
    // The player container also carried `onKeyDown` so that focused playback
    // still responded. That made every shortcut run twice: React dispatches
    // synthetic events at the root container, which sits *below* `window`, so a
    // key pressed while the player held focus was handled once at the root and
    // again on the way to `window`. Toggles cancelled themselves out (space
    // appeared dead), while seeks merely doubled and looked fine. The window
    // listener sees every key inside the player regardless of focus, so it is
    // now the only handler.
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      const active = document.activeElement
      if (active && isTypingTarget(active)) return

      // Clicking a control leaves it focused, and the browser turns Space on a
      // focused button into a click — so the shortcut replayed whichever button
      // was pressed last instead of toggling playback. Inside the player, Space
      // belongs to the player: suppress the default so the button stays inert
      // and let the switch below run once. Space on controls *outside* the
      // player is deliberately untouched, because there it is the browser's
      // activation key and keyboard users expect it to press the button.
      if (
        isSpaceKey(event) &&
        active !== null &&
        isActivatable(active) &&
        containerRef.current?.contains(active) === true
      ) {
        event.preventDefault()
      }
      onKeyDown(event as unknown as React.KeyboardEvent)
    }

    window.addEventListener('keydown', handleWindowKeyDown)
    return () => window.removeEventListener('keydown', handleWindowKeyDown)
  }, [onKeyDown])

  // ---- Stage click / double-click ---------------------------------------------
  const onStageClick = useCallback((): void => {
    if (clickTimerRef.current != null) return
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      togglePlay()
    }, 220)
  }, [togglePlay])

  const onStageDoubleClick = useCallback((): void => {
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    toggleFullscreen()
  }, [toggleFullscreen])

  useEffect(() => {
    return () => {
      if (clickTimerRef.current != null) window.clearTimeout(clickTimerRef.current)
    }
  }, [])

  // ---- Seek bar --------------------------------------------------------------
  const fractionFromEvent = (event: React.PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return clamp01((event.clientX - rect.left) / rect.width)
  }

  const updateScrub = (event: React.PointerEvent<HTMLDivElement>): void => {
    const fraction = fractionFromEvent(event)
    const time = fraction * (duration || 0)
    scrubTimeRef.current = time
    setScrubTime(time)
  }

  const onSeekDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!duration) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setScrubbing(true)
    updateScrub(event)
  }
  const onSeekMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!scrubbing) return
    updateScrub(event)
  }
  const onSeekUp = (): void => {
    if (!scrubbing) return
    setScrubbing(false)
    const video = videoRef.current
    if (video) {
      // Hold the target until the video reports it — otherwise the readout
      // snaps back to the pre-seek time for a moment.
      setSeekTarget(scrubTimeRef.current)
      video.currentTime = scrubTimeRef.current
    }
    revealControls()
  }

  const onSeekKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!duration) return
    // The player's window-level shortcuts also handle these keys, so suppress
    // propagation — otherwise every arrow press would seek twice.
    let target: number | null = null
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        target = Math.max(0, displayTime - 5)
        break
      case 'ArrowRight':
      case 'ArrowUp':
        target = Math.min(duration, displayTime + 5)
        break
      case 'PageDown':
        target = Math.max(0, displayTime - 60)
        break
      case 'PageUp':
        target = Math.min(duration, displayTime + 60)
        break
      case 'Home':
        target = 0
        break
      case 'End':
        target = duration
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    setSeekTarget(target)
    scrubTimeRef.current = target
    seekToRef.current(target)
    revealControls()
  }

  const displayTime = seekTarget ?? (scrubbing ? scrubTime : currentTime)
  const playedPct = duration ? clamp01(displayTime / duration) * 100 : 0
  const maxBufferedTime = Math.max(0, ...buffered.map(([, end]) => end))
  const bufferedPct = duration
    ? clamp01(maxBufferedTime / duration) * 100
    : 0

  const hasChapters = Boolean(chapters && chapters.length > 0)
  const currentChapter = useMemo(() => {
    if (!hasChapters) return null
    return chapters.find((c) => displayTime >= c.start && displayTime < c.end) ?? chapters[chapters.length - 1] ?? null
  }, [hasChapters, chapters, displayTime])

  return (
    <div
      ref={containerRef}
      className={`player${fullscreen ? ' player--fullscreen' : ''}`}
      style={{ '--subtitles-bottom': `${subtitlesBottom}px` } as React.CSSProperties}
      onPointerMove={revealControls}
      onPointerLeave={() => {
        if (playing && !menuRef.current) setControlsVisible(false)
      }}
    >
      <video ref={videoRef} className="player__video" playsInline />
      {poster && (
        <img
          className={`player__poster${posterVisible ? '' : ' player__poster--hidden'}`}
          src={poster}
          alt=""
        />
      )}

      {(status === 'loading' || busy) && status !== 'error' && (
        <div className="player__center">
          <div className="spinner" />
          {statusText !== '' && <div className="player__status">{statusText}</div>}
        </div>
      )}

      {status === 'error' && (
        <div className="player__error">
          <div>
            <p className="player__error-title">Unable to play this video</p>
            <p>{errorMsg}</p>
          </div>
        </div>
      )}

      {status === 'ready' && (
        <>
          <div
            className="player__stage"
            onClick={onStageClick}
            onDoubleClick={onStageDoubleClick}
          />

          {!playing && !scrubbing && !busy && (
            <div className="player__center">
              <button className="player__big-play" aria-label="Play" onClick={togglePlay}>
                <Icon name="play" size={34} />
              </button>
            </div>
          )}

          <div
            ref={overlayRef}
            className={`player__overlay${controlsVisible ? '' : ' player__overlay--hidden'}`}
          >
            {/* The bar is pointer-driven, so it is exposed as a slider: screen
                readers announce position and duration, and Left/Right/Home/End
                move it like a native one. `aria-label` is required — the bar
                has no visible text of its own. */}
            <div
              className={`seek${scrubbing ? ' seek--scrubbing' : ''}`}
              role="slider"
              tabIndex={0}
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, Math.floor(duration))}
              aria-valuenow={Math.floor(displayTime)}
              aria-valuetext={`${fmt(displayTime)} of ${fmt(duration)}`}
              onPointerDown={onSeekDown}
              onPointerMove={onSeekMove}
              onPointerUp={onSeekUp}
              onPointerCancel={onSeekUp}
              onKeyDown={onSeekKeyDown}
            >
              {hasChapters ? (
                <div className="seek__chapters">
                  {chapters.map((ch, idx) => {
                    const chDur = Math.max(0.1, ch.end - ch.start)
                    const playedInCh = Math.max(0, Math.min(displayTime - ch.start, chDur))
                    const chPlayedPct = (playedInCh / chDur) * 100

                    const bufInCh = Math.max(0, Math.min(maxBufferedTime - ch.start, chDur))
                    const chBufPct = (bufInCh / chDur) * 100

                    return (
                      <div
                        key={idx}
                        className="seek__chapter-segment"
                        style={{ flex: chDur }}
                        title={`${ch.title} (${fmt(ch.start)} - ${fmt(ch.end)})`}
                      >
                        <div
                          className="seek__chapter-buffered"
                          style={{ width: `${chBufPct}%` }}
                        />
                        <div
                          className="seek__chapter-played"
                          style={{ width: `${chPlayedPct}%` }}
                        />
                      </div>
                    )
                  })}
                  {duration > 0 && <SponsorLayer segments={segments} duration={duration} />}
                </div>
              ) : (
                <div className="seek__track">
                  <div className="seek__buffered" style={{ width: `${bufferedPct}%` }} />
                  <div className="seek__played" style={{ width: `${playedPct}%` }} />
                  {duration > 0 && <SponsorLayer segments={segments} duration={duration} />}
                </div>
              )}
              <div className="seek__thumb" style={{ left: `${playedPct}%` }} />
            </div>

            <div className="player__controls">
              <button className="icon-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
                <Icon name={playing ? 'pause' : 'play'} size={24} />
              </button>

              <div className="player__volume">
                <button
                  className="icon-btn"
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  onClick={toggleMute}
                >
                  <Icon name={muted || volume === 0 ? 'volumeOff' : 'volume'} size={22} />
                </button>
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={3}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(e) => changeVolume(Number(e.target.value))}
                  aria-label="Volume"
                  // Above 100% is silent amplification, which a screen reader
                  // would otherwise announce as the bare number "250".
                  aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} percent${
                    volume > 1 ? ', amplified' : ''
                  }`}
                />
                <span className={`player__volume-value${volume > 1 ? ' player__volume-value--boosted' : ''}`}>
                  {Math.round((muted ? 0 : volume) * 100)}%
                </span>
              </div>

              <span className="player__time">
                {fmt(displayTime)} <span className="player__time-total">/ {fmt(duration)}</span>
              </span>

              {hasChapters && currentChapter && (
                <div
                  className="player__chapter-indicator"
                  title={`Chapter: ${currentChapter.title}`}
                  aria-label={`Current chapter: ${currentChapter.title}`}
                >
                  <span className="player__chapter-sep">•</span>
                  <span className="player__chapter-title">{currentChapter.title}</span>
                </div>
              )}

              <div className="player__spacer" />

              {textTracks.length > 0 && (
                <button
                  className={`icon-btn${textVisible ? ' icon-btn--active' : ''}`}
                  aria-label="Subtitles"
                  onClick={(event) => toggleMenu('captions', event.currentTarget)}
                >
                  <Icon name="captions" size={22} />
                </button>
              )}
              <button
                className={`icon-btn${skipSilence ? ' icon-btn--active' : ''}`}
                aria-label="Playback settings"
                title="Playback settings"
                onClick={(event) => toggleMenu('settings', event.currentTarget)}
              >
                <Icon name="tune" size={22} />
              </button>
              {audioTracks.length > 0 && (
                <button
                  className="icon-btn"
                  aria-label="Audio track"
                  title="Audio track"
                  onClick={(event) => toggleMenu('audio', event.currentTarget)}
                >
                  <Icon name="volume" size={22} />
                </button>
              )}
              <button
                className="icon-btn"
                aria-label="Quality"
                onClick={(event) => toggleMenu('quality', event.currentTarget)}
              >
                <Icon name="hd" size={22} />
              </button>
              <button className="icon-btn" aria-label="Picture in picture" onClick={togglePip}>
                <Icon name="pip" size={22} />
              </button>
              <button
                className="icon-btn"
                aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                onClick={toggleFullscreen}
              >
                <Icon name={fullscreen ? 'fullscreenExit' : 'fullscreen'} size={22} />
              </button>
            </div>
          </div>

          <Menu
            anchor={menuAnchor}
            open={menu === 'settings'}
            onClose={closeMenu}
            align="end"
            gap={36}
            prefer="above"
            className="sheet"
          >
            <div className="sheet__title">Playback settings</div>

            <div className="sheet__row sheet__row--stack">
              <div className="sheet__row-head">
                <span className="sheet__label">Speed</span>
                <span className="sheet__value">
                  {rate === 1 ? 'Normal' : `${rate.toFixed(2)}×`}
                </span>
              </div>
              <div className="speed-chips">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    className={`speed-chips__chip${rate === s ? ' speed-chips__chip--active' : ''}`}
                    onClick={() => changeRate(s)}
                  >
                    {s === 1 ? 'Normal' : `${s}×`}
                  </button>
                ))}
              </div>
              <SliderField
                value={rate}
                min={0.25}
                max={5}
                step={0.05}
                precision={2}
                suffix="×"
                label="Playback speed"
                onChange={changeRate}
              />
            </div>

            <div className="sheet__row sheet__row--toggle">
              <div>
                <div className="sheet__label">Preserve pitch</div>
                <div className="sheet__hint">Keep audio pitch when changing speed.</div>
              </div>
              <Switch
                on={preservePitch}
                label="Preserve pitch"
                onClick={() => {
                  const next = !preservePitch
                  pitchRef.current = next
                  const video = videoRef.current
                  if (video) video.preservesPitch = next
                  onPitchChange(next)
                }}
              />
            </div>

            <div className="sheet__row sheet__row--toggle">
              <div>
                <div className="sheet__label">Skip silence</div>
                <div className="sheet__hint">Fast-forward through silent passages.</div>
              </div>
              <Switch
                on={skipSilence}
                label="Skip silence"
                onClick={() => onSkipSilenceChange(!skipSilence)}
              />
            </div>
          </Menu>

          <Menu
            anchor={menuAnchor}
            open={menu === 'quality'}
            onClose={closeMenu}
            align="end"
            gap={36}
            prefer="above"
            title="Quality"
            checkable
          >
            <MenuItem
              label="Auto"
              selected={selectedHeight == null && selectedAudioTier == null}
              onSelect={() => {
                selectStream(null, null)
                closeMenu()
              }}
            />
            {levelHeights.map((level) => (
              <MenuItem
                key={level.height}
                label={`${level.height}p`}
                selected={selectedHeight === level.height}
                onSelect={() => selectHeight(level.height)}
              />
            ))}
          </Menu>

          <Menu
            anchor={menuAnchor}
            open={menu === 'captions'}
            onClose={closeMenu}
            align="end"
            gap={36}
            prefer="above"
            title="Subtitles"
            checkable
          >
            <MenuItem
              label="Off"
              selected={!textVisible}
              onSelect={() => selectCaption(null)}
            />
            {textTracks.length === 0 ? (
              <div className="menu__item menu__item--empty">No subtitles available</div>
            ) : (
              textTracks.map((track, index) => (
                <MenuItem
                  key={track.id ?? `${track.language}-${track.label}-${index}`}
                  label={track.label || track.language}
                  selected={textVisible && activeTextId === track.id}
                  onSelect={() => selectCaption(track.id)}
                />
              ))
            )}
          </Menu>

          <Menu
            anchor={menuAnchor}
            open={menu === 'audio'}
            onClose={closeMenu}
            align="end"
            gap={36}
            prefer="above"
            title="Audio"
            checkable
          >
            {audioLanguages.map((entry) => (
              <MenuItem
                key={entry.code}
                label={entry.label}
                hint={
                  isOriginalLanguage(entry.code) && audioLanguages.length > 1
                    ? 'original'
                    : undefined
                }
                selected={selectedAudioLang === entry.code}
                onSelect={() => selectAudio(entry.code)}
              />
            ))}
            {audioTiers.length > 1 && (
              <>
                <div className="menu__divider" />
                <div className="menu__title">Audio quality</div>
                <MenuItem
                  label="Auto"
                  selected={selectedAudioTier == null}
                  onSelect={() => selectAudioTier(null)}
                />
                {audioTiers.map((tier) => (
                  <MenuItem
                    key={tier}
                    label={tier}
                    selected={selectedAudioTier === tier}
                    onSelect={() => selectAudioTier(tier)}
                  />
                ))}
              </>
            )}
          </Menu>
        </>
      )}
    </div>
  )
})
