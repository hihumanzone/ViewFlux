import { memo, useCallback, useEffect, useState } from 'react'
import { Icon } from '../Icons'
import { formatTime as fmt } from '../../lib/format'
import type { AudioTrack, Chapter, MenuKind, PlaylistNavigation, TextTrack } from './types'

export interface PlayerControlsProps {
  playing: boolean
  muted: boolean
  volume: number
  displayTime: number
  duration: number
  /** Live stream: `duration` is 0 and the clock is replaced by a LIVE badge. */
  isLive: boolean
  /** Seconds between the playhead and the live edge. */
  behindLive: number
  hasChapters: boolean
  currentChapter: Chapter | null
  textTracks: TextTrack[]
  textVisible: boolean
  audioTracks: AudioTrack[]
  skipSilence: boolean
  fullscreen: boolean
  activeMenu?: MenuKind | null
  playlistNavigation?: PlaylistNavigation | null
  onTogglePlay: () => void
  onToggleMute: () => void
  onChangeVolume: (volume: number) => void
  onToggleMenu: (kind: MenuKind, anchor: HTMLElement) => void
  onTogglePip: () => void
  onToggleFullscreen: () => void
  onGoToLive: () => void
}

/**
 * Normal live streaming latency naturally fluctuates between ~2s and ~6s as chunks
 * buffer and download. We apply hysteresis with an enter/exit threshold so the
 * UI never flickers or oscillates between "Live" and "Behind live":
 * - Drop out of live only when falling more than 8 seconds behind.
 * - Recover to live once within 4.5 seconds (or immediately upon clicking "Go Live").
 */
const LIVE_BEHIND_THRESHOLD = 8
const LIVE_RECOVER_THRESHOLD = 4.5

