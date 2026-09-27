import { memo, useMemo, useRef, useState } from 'react'
import { formatTime as fmt } from '../../lib/format'
import { SponsorLayer } from './SponsorLayer'
import { clamp01, type Chapter, type SponsorSegment } from './types'

export interface SeekBarProps {
  duration: number
  currentTime: number
  buffered: [number, number][]
  chapters?: Chapter[]
  segments: SponsorSegment[]
  onSeek: (time: number) => void
  onScrubStart?: () => void
  onScrubEnd?: () => void
}

export const SeekBar = memo(function SeekBar({
  duration,
  currentTime,
  buffered,
  chapters = [],
  segments,
  onSeek,
  onScrubStart,
  onScrubEnd
}: SeekBarProps): React.JSX.Element {
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubTime, setScrubTime] = useState(0)
  const [seekTarget, setSeekTarget] = useState<number | null>(null)
  const [hoverFraction, setHoverFraction] = useState<number | null>(null)
  const scrubTimeRef = useRef(0)

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
    onScrubStart?.()
    updateScrub(event)
  }

  const onSeekMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (scrubbing) {
      updateScrub(event)
    } else if (duration > 0) {
      setHoverFraction(fractionFromEvent(event))
    }
  }

  const onSeekUp = (): void => {
    if (!scrubbing) return
    setScrubbing(false)
    setSeekTarget(scrubTimeRef.current)
    onSeek(scrubTimeRef.current)
    onScrubEnd?.()
    // Reset seekTarget after a brief timeout so the video position takes over
    window.setTimeout(() => setSeekTarget(null), 350)
  }

  const onPointerLeave = (): void => {
    if (!scrubbing) setHoverFraction(null)
  }

  const onSeekKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!duration) return
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
    onSeek(target)
  }

  const displayTime = seekTarget ?? (scrubbing ? scrubTime : currentTime)
  const playedPct = duration ? clamp01(displayTime / duration) * 100 : 0
  const maxBufferedTime = Math.max(0, ...buffered.map(([, end]) => end))
  const bufferedPct = duration ? clamp01(maxBufferedTime / duration) * 100 : 0
  const hasChapters = Boolean(chapters && chapters.length > 0)

  // Hover preview calculations
  const hoverTime = hoverFraction != null && duration > 0 ? hoverFraction * duration : null
  const hoverPct = hoverFraction != null ? clamp01(hoverFraction) * 100 : null

  const hoverChapter = useMemo(() => {
    if (hoverTime == null || !hasChapters) return null
    return chapters.find((c) => hoverTime >= c.start && hoverTime < c.end) ?? null
  }, [hoverTime, hasChapters, chapters])

  return (
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
      onPointerLeave={onPointerLeave}
      onKeyDown={onSeekKeyDown}
    >
      {/* Floating Hover Time Preview Tooltip */}
      {hoverPct != null && hoverTime != null && !scrubbing && (
        <div
          className="seek__tooltip"
          style={{ left: `${hoverPct}%` }}
          aria-hidden="true"
        >
          <span className="seek__tooltip-time">{fmt(hoverTime)}</span>
          {hoverChapter && (
            <span className="seek__tooltip-chapter">{hoverChapter.title}</span>
          )}
        </div>
      )}

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
          {hoverPct != null && (
            <div className="seek__hover-preview" style={{ width: `${hoverPct}%` }} />
          )}
          <div className="seek__played" style={{ width: `${playedPct}%` }} />
          {duration > 0 && <SponsorLayer segments={segments} duration={duration} />}
        </div>
      )}
      <div className="seek__thumb" style={{ left: `${playedPct}%` }} />
    </div>
  )
})
