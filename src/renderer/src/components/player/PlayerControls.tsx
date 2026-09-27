import { memo } from 'react'
import { Icon } from '../Icons'
import { formatTime as fmt } from '../../lib/format'
import type { AudioTrack, Chapter, MenuKind, TextTrack } from './types'

export interface PlayerControlsProps {
  playing: boolean
  muted: boolean
  volume: number
  displayTime: number
  duration: number
  hasChapters: boolean
  currentChapter: Chapter | null
  textTracks: TextTrack[]
  textVisible: boolean
  audioTracks: AudioTrack[]
  skipSilence: boolean
  fullscreen: boolean
  onTogglePlay: () => void
  onToggleMute: () => void
  onChangeVolume: (volume: number) => void
  onToggleMenu: (kind: MenuKind, anchor: HTMLElement) => void
  onTogglePip: () => void
  onToggleFullscreen: () => void
}

export const PlayerControls = memo(function PlayerControls({
  playing,
  muted,
  volume,
  displayTime,
  duration,
  hasChapters,
  currentChapter,
  textTracks,
  textVisible,
  audioTracks,
  skipSilence,
  fullscreen,
  onTogglePlay,
  onToggleMute,
  onChangeVolume,
  onToggleMenu,
  onTogglePip,
  onToggleFullscreen
}: PlayerControlsProps): React.JSX.Element {
  return (
    <div className="player__controls">
      {/* Play/Pause */}
      <button
        className="icon-btn"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={onTogglePlay}
      >
        <Icon name={playing ? 'pause' : 'play'} size={24} />
      </button>

      {/* Volume group */}
      <div className="player__volume">
        <button
          className="icon-btn"
          aria-label={muted ? 'Unmute' : 'Mute'}
          onClick={onToggleMute}
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

      {/* Time display */}
      <span className="player__time">
        {fmt(displayTime)} <span className="player__time-total">/ {fmt(duration)}</span>
      </span>

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

      {/* Captions button */}
      {textTracks.length > 0 && (
        <button
          className={`icon-btn${textVisible ? ' icon-btn--active' : ''}`}
          aria-label="Subtitles"
          title="Subtitles"
          onClick={(event) => onToggleMenu('captions', event.currentTarget)}
        >
          <Icon name="captions" size={22} />
        </button>
      )}

      {/* Playback settings button */}
      <button
        className={`icon-btn${skipSilence ? ' icon-btn--active' : ''}`}
        aria-label="Playback settings"
        title="Playback settings"
        onClick={(event) => onToggleMenu('settings', event.currentTarget)}
      >
        <Icon name="tune" size={22} />
      </button>

      {/* Audio track button */}
      {audioTracks.length > 0 && (
        <button
          className="icon-btn"
          aria-label="Audio track"
          title="Audio track"
          onClick={(event) => onToggleMenu('audio', event.currentTarget)}
        >
          <Icon name="volume" size={22} />
        </button>
      )}

      {/* Quality button */}
      <button
        className="icon-btn"
        aria-label="Quality"
        title="Quality"
        onClick={(event) => onToggleMenu('quality', event.currentTarget)}
      >
        <Icon name="hd" size={22} />
      </button>

      {/* PiP button */}
      <button
        className="icon-btn"
        aria-label="Picture in picture"
        title="Picture in picture"
        onClick={onTogglePip}
      >
        <Icon name="pip" size={22} />
      </button>

      {/* Fullscreen button */}
      <button
        className="icon-btn"
        aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        onClick={onToggleFullscreen}
      >
        <Icon name={fullscreen ? 'fullscreenExit' : 'fullscreen'} size={22} />
      </button>
    </div>
  )
})
