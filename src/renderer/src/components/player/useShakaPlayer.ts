import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import shaka from 'shaka-player'
import { isAudioItagUrl, languageName } from '../../../../shared/media'
import {
  audioCode,
  type AudioTrack,
  type PlayerProps,
  type TextTrack,
  type VariantTrack
} from './types'

export interface UseShakaPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  videoId: string
  manifestUrl: string
  startPosition: number
  autoplay: boolean
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
  onOsd?: (text: string, icon?: string) => void
}

export function useShakaPlayer({
  videoRef,
  videoId,
  manifestUrl,
  startPosition,
  autoplay,
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
  const recoverPlaybackRef = useRef<((reason: string) => Promise<void>) | null>(null)
  const audioLangRef = useRef<string | null>(null)
  const defaultLangRef = useRef(defaultAudioLanguage)
  defaultLangRef.current = defaultAudioLanguage
  const lastReportRef = useRef(0)
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

  const isOriginalLanguage = useCallback(
    (code: string): boolean => {
      const wanted = (defaultAudioLanguage ?? '').toLowerCase()
      if (wanted === '') return false
      const prime = (s: string): string => s.split('-')[0].split('_')[0].split('.')[0]
      return code === wanted || prime(code) === prime(wanted)
    },
    [defaultAudioLanguage]
  )

  // Track selection
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
          /* keep going */
        }
      }
    }
  }, [])

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
      const track = player.getAudioTracks().find((a) => audioCode(a) === code)
      if (!track) return
      try {
        player.selectAudioTrack(track)
        audioLangRef.current = code
        setSelectedAudioLang(code)
        onOsd?.(`Audio: ${code === 'und' ? 'Original' : languageName(code)}`, 'volume')
      } catch {
        /* unsupported */
      }
    },
    [onOsd]
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
      } else {
        const track = player.getTextTracks().find((t) => t.id === id)
        if (track) {
          player.selectTextTrack(track)
          setActiveTextId(id)
          setTextVisible(true)
          onOsd?.(`Subtitles: ${track.label || track.language}`, 'captions')
        }
      }
    },
    [onOsd]
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

  const seekTo = useCallback((time: number) => {
    const video = videoRef.current
    if (!video) return
    const target = Math.max(0, Math.min(video.duration || Infinity, time))
    video.currentTime = target
    setCurrentTime(target)
  }, [videoRef])

  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current
    if (!video) return
    const target = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta))
    video.currentTime = target
    setCurrentTime(target)
    onOsd?.(`${delta > 0 ? `+${delta}s` : `${delta}s`}`, delta > 0 ? 'forward' : 'back')
  }, [onOsd, videoRef])

  // Shaka Lifecycle
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

    const recoverPlayback = async (reason: string): Promise<void> => {
      const attempt = recoveryCount.current
      if (disposed || attempt >= 3 || statusRef.current !== 'ready') return
      recoveryCount.current = attempt + 1
      lastRecoveryRef.current = Date.now()
      const resumeAt = video.currentTime
      setBusy(true)
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
      const isBuffering = (event as unknown as { buffering?: boolean }).buffering ?? false
      if (disposed || statusRef.current !== 'ready') return
      if (isBuffering) {
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
        const mountStartAt =
          Number.isFinite(startPosition) && startPosition > 0.5 ? startPosition : undefined
        await player.attach(video)
        player.configure(config)
        await player.load(manifestUrl, mountStartAt)
        if (disposed) return

        const tracks = player.getVariantTracks()
        setVariantTracks(tracks)

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
            /* single rendition */
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
      recoverPlaybackRef.current = null
      player.removeEventListener('error', onPlayerError)
      player.removeEventListener('buffering', onShakaBuffering)
      player.getNetworkingEngine()?.unregisterRequestFilter(requestFilter)
      playerRef.current = null
      void player.destroy().catch(() => undefined)
    }
  }, [videoId, manifestUrl])

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
      if (statusRef.current === 'ready' && (video.readyState >= 3 || !video.seeking)) {
        setBusy(false)
        setStatusText('')
      }
    }
    const onPause = (): void => {
      setPlaying(false)
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