export const PlayerControls = memo(function PlayerControls({
  playing,
  muted,
  volume,
  displayTime,
  duration,
  isLive,
  behindLive,
  hasChapters,
  currentChapter,
  textTracks,
  textVisible,
  audioTracks,
  skipSilence,
  fullscreen,
  activeMenu,
  playlistNavigation,
  onTogglePlay,
  onToggleMute,
  onChangeVolume,
  onToggleMenu,
  onTogglePip,
  onToggleFullscreen,
  onGoToLive
}: PlayerControlsProps): React.JSX.Element {
  const [isBehind, setIsBehind] = useState(false)

  useEffect(() => {
    if (!isLive) {
      setIsBehind(false)
      return
    }
    if (!isBehind && behindLive > LIVE_BEHIND_THRESHOLD) {
      setIsBehind(true)
    } else if (isBehind && behindLive <= LIVE_RECOVER_THRESHOLD) {
      setIsBehind(false)
    }
  }, [isLive, behindLive, isBehind])

  const handleGoToLive = useCallback(() => {
    setIsBehind(false)
    onGoToLive()
  }, [onGoToLive])

  return (
    <div className="player__controls">
      {/* Playlist navigation: Previous */}
      {playlistNavigation && (
        <button
          type="button"
          className="icon-btn player__btn--tonal"
          aria-label="Previous video"
          title="Previous video"
          disabled={!playlistNavigation.hasPrevious}
          onClick={playlistNavigation.onPrevious}
        >
          <Icon name="skipPrevious" size={20} />
        </button>
      )}

      {/* Play/Pause */}
      <button
        type="button"
        className="icon-btn player__btn--hero"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={onTogglePlay}
      >
        <Icon name={playing ? 'pause' : 'play'} size={24} />
      </button>

      {/* Playlist navigation: Next */}
      {playlistNavigation && (
        <button
          type="button"
          className="icon-btn player__btn--tonal"
          aria-label="Next video"
          title="Next video"
          disabled={!playlistNavigation.hasNext}
          onClick={playlistNavigation.onNext}
        >
          <Icon name="skipNext" size={20} />
        </button>
      )}

      {/* Volume group */}
      <div className="player__volume">
        <button
          className="icon-btn player__btn--tonal"
          aria-label={muted ? 'Unmute' : 'Mute'}
          onClick={onToggleMute}
        >
          <Icon name={muted || volume === 0 ? 'volumeOff' : 'volume'} size={22} />
        </button>
        {/* Collapsing happens on this wrapper rather than on the slider itself */}
        <div className="player__volume-slider">
          <input
            className="slider"
            type="range"
            min={0}
            max={3}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => onChangeVolume(Number(e.target.value))}
            aria-label="Volume"
            aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} percent${
              volume > 1 ? ', amplified' : ''
            }`}
          />
          <span
            className={`player__volume-value${
              volume > 1 ? ' player__volume-value--boosted' : ''
            }`}
          >
            {Math.round((muted ? 0 : volume) * 100)}%
          </span>
        </div>
      </div>

      {/* Time display — a live stream has no total, so show the edge offset */}
      {isLive ? (
        <>
          <span
            className={`player__live-pill${isBehind ? ' player__live-pill--behind' : ''}`}
            title={isBehind ? 'Behind live — click to jump to live edge' : 'Playing at the live edge'}
            onClick={isBehind ? handleGoToLive : undefined}
            role={isBehind ? 'button' : undefined}
            tabIndex={isBehind ? 0 : undefined}
            onKeyDown={
              isBehind
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleGoToLive()
                    }
                  }
                : undefined
            }
            style={isBehind ? { cursor: 'pointer' } : undefined}
          >
            LIVE
          </span>
          {isBehind && (
            <button
              type="button"
              className="player__go-live"
              onClick={handleGoToLive}
              title="Jump to the live edge"
            >
              {behindLive >= 60
                ? `${fmt(Math.round(behindLive))} behind`
                : `${Math.round(behindLive)}s behind`}{' '}
              — go live
            </button>
          )}
        </>
      ) : (
        <span className="player__time">
          <span className="player__time-current">{fmt(displayTime)}</span>
          <span className="player__time-total"> / {fmt(duration)}</span>
        </span>
      )}

      {/* Current chapter pill */}
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

      {/* Right controls cluster */}
      <div className="player__controls-right">
        {/* Captions button (collapsible on compact) */}
        {textTracks.length > 0 && (
          <button
            className={`icon-btn player__btn--tonal player__btn--secondary${textVisible ? ' icon-btn--active' : ''}`}
            aria-label="Subtitles"
            title="Subtitles"
            aria-haspopup="menu"
            aria-expanded={activeMenu === 'captions'}
            onClick={(event) => onToggleMenu('captions', event.currentTarget)}
          >
            <Icon name="captions" size={22} />
          </button>
        )}

        {/* Playback settings button */}
        <button
          className={`icon-btn player__btn--tonal${!isLive && skipSilence ? ' icon-btn--active' : ''}`}
          aria-label="Playback settings"
          title="Playback settings"
          aria-haspopup="menu"
          aria-expanded={activeMenu === 'settings'}
          onClick={(event) => onToggleMenu('settings', event.currentTarget)}
        >
          <Icon name="tune" size={22} />
        </button>

        {/* Audio track button (collapsible on compact) */}
        {audioTracks.length > 0 && (
          <button
            className="icon-btn player__btn--tonal player__btn--secondary"
            aria-label="Audio track"
            title="Audio track"
            aria-haspopup="menu"
            aria-expanded={activeMenu === 'audio'}
            onClick={(event) => onToggleMenu('audio', event.currentTarget)}
          >
            <Icon name="volume" size={22} />
          </button>
        )}

        {/* Quality button (collapsible on compact) */}
        <button
          className="icon-btn player__btn--tonal player__btn--secondary"
          aria-label="Quality"
          title="Quality"
          aria-haspopup="menu"
          aria-expanded={activeMenu === 'quality'}
          onClick={(event) => onToggleMenu('quality', event.currentTarget)}
        >
          <Icon name="hd" size={22} />
        </button>

        {/* PiP button (collapsible on compact) */}
        <button
          className="icon-btn player__btn--tonal player__btn--secondary"
          aria-label="Picture in picture"
          title="Picture in picture"
          onClick={onTogglePip}
        >
          <Icon name="pip" size={22} />
        </button>

        {/* Overflow button (revealed only on compact layouts) */}
        <button
          className="icon-btn player__btn--tonal player__btn--more"
          aria-label="More options"
          title="More options"
          aria-haspopup="menu"
          aria-expanded={activeMenu === 'more'}
          onClick={(event) => onToggleMenu('more', event.currentTarget)}
        >
          <Icon name="more" size={22} />
        </button>

        {/* Fullscreen button */}
        <button
          className="icon-btn player__btn--tonal"
          aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={onToggleFullscreen}
        >
          <Icon name={fullscreen ? 'fullscreenExit' : 'fullscreen'} size={22} />
        </button>
      </div>
    </div>
  )
})
