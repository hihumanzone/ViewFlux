import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { Icon } from './Icons'
import { Spinner } from './EmptyState'
import { useMediaSession } from '../lib/mediaSession'
import {
  useSleepTimer,
  setSleepTimer,
  registerActivePlayer,
  updateEndOfVideoRemaining,
  onEndOfVideoReached
} from '../lib/sleepTimer'
import { PlayerOsd } from './player/PlayerOsd'
import { SeekBar } from './player/SeekBar'
import { PlayerControls } from './player/PlayerControls'
import { MiniPlayerControls } from './player/MiniPlayerControls'
import { PlayerMenus } from './player/PlayerMenus'
import { usePlayerAudioGraph } from './player/usePlayerAudioGraph'
import { useShakaPlayer } from './player/useShakaPlayer'
import { usePlayerHotkeys } from './player/usePlayerHotkeys'
import type {
  Chapter,
  MenuKind,
  OsdState,
  PlayerHandle,
  PlayerProps
} from './player/types'
import type { SponsorSegment } from '../../../shared/types'
import { DEFAULT_SUBTITLE_STYLE, subtitleCssVars } from '../../../shared/subtitles'

export type { PlayerHandle, PlayerProps }

/** Stable empty collections so live mode never re-renders downstream children. */
const EMPTY_CHAPTERS: Chapter[] = []
const EMPTY_SEGMENTS: SponsorSegment[] = []

/** Breathing room between the top of the control overlay and the captions. */
const SUBTITLE_CLEARANCE = 14
/** Resting gap between the bottom of the stage and the captions when controls hide. */
const SUBTITLE_RESTING_GAP = 16
/** Inactivity duration (ms) before controls and cursor hide during active playback. */
const CONTROLS_AUTOHIDE_DELAY = 2600


