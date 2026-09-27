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
import { useMediaSession } from '../lib/mediaSession'
import { PlayerOsd } from './player/PlayerOsd'
import { SeekBar } from './player/SeekBar'
import { PlayerControls } from './player/PlayerControls'
import { PlayerMenus } from './player/PlayerMenus'
import { usePlayerAudioGraph } from './player/usePlayerAudioGraph'
import { useShakaPlayer } from './player/useShakaPlayer'
import { usePlayerHotkeys } from './player/usePlayerHotkeys'
import type {
  MenuKind,
  OsdState,
  PlayerHandle,
  PlayerProps
} from './player/types'
import type { SponsorSegment } from '../../../shared/types'

export type { PlayerHandle, PlayerProps }

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  props,
  ref
): React.JSX.Element {
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

  const safeInitialSpeed =
    Number.isFinite(initialSpeed) && initialSpeed >= 0.25 ? initialSpeed : 1

  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
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
  const [menu, setMenu] = useState<MenuKind | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [posterVisible, setPosterVisible] = useState(true)
  const [subtitlesBottom, setSubtitlesBottom] = useState(118)
  const [osd, setOsd] = useState<OsdState | null>(null)
  const osdTimerRef = useRef<number | null>(null)

  const showOsd = useCallback((text: string, icon?: string) => {
    if (osdTimerRef.current) window.clearTimeout(osdTimerRef.current)
    const id = Date.now()
    setOsd({ id, text, icon })
    osdTimerRef.current = window.setTimeout(() => setOsd(null), 800)
  }, [])

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

  // Audio Graph Hook (Gain 0-300%, DynamicsCompressor, SilenceSkipper)
  const audioGraph = usePlayerAudioGraph({
    videoRef,
    initialVolume,
    initialSpeed: safeInitialSpeed,
    preservePitch,
    skipSilence,
    playing: false, // updated below
    status: 'loading', // updated below
    onPitchChange,
    onSkipSilenceChange,
    onOsd: showOsd
  })

  // Shaka Player Hook (DASH, Variant tracks, Audio tracks, Captions, Watchdog)
  const shaka = useShakaPlayer({
    videoRef,
    videoId,
    manifestUrl,
    startPosition,
    autoplay,
    preferredQuality,
    alwaysShowCaptions,
    defaultAudioLanguage,
    captions,
    initialVolume: audioGraph.volume,
    safeInitialSpeed,
    preservePitch,
    scrubbingRef,
    onTimeUpdate: props.onTimeUpdate,
    onEnded: props.onEnded,
    maybeSkip,
    onOsd: showOsd
  })

  // Fullscreen sync
  useEffect(() => {
    const onFsChange = (): void => {
      setFullscreen(document.fullscreenElement === containerRef.current)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      showOsd('Exit fullscreen', 'fullscreenExit')
    } else {
      void el.requestFullscreen().catch(() => undefined)
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

  // Controls auto-hide
  const revealControls = useCallback((): void => {
    setControlsVisible(true)
    if (hideTimerRef.current != null) window.clearTimeout(hideTimerRef.current)
    if (shaka.playing && !menu) {
      hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2600)
    }
  }, [shaka.playing, menu])

  useEffect(() => {
    if (!shaka.playing) {
      setControlsVisible(true)
      if (hideTimerRef.current != null) window.clearTimeout(hideTimerRef.current)
    } else if (!menu) {
      hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2600)
    }
  }, [shaka.playing, menu])

  // Subtitle positioning relative to controls
  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    const update = (): void => {
      const h = overlay.getBoundingClientRect().height
      setSubtitlesBottom(Math.max(72, Math.round(h + 20)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(overlay)
    return () => observer.disconnect()
  }, [])

  // Hide poster once video advances
  useEffect(() => {
    if (shaka.currentTime > 0.1) setPosterVisible(false)
  }, [shaka.currentTime])

  // Chapter navigation
  const seekToPreviousChapter = useCallback(() => {
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
    {
      play: () => videoRef.current?.play().catch(() => undefined),
      pause: () => videoRef.current?.pause(),
      seekBackward: (seconds) => shaka.seekBy(-seconds),
      seekForward: (seconds) => shaka.seekBy(seconds),
      seekTo: (time) => shaka.seekTo(time),
      previous: media?.onPreviousTrack ?? seekToPreviousChapter,
      next: media?.onNextTrack ?? seekToNextChapter
    }
  )

  // Hotkeys Hook
  usePlayerHotkeys({
    containerRef,
    duration: shaka.duration,
    volume: audioGraph.volume,
    chapters,
    menuOpen: menu !== null,
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
    onCloseMenu: () => setMenu(null),
    onRevealControls: revealControls
  })

  // Stage click/double click
  const onStageClick = useCallback((): void => {
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
      return
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      shaka.togglePlay()
    }, 240)
  }, [shaka])

  const onStageDoubleClick = useCallback((): void => {
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    toggleFullscreen()
  }, [toggleFullscreen])

  // Menus
  const closeMenu = useCallback((): void => {
    setMenu(null)
    setMenuAnchor(null)
  }, [])

  const toggleMenu = useCallback(
    (kind: MenuKind, element: HTMLElement): void => {
      if (menu === kind) {
        closeMenu()
        return
      }
      setMenu(kind)
      setMenuAnchor(element)
    },
    [menu, closeMenu]
  )

  const currentChapter = useMemo(() => {
    if (!chapters || chapters.length === 0) return null
    return (
      chapters.find((c) => shaka.currentTime >= c.start && shaka.currentTime < c.end) ??
      chapters[chapters.length - 1] ??
      null
    )
  }, [chapters, shaka.currentTime])

  return (
    <div
      ref={containerRef}
      className={`player${fullscreen ? ' player--fullscreen' : ''}`}
      style={{ '--subtitles-bottom': `${subtitlesBottom}px` } as React.CSSProperties}
      onPointerMove={revealControls}
      onPointerLeave={() => {
        if (shaka.playing && !menu) setControlsVisible(false)
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

      {/* Loading / Buffering spinner */}
      {(shaka.status === 'loading' || shaka.busy) && shaka.status !== 'error' && (
        <div className="player__center">
          <div className="spinner" />
          {shaka.statusText !== '' && (
            <div className="player__status">{shaka.statusText}</div>
          )}
        </div>
      )}

      {/* Error display */}
      {shaka.status === 'error' && (
        <div className="player__error">
          <div>
            <p className="player__error-title">Unable to play this video</p>
            <p>{shaka.errorMsg}</p>
          </div>
        </div>
      )}

      {shaka.status === 'ready' && (
        <>
          <div
            className="player__stage"
            onClick={onStageClick}
            onDoubleClick={onStageDoubleClick}
          />

          {/* Big center play button when paused */}
          {!shaka.playing && !shaka.busy && (
            <div className="player__center">
              <button
                className="player__big-play"
                aria-label="Play"
                onClick={shaka.togglePlay}
              >
                <Icon name="play" size={34} />
              </button>
            </div>
          )}

          {/* Ephemeral HUD / OSD badge */}
          <PlayerOsd osd={osd} />

          {/* Floating Controls Overlay */}
          <div
            ref={overlayRef}
            className={`player__overlay${
              controlsVisible ? '' : ' player__overlay--hidden'
            }`}
          >
            <SeekBar
              duration={shaka.duration}
              currentTime={shaka.currentTime}
              buffered={shaka.buffered}
              chapters={chapters}
              segments={segments}
              onSeek={shaka.seekTo}
              onScrubStart={() => {
                scrubbingRef.current = true
              }}
              onScrubEnd={() => {
                scrubbingRef.current = false
                revealControls()
              }}
            />

            <PlayerControls
              playing={shaka.playing}
              muted={audioGraph.muted}
              volume={audioGraph.volume}
              displayTime={shaka.currentTime}
              duration={shaka.duration}
              hasChapters={Boolean(chapters && chapters.length > 0)}
              currentChapter={currentChapter}
              textTracks={shaka.textTracks}
              textVisible={shaka.textVisible}
              audioTracks={shaka.audioTracks}
              skipSilence={skipSilence}
              fullscreen={fullscreen}
              onTogglePlay={shaka.togglePlay}
              onToggleMute={audioGraph.toggleMute}
              onChangeVolume={audioGraph.changeVolume}
              onToggleMenu={toggleMenu}
              onTogglePip={togglePip}
              onToggleFullscreen={toggleFullscreen}
            />
          </div>

          {/* Popover Menus & Sheets */}
          <PlayerMenus
            menu={menu}
            menuAnchor={menuAnchor}
            onClose={closeMenu}
            rate={audioGraph.rate}
            onChangeRate={audioGraph.changeRate}
            preservePitch={preservePitch}
            onTogglePitch={audioGraph.togglePitch}
            skipSilence={skipSilence}
            onToggleSkipSilence={audioGraph.toggleSkipSilence}
            levelHeights={shaka.levelHeights}
            selectedHeight={shaka.selectedHeight}
            selectedAudioTier={shaka.selectedAudioTier}
            onSelectStream={shaka.selectStream}
            onSelectHeight={(h) => {
              shaka.selectHeight(h)
              closeMenu()
            }}
            textTracks={shaka.textTracks}
            textVisible={shaka.textVisible}
            activeTextId={shaka.activeTextId}
            onSelectCaption={(id) => {
              shaka.selectCaption(id)
              closeMenu()
            }}
            audioTracks={shaka.audioTracks}
            audioLanguages={shaka.audioLanguages}
            selectedAudioLang={shaka.selectedAudioLang}
            audioTiers={shaka.audioTiers}
            isOriginalLanguage={shaka.isOriginalLanguage}
            onSelectAudio={(code) => {
              shaka.selectAudio(code)
              closeMenu()
            }}
            onSelectAudioTier={(tier) => {
              shaka.selectAudioTier(tier)
              closeMenu()
            }}
          />
        </>
      )}
    </div>
  )
})
