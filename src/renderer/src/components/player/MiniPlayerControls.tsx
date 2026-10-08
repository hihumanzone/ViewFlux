import { memo } from 'react'
import { Icon } from '../Icons'
import { SeekBar } from './SeekBar'
import { formatTime as fmt } from '../../lib/format'
import type { Chapter, LiveWindow, PlaylistNavigation, SponsorSegment } from './types'

export interface MiniPlayerControlsProps {
  playing: boolean
  currentTime: number
  duration: number
  isLive: boolean
  behindLive: number
  liveWindow: (LiveWindow & { behind: number }) | null
  buffered: [number, number][]
  chapters?: Chapter[]
  segments: SponsorSegment[]
  title?: string
  author?: string
  visible: boolean
  playlistNavigation?: PlaylistNavigation | null
  onTogglePlay: () => void
  onSeek: (time: number) => void
  onScrubStart?: () => void
  onScrubEnd?: () => void
  onExpand?: () => void
  onClose?: () => void
  onHeaderPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void
  onResizePointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void
}

export const MiniPlayerControls = memo(function MiniPlayerControls({
  playing,
  currentTime,
  duration,
  isLive,
  behindLive: _behindLive,
  liveWindow,
  buffered,
  chapters = [],
  segments,
  title,
  author,
  visible,
  playlistNavigation,
  onTogglePlay,
  onSeek,
  onScrubStart,
  onScrubEnd,
  onExpand,
  onClose,
  onHeaderPointerDown,
  onResizePointerDown
}: MiniPlayerControlsProps): React.JSX.Element {
  const progressRatio = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0

  return (
    <div
      className={`miniplayer__controls${visible ? ' miniplayer__controls--visible' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onTogglePlay()
        }
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
      }}
    >
      {/* Corner resize handle */}
      {onResizePointerDown && (
        <div
          className="miniplayer__resize-handle"
          onPointerDown={onResizePointerDown}
          title="Drag to resize miniplayer"
          aria-label="Resize miniplayer"
        />
      )}

      {/* Top Header Row with Title, Author and Action Buttons */}
      <div
        className="miniplayer__header"
        onPointerDown={onHeaderPointerDown}
        title="Drag to reposition or click to expand"
      >
        <div
          className="miniplayer__info"
          onClick={onExpand}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onExpand?.()
            }
          }}
          aria-label={`Expand ${title || 'video'}`}
        >
          <span className="miniplayer__title" title={title}>
            {title || 'Playing video'}
          </span>
          {author && (
            <span className="miniplayer__author" title={author}>
              {author}
            </span>
          )}
        </div>

        <div className="miniplayer__actions" onPointerDown={(e) => e.stopPropagation()}>
          {onExpand && (
            <button
              type="button"
              className="miniplayer__action-btn"
              aria-label="Expand to full player"
              title="Expand to full player (F)"
              onClick={onExpand}
            >
              <Icon name="openInFull" size={17} />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="miniplayer__action-btn miniplayer__action-btn--close"
              aria-label="Close miniplayer"
              title="Close miniplayer (Esc)"
              onClick={onClose}
            >
              <Icon name="close" size={17} />
            </button>
          )}
        </div>
      </div>

      {/* Center Playback Controls */}
      <div className="miniplayer__center">
        {playlistNavigation?.hasPrevious && (
          <button
            type="button"
            className="miniplayer__step-btn"
            aria-label="Previous video"
            title="Previous video (Shift+P)"
            onClick={playlistNavigation.onPrevious}
          >
            <Icon name="skipPrevious" size={20} />
          </button>
        )}

        <button
          type="button"
          className="miniplayer__play-btn"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={onTogglePlay}
        >
          <Icon name={playing ? 'pause' : 'play'} size={24} />
        </button>

        {playlistNavigation?.hasNext && (
          <button
            type="button"
            className="miniplayer__step-btn"
            aria-label="Next video"
            title="Next video (Shift+N)"
            onClick={playlistNavigation.onNext}
          >
            <Icon name="skipNext" size={20} />
          </button>
        )}
      </div>

      {/* Bottom Timeline and Seek Bar */}
      <div className="miniplayer__bottom">
        <SeekBar
          duration={duration}
          currentTime={currentTime}
          buffered={buffered}
          chapters={chapters}
          segments={segments}
          live={liveWindow}
          onSeek={onSeek}
          onScrubStart={onScrubStart}
          onScrubEnd={onScrubEnd}
        />
        <div className="miniplayer__time">
          <span>{fmt(currentTime)}</span>
          <span className="miniplayer__time-sep">/</span>
          <span>{isLive ? 'LIVE' : fmt(duration)}</span>
        </div>
      </div>

      {/* Slim progress bar shown when controls are hidden */}
      {!visible && duration > 0 && !isLive && (
        <div className="miniplayer__slim-progress" aria-hidden="true">
          <div
            className="miniplayer__slim-progress-fill"
            style={{ width: `${progressRatio * 100}%` }}
          />
        </div>
      )}
    </div>
  )
})