export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  props,
  ref
): React.JSX.Element {
  const {
    videoId,
    manifestUrl,
    isLive,
    captions,
    poster,
    startPosition,
    autoplay,
    segments,
    autoSkip,
    sponsorBlockEnabled,
    alwaysShowCaptions,
    subtitleStyle = DEFAULT_SUBTITLE_STYLE,
    initialVolume,
    initialSpeed = 1,
    preferredQuality,
    preservePitch,
    skipSilence,
    defaultAudioLanguage,
    chapters = [],
    onPitchChange,
    onSkipSilenceChange,
    onSubtitleStyleChange,
    isMini = false,
    onExpand,
    onClose,
    title,
    author
  } = props

  const safeInitialSpeed =
    Number.isFinite(initialSpeed) && initialSpeed >= 0.25 ? initialSpeed : 1

  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const setOverlayRef = useCallback((el: HTMLDivElement | null) => {
    overlayRef.current = el
    setOverlayEl(el)
  }, [])
  const skipRef = useRef<Map<string, 'skipped' | 'unskipped'>>(new Map())
  const hideTimerRef = useRef<number | null>(null)
  const clickTimerRef = useRef<number | null>(null)
  const scrubbingRef = useRef(false)

  // SponsorBlock & event refs
  const segmentsRef = useRef(segments)
  const autoSkipRef = useRef(autoSkip)
  const enabledRef = useRef(sponsorBlockEnabled)
  const onSkippedRef = useRef(props.onSkipped)
  segmentsRef.current = segments
  autoSkipRef.current = autoSkip
  enabledRef.current = sponsorBlockEnabled
  onSkippedRef.current = props.onSkipped

  // UI state
  const [controlsVisible, setControlsVisible] = useState(true)
  const [cursorHidden, setCursorHidden] = useState(false)
  const lastPointerPosRef = useRef({ x: -1, y: -1 })
  const [menu, setMenu] = useState<MenuKind | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [fullscreen, setFullscreen] = useState(
    () => typeof document !== 'undefined' && Boolean(document.fullscreenElement)
  )
  const [posterVisible, setPosterVisible] = useState(true)
  /** Measured heights of the stage and the control overlay, see the effect below. */
  const [{ controls: controlsHeight, stage: stageHeight }, setStageMetrics] = useState({
    controls: 108,
    stage: 0
  })
  const [osd, setOsd] = useState<OsdState | null>(null)
  const osdTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (osdTimerRef.current) window.clearTimeout(osdTimerRef.current)
    }
  }, [])

  const showOsd = useCallback((text: string, icon?: string) => {
    if (osdTimerRef.current) window.clearTimeout(osdTimerRef.current)
    const id = Date.now()
    setOsd({ id, text, icon })
    osdTimerRef.current = window.setTimeout(() => setOsd(null), 850)
  }, [])

  // Sleep Timer state & handlers
  const { minutes: sleepTimerMinutes, remainingSec: sleepTimerRemainingSec } = useSleepTimer()

  useEffect(() => {
    return registerActivePlayer(videoRef.current, showOsd)
  }, [showOsd])

  const handleSetSleepTimer = useCallback((minutes: number | null) => {
    setSleepTimer(minutes, videoRef.current)
  }, [])

  // Update remaining seconds if set to end of video on timeupdate
  useEffect(() => {
    if (sleepTimerMinutes !== -1) return
    const v = videoRef.current
    if (!v) return
    const updateEndRemaining = (): void => {
      if (v.duration > 0) {
        updateEndOfVideoRemaining(Math.max(0, Math.round(v.duration - v.currentTime)))
      }
    }
    updateEndRemaining()
    v.addEventListener('timeupdate', updateEndRemaining)
    return () => v.removeEventListener('timeupdate', updateEndRemaining)
  }, [sleepTimerMinutes])

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

  // Shaka Player Hook (DASH, Variant tracks, Audio tracks, Captions, Watchdog)
  const shaka = useShakaPlayer({
    videoRef,
    containerRef,
    videoId,
    manifestUrl,
    isLive,
    startPosition,
    autoplay,
    preferredQuality,
    alwaysShowCaptions,
    defaultAudioLanguage,
    captions,
    initialVolume: initialVolume ?? 1,
    safeInitialSpeed,
    preservePitch,
    scrubbingRef,
    onTimeUpdate: props.onTimeUpdate,
    onEnded: props.onEnded,
    maybeSkip,
    onCaptionsToggle: props.onCaptionsToggle,
    onOsd: showOsd
  })

  // Shaka's own `isLive()` is authoritative once the manifest is parsed; the
  // `isLive` prop is only a parse-time configuration hint. Everything below is
  // keyed off the runtime value so a mislabelled hint cannot produce a VOD UI
  // on a live stream (or vice versa).
  const liveStream = shaka.status === 'ready' ? shaka.live : Boolean(isLive || shaka.live)
  const visibleChapters = liveStream ? EMPTY_CHAPTERS : chapters
  const visibleSegments = liveStream ? EMPTY_SEGMENTS : segments

  // Audio Graph Hook (Gain 0-300%, DynamicsCompressor, SilenceSkipper)
  const audioGraph = usePlayerAudioGraph({
    videoRef,
    isLive: liveStream,
    initialVolume,
    initialSpeed: safeInitialSpeed,
    preservePitch,
    skipSilence: liveStream ? false : skipSilence,
    playing: shaka.playing,
    status: shaka.status,
    onPitchChange,
    onSkipSilenceChange,
    onRateChange: props.onSpeedChange,
    onVolumeChange: props.onVolumeChange,
    onOsd: showOsd
  })

  // Fullscreen sync
  useEffect(() => {
    const onFsChange = (): void => {
      const isFs = Boolean(document.fullscreenElement)
      setFullscreen(isFs)
      props.onFullscreenChange?.(isFs)
    }
    setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [props.onFullscreenChange])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      showOsd('Exit fullscreen', 'fullscreenExit')
    } else {
      void document.documentElement.requestFullscreen().catch(() => undefined)
      showOsd('Fullscreen', 'fullscreen')
    }
  }, [showOsd])

  const togglePip = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture()
      showOsd('Picture-in-picture off', 'pip')
    } else {
      void video.requestPictureInPicture().catch(() => undefined)
      showOsd('Picture-in-picture on', 'pip')
    }
  }, [showOsd])

  // Sleep timer: pause if set to end of video
  useEffect(() => {
    if (sleepTimerMinutes !== -1) return
    const video = videoRef.current
    if (!video) return
    const onEnded = (): void => {
      onEndOfVideoReached(video)
    }
    video.addEventListener('ended', onEnded)
    return () => video.removeEventListener('ended', onEnded)
  }, [sleepTimerMinutes])

  const menuRef = useRef<MenuKind | null>(menu)
  menuRef.current = menu

  // Controls & cursor auto-hide: while any menu is open, the overlay must stay visible and not auto-hide
  const revealControls = useCallback(
    (revealCursor = true): void => {
      setControlsVisible(true)
      if (revealCursor) {
        setCursorHidden(false)
      }
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
      if (shaka.playing && menu === null) {
        hideTimerRef.current = window.setTimeout(() => {
          setControlsVisible(false)
          setCursorHidden(true)
          hideTimerRef.current = null
        }, CONTROLS_AUTOHIDE_DELAY)
      }
    },
    [shaka.playing, menu]
  )

  const onScrubStart = useCallback(() => {
    scrubbingRef.current = true
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    setControlsVisible(true)
    setCursorHidden(false)
  }, [])

  const onScrubEnd = useCallback(() => {
    scrubbingRef.current = false
    revealControls(true)
  }, [revealControls])

  useEffect(() => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }

    if (!shaka.playing || menu !== null) {
      setControlsVisible(true)
      setCursorHidden(false)
      return
    }

    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false)
      setCursorHidden(true)
      hideTimerRef.current = null
    }, CONTROLS_AUTOHIDE_DELAY)

    return () => {
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [shaka.playing, menu])

  // Subtitle positioning relative to controls
  useEffect(() => {
    const container = containerRef.current
    const overlay = overlayEl
    if (!container) return

    const update = (): void => {
      const containerRect = container.getBoundingClientRect()
      const stageH = Math.round(containerRect.height)

      let controlsH = 108
      if (overlay) {
        const overlayRect = overlay.getBoundingClientRect()
        const seekEl = overlay.querySelector('.seek')
        const seekRect = seekEl?.getBoundingClientRect()

        // Distance from bottom of player to top of seek bar / controls overlay
        if (seekRect && containerRect.bottom >= seekRect.top) {
          controlsH = Math.max(overlayRect.height, Math.round(containerRect.bottom - seekRect.top))
        } else if (overlayRect.height > 0) {
          controlsH = Math.round(overlayRect.height)
        }
      }

      setStageMetrics({
        controls: Math.max(96, controlsH),
        stage: stageH
      })
    }

    update()

    const observer = new ResizeObserver(update)
    observer.observe(container)
    if (overlay) {
      observer.observe(overlay)
    }

    window.addEventListener('resize', update)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [containerRef, overlayEl])

  // Hide poster once video advances
  useEffect(() => {
    if (posterVisible && shaka.currentTime > 0.1) setPosterVisible(false)
  }, [posterVisible, shaka.currentTime])

  // Chapter navigation
  const seekToPreviousChapter = useCallback(() => {
    // A live stream has no chapter markers and its presentation timeline is a
    // sliding DVR window, so "previous" means "back to the start of the window
    // we can still seek into" — the same affordance the DVR scrubber gives.
    if (shaka.live) {
      if (shaka.liveWindow) shaka.seekTo(shaka.liveWindow.start)
      return
    }
    if (chapters.length === 0) {
      shaka.seekTo(0)
      return
    }
    const current = chapters.find(
      (c) => shaka.currentTime >= c.start && shaka.currentTime < c.end
    )
    if (!current) {
      shaka.seekTo(0)
      return
    }
    if (shaka.currentTime - current.start > 3) {
      shaka.seekTo(current.start)
      showOsd(`Chapter: ${current.title}`, 'chapters')
    } else {
      const idx = chapters.indexOf(current)
      const prev = chapters[Math.max(0, idx - 1)]
      shaka.seekTo(prev.start)
      showOsd(`Chapter: ${prev.title}`, 'chapters')
    }
  }, [chapters, shaka, showOsd])

  const seekToNextChapter = useCallback(() => {
    // Symmetrically, "next" for a live stream is "catch up to the live edge".
    if (shaka.live) {
      shaka.goToLive()
      return
    }
    if (chapters.length === 0) return
    const current = chapters.find(
      (c) => shaka.currentTime >= c.start && shaka.currentTime < c.end
    )
    if (!current) {
      shaka.seekTo(chapters[0].start)
      showOsd(`Chapter: ${chapters[0].title}`, 'chapters')
      return
    }
    const idx = chapters.indexOf(current)
    if (idx < chapters.length - 1) {
      const next = chapters[idx + 1]
      shaka.seekTo(next.start)
      showOsd(`Chapter: ${next.title}`, 'chapters')
    }
  }, [chapters, shaka, showOsd])

  // Imperative handle
  useImperativeHandle(
    ref,
    (): PlayerHandle => ({
      seekTo: shaka.seekTo,
      seekBy: shaka.seekBy,
      play: () => videoRef.current?.play().catch(() => undefined),
      pause: () => videoRef.current?.pause(),
      nextChapter: seekToNextChapter,
      previousChapter: seekToPreviousChapter,
      unskip: (segment: SponsorSegment) => {
        skipRef.current.set(segment.uuid, 'unskipped')
        shaka.seekTo(segment.segment[0])
      }
    }),
    [shaka.seekTo, shaka.seekBy, seekToNextChapter, seekToPreviousChapter]
  )

  // Media Session (SMTC)
  const media = props.mediaSession
  const mediaHandlers = useMemo(
    () => ({
      play: () => videoRef.current?.play().catch(() => undefined),
      pause: () => videoRef.current?.pause(),
      seekBackward: (seconds: number) => shaka.seekBy(-seconds),
      seekForward: (seconds: number) => shaka.seekBy(seconds),
      seekTo: (time: number) => shaka.seekTo(time),
      previous: media?.onPreviousTrack ?? seekToPreviousChapter,
      next: media?.onNextTrack ?? seekToNextChapter
    }),
    [shaka.seekBy, shaka.seekTo, media?.onPreviousTrack, media?.onNextTrack, seekToPreviousChapter, seekToNextChapter]
  )

  useMediaSession(
    {
      title: media?.title ?? props.videoId,
      artist: media?.artist ?? '',
      album: media?.album,
      artwork: media?.artwork ?? props.poster ?? null,
      playing: shaka.playing,
      position: shaka.currentTime,
      duration: shaka.duration,
      active: Boolean(media) && shaka.status === 'ready'
    },
    mediaHandlers
  )

  // Menus
  const closeMenu = useCallback((): void => {
    setMenu(null)
    setMenuAnchor(null)
  }, [])

  const toggleMenu = useCallback(
    (kind: MenuKind, element: HTMLElement): void => {
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
      setControlsVisible(true)
      setCursorHidden(false)
      if (menu === kind) {
        closeMenu()
        return
      }
      setMenu(kind)
      setMenuAnchor(element)
    },
    [menu, closeMenu]
  )

  useEffect(() => {
    if (isMini && menu !== null) {
      closeMenu()
    }
  }, [isMini, menu, closeMenu])

  // Hotkeys Hook
  usePlayerHotkeys({
    containerRef,
    duration: shaka.duration,
    volume: audioGraph.volume,
    chapters,
    menuOpen: menu !== null,
    hasError: shaka.status === 'error',
    fullscreen,
    isMini,
    onExpand,
    onClose,
    onDismissError: shaka.dismissError,
    onTogglePlay: shaka.togglePlay,
    onSeekBy: shaka.seekBy,
    onSeekTo: shaka.seekTo,
    onPreviousChapter: seekToPreviousChapter,
    onNextChapter: seekToNextChapter,
    onChangeVolume: audioGraph.changeVolume,
    onToggleMute: audioGraph.toggleMute,
    onToggleFullscreen: toggleFullscreen,
    onToggleCaptions: shaka.toggleCaptions,
    onTogglePip: togglePip,
    onStepSpeed: audioGraph.stepSpeed,
    onCloseMenu: closeMenu,
    onRevealControls: () => revealControls(false),
    onPreviousVideo: props.playlistNavigation?.onPrevious,
    onNextVideo: props.playlistNavigation?.onNext
  })

  const lastFullscreenToggleRef = useRef(0)

  // Player click & double click controller
  const handlePlayerClick = useCallback(
    (e: React.MouseEvent): void => {
      // Ignore clicks on controls, seekbar, and popovers
      const target = e.target as HTMLElement | null
      if (
        target?.closest(
          'button, input, select, textarea, a, .seek, .menu, .sheet, .miniplayer__header, .miniplayer__actions, .miniplayer__center, .player__error'
        )
      ) {
        return
      }

      // If text was selected (e.g. subtitle, chapter, title), do not toggle play
      const sel = window.getSelection()
      if (sel && sel.toString().trim().length > 0) {
        return
      }

      if (menuRef.current !== null) {
        closeMenu()
        return
      }

      if (isMini) {
        shaka.togglePlay()
        return
      }

      // Double-click detection via browser detail counter
      if (e.detail >= 2) {
        if (clickTimerRef.current != null) {
          window.clearTimeout(clickTimerRef.current)
          clickTimerRef.current = null
        }
        if (Date.now() - lastFullscreenToggleRef.current > 300) {
          lastFullscreenToggleRef.current = Date.now()
          toggleFullscreen()
        }
        return
      }

      if (e.detail === 1) {
        if (clickTimerRef.current != null) {
          window.clearTimeout(clickTimerRef.current)
        }
        clickTimerRef.current = window.setTimeout(() => {
          clickTimerRef.current = null
          shaka.togglePlay()
        }, 250)
      }
    },
    [shaka, closeMenu, isMini, toggleFullscreen]
  )

  const handlePlayerDoubleClick = useCallback(
    (e: React.MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (
        target?.closest(
          'button, input, select, textarea, a, .seek, .menu, .sheet, .miniplayer__header, .miniplayer__actions, .miniplayer__center, .player__error'
        )
      ) {
        return
      }

      const sel = window.getSelection()
      if (sel && sel.toString().trim().length > 0) {
        return
      }

      if (clickTimerRef.current != null) {
        window.clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }

      if (isMini) {
        // Per user preference: double-clicking only operates on the normal player
        return
      }

      if (Date.now() - lastFullscreenToggleRef.current > 300) {
        lastFullscreenToggleRef.current = Date.now()
        toggleFullscreen()
      }
    },
    [isMini, toggleFullscreen]
  )

  const isControlsVisible = controlsVisible || menu !== null

  const isCursorHidden =
    cursorHidden &&
    shaka.playing &&
    !shaka.busy &&
    shaka.status === 'ready' &&
    !isMini &&
    menu === null &&
    !scrubbingRef.current

  const handlePointerMove = useCallback(
    (e: React.PointerEvent): void => {
      if (e.clientX === lastPointerPosRef.current.x && e.clientY === lastPointerPosRef.current.y) {
        return
      }
      lastPointerPosRef.current = { x: e.clientX, y: e.clientY }
      revealControls(true)
    },
    [revealControls]
  )

  const handlePointerDown = useCallback((): void => {
    revealControls(true)
  }, [revealControls])

  const handlePointerEnter = useCallback(
    (e: React.PointerEvent): void => {
      lastPointerPosRef.current = { x: e.clientX, y: e.clientY }
      revealControls(true)
    },
    [revealControls]
  )

  const handlePointerLeave = useCallback((): void => {
    lastPointerPosRef.current = { x: -1, y: -1 }
    setCursorHidden(false)
    if (shaka.playing && menu === null) {
      setControlsVisible(false)
    }
  }, [shaka.playing, menu])

  /**
   * Captions are absolutely positioned inside the stage, so their bottom offset
   * has to track the control overlay: it grows while the seek bar and buttons
   * are on screen, which is exactly when it would otherwise cover the text.
   */
  const subtitleVars = useMemo<React.CSSProperties>(() => {
    const resting = Math.max(SUBTITLE_RESTING_GAP, Math.round(stageHeight * 0.04))
    const bottom = isControlsVisible
      ? Math.max(resting, controlsHeight + SUBTITLE_CLEARANCE)
      : resting
    return {
      '--subtitles-bottom': `${bottom}px`,
      ...subtitleCssVars(subtitleStyle, stageHeight)
    } as React.CSSProperties
  }, [controlsHeight, isControlsVisible, stageHeight, subtitleStyle])

  const activeChapterRef = useRef<Chapter | null>(null)
  const currentChapter = useMemo(() => {
    if (!chapters || chapters.length === 0 || !isControlsVisible) return null
    const time = shaka.currentTime
    const prev = activeChapterRef.current
    if (prev && time >= prev.start && time < prev.end) {
      return prev
    }
    const found =
      chapters.find((c) => time >= c.start && time < c.end) ??
      chapters[chapters.length - 1] ??
      null
    activeChapterRef.current = found
    return found
  }, [chapters, shaka.currentTime, isControlsVisible])

  const onSelectHeightMenu = useCallback((h: number) => {
    shaka.selectHeight(h)
    closeMenu()
  }, [shaka.selectHeight, closeMenu])

  const onSelectCaptionMenu = useCallback((id: number | null) => {
    shaka.selectCaption(id)
    closeMenu()
  }, [shaka.selectCaption, closeMenu])

  const onSelectAudioMenu = useCallback((code: string) => {
    shaka.selectAudio(code)
    closeMenu()
  }, [shaka.selectAudio, closeMenu])

  const onSelectAudioTierMenu = useCallback((tier: string | null) => {
    shaka.selectAudioTier(tier)
    closeMenu()
  }, [shaka.selectAudioTier, closeMenu])

  return (
    <div
      ref={containerRef}
      className={`player${fullscreen ? ' player--fullscreen' : ''}${
        isCursorHidden ? ' player--hide-cursor' : ''
      }`}
      style={subtitleVars}
      onClick={handlePlayerClick}
      onDoubleClick={handlePlayerDoubleClick}
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <video ref={videoRef} className="player__video" playsInline />
      {poster && (
        <img
          className={`player__poster${posterVisible ? '' : ' player__poster--hidden'}`}
          src={poster}
          alt=""
        />
      )}

      {/* Loading / Buffering spinner */}
      {(shaka.status === 'loading' || shaka.busy) && shaka.status !== 'error' && (
        <div className="player__center">
          <Spinner />
          {shaka.statusText !== '' && (
            <div className="player__status">{shaka.statusText}</div>
          )}
        </div>
      )}

      {/* Error display */}
      {shaka.status === 'error' && (
        <div className="player__error" role="alert">
          <button
            type="button"
            className="player__error-close"
            onClick={shaka.dismissError}
            aria-label="Dismiss error"
            title="Dismiss error"
          >
            <Icon name="close" size={18} />
          </button>
          <span className="player__error-icon">
            <Icon name="info" size={28} />
          </span>
          <div>
            <p className="player__error-title">{shaka.errorTitle || 'Playback interrupted'}</p>
            <p>{shaka.errorMsg || 'Unable to play this video.'}</p>
            {shaka.errorCode && (
              <span className="player__error-code">Error code: {shaka.errorCode}</span>
            )}
          </div>
          <div className="player__error-actions">
            <button
              type="button"
              className="btn btn--filled btn--sm"
              onClick={shaka.retryPlayback}
            >
              <Icon name="refresh" size={16} />
              Retry
            </button>
            {fullscreen && (
              <button
                type="button"
                className="btn btn--tonal btn--sm"
                onClick={toggleFullscreen}
              >
                <Icon name="fullscreenExit" size={16} />
                Exit fullscreen
              </button>
            )}
            <button
              type="button"
              className="btn btn--tonal btn--sm"
              onClick={shaka.dismissError}
            >
              <Icon name="close" size={16} />
              Dismiss
            </button>
            <button
              type="button"
              className="btn btn--text btn--sm"
              onClick={() => window.history.back()}
            >
              <Icon name="back" size={16} />
              Go back
            </button>
          </div>
        </div>
      )}

      {shaka.status === 'ready' && (
        <>
          <div className="player__stage" />

          {/* Ephemeral HUD / OSD badge */}
          <PlayerOsd osd={osd} isMini={isMini} />

          {isMini ? (
            <MiniPlayerControls
              playing={shaka.playing}
              currentTime={shaka.currentTime}
              duration={shaka.duration}
              isLive={liveStream}
              behindLive={shaka.behindLive}
              liveWindow={
                liveStream && shaka.liveWindow
                  ? {
                      ...shaka.liveWindow,
                      behind: shaka.behindLive
                    }
                  : null
              }
              buffered={shaka.buffered}
              chapters={visibleChapters}
              segments={visibleSegments}
              title={title}
              author={author}
              visible={isControlsVisible}
              playlistNavigation={props.playlistNavigation}
              onTogglePlay={shaka.togglePlay}
              onSeek={shaka.seekTo}
              onScrubStart={onScrubStart}
              onScrubEnd={onScrubEnd}
              onExpand={onExpand}
              onClose={onClose}
              onHeaderPointerDown={props.onMiniHeaderPointerDown}
              onResizePointerDown={props.onMiniResizePointerDown}
            />
          ) : (
            <>
              {/* Big center play button when paused */}
              <div
                className={`player__center player__center--play${
                  !shaka.playing && !shaka.busy ? ' player__center--play-visible' : ''
                }`}
                aria-hidden={shaka.playing || shaka.busy}
              >
                <button
                  className="player__big-play"
                  aria-label="Play"
                  onClick={(e) => {
                    e.stopPropagation()
                    shaka.togglePlay()
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (Date.now() - lastFullscreenToggleRef.current > 300) {
                      lastFullscreenToggleRef.current = Date.now()
                      toggleFullscreen()
                    }
                  }}
                  tabIndex={!shaka.playing && !shaka.busy ? 0 : -1}
                >
                  <Icon name="play" size={34} />
                </button>
              </div>

              {/* Floating Controls Overlay */}
              <div
                ref={setOverlayRef}
                className={`player__overlay${
                  isControlsVisible ? '' : ' player__overlay--hidden'
                }`}
              >
            <SeekBar
              duration={shaka.duration}
              currentTime={isControlsVisible ? shaka.currentTime : 0}
              buffered={shaka.buffered}
              chapters={visibleChapters}
              segments={visibleSegments}
              live={
                liveStream && shaka.liveWindow
                  ? {
                      ...shaka.liveWindow,
                      behind: shaka.behindLive
                    }
                  : null
              }
              onSeek={shaka.seekTo}
              onScrubStart={onScrubStart}
              onScrubEnd={onScrubEnd}
            />

            <PlayerControls
              playing={shaka.playing}
              muted={audioGraph.muted}
              volume={audioGraph.volume}
              displayTime={isControlsVisible ? shaka.currentTime : 0}
              duration={shaka.duration}
              isLive={liveStream}
              behindLive={shaka.behindLive}
              hasChapters={visibleChapters.length > 0}
              currentChapter={currentChapter}
              textTracks={shaka.textTracks}
              textVisible={shaka.textVisible}
              audioTracks={shaka.audioTracks}
              skipSilence={liveStream ? false : skipSilence}
              sleepTimerActive={sleepTimerMinutes !== null}
              fullscreen={fullscreen}
              activeMenu={menu}
              playlistNavigation={props.playlistNavigation}
              onTogglePlay={shaka.togglePlay}
              onToggleMute={audioGraph.toggleMute}
              onChangeVolume={audioGraph.changeVolume}
              onToggleMenu={toggleMenu}
              onTogglePip={togglePip}
              onToggleFullscreen={toggleFullscreen}
              onGoToLive={shaka.goToLive}
            />
          </div>

          {/* Popover Menus & Sheets - only mounted when actively opened */}
          {menu !== null && (
            <PlayerMenus
              menu={menu}
              menuAnchor={menuAnchor}
              onClose={closeMenu}
              isLive={liveStream}
              rate={audioGraph.rate}
              onChangeRate={audioGraph.changeRate}
              preservePitch={preservePitch}
              onTogglePitch={audioGraph.togglePitch}
              skipSilence={liveStream ? false : skipSilence}
              onToggleSkipSilence={audioGraph.toggleSkipSilence}
              levelHeights={shaka.levelHeights}
              selectedHeight={shaka.selectedHeight}
              selectedAudioTier={shaka.selectedAudioTier}
              onSelectStream={shaka.selectStream}
              onSelectHeight={onSelectHeightMenu}
              textTracks={shaka.textTracks}
              textVisible={shaka.textVisible}
              activeTextId={shaka.activeTextId}
              onSelectCaption={onSelectCaptionMenu}
              subtitleStyle={subtitleStyle}
              onSubtitleStyleChange={onSubtitleStyleChange}
              audioTracks={shaka.audioTracks}
              audioLanguages={shaka.audioLanguages}
              selectedAudioLang={shaka.selectedAudioLang}
              audioTiers={shaka.audioTiers}
              isOriginalLanguage={shaka.isOriginalLanguage}
              onSelectAudio={onSelectAudioMenu}
              onSelectAudioTier={onSelectAudioTierMenu}
              onOpenMenu={(kind) => setMenu(kind)}
              onTogglePip={togglePip}
              sleepTimerMinutes={sleepTimerMinutes}
              sleepTimerRemainingSec={sleepTimerRemainingSec}
              onSetSleepTimer={handleSetSleepTimer}
            />
          )}
        </>
      )}
    </>
  )}
</div>
  )
})
