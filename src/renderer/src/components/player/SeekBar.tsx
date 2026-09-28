import { memo, useMemo, useRef, useState } from 'react'
import { formatTime as fmt } from '../../lib/format'
import { SponsorLayer } from './SponsorLayer'
import { clamp, clamp01, type Chapter, type LiveWindow, type SponsorSegment } from './types'

export interface SeekBarProps {
  duration: number
  currentTime: number
  buffered: [number, number][]
  chapters?: Chapter[]
  segments: SponsorSegment[]
  /**
   * Present for live streams: the sliding DVR window plus how far the playhead
   * currently sits behind its live edge. A live stream has no total duration,
   * so the bar is remapped onto `[live.start, live.end]` and the tooltip shows
   * a negative offset from the edge instead of an absolute timestamp.
   */
  live?: (LiveWindow & { behind: number }) | null
  onSeek: (time: number) => void
  onScrubStart?: () => void
  onScrubEnd?: () => void
}

/** A window this short is not worth scrubbing; treat it as "nothing to seek". */
const MIN_SPAN = 0.5

export const SeekBar = memo(function SeekBar({
  duration,
  currentTime,
  buffered,
  chapters = [],
  segments,
  live = null,
  onSeek,
  onScrubStart,
  onScrubEnd
}: SeekBarProps): React.JSX.Element {
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubTime, setScrubTime] = useState(0)
  const [seekTarget, setSeekTarget] = useState<number | null>(null)
  const [hoverFraction, setHoverFraction] = useState<number | null>(null)
  const scrubTimeRef = useRef(0)

  // VOD scrubs [0, duration]; live scrubs the DVR window, whose `start` slides
  // forward as the broadcast continues. Everything below is expressed relative
  // to `rangeStart` so one code path serves both.
  const rangeStart = live ? live.start : 0
  const rangeEnd = live ? live.end : duration
  const span = rangeEnd - rangeStart
  const hasRange = Number.isFinite(span) && span >= MIN_SPAN
  const displayTime = seekTarget ?? (scrubbing ? scrubTime : currentTime)

  /** Pointer x-position → presentation time inside the active range. */
  const timeFromFraction = (fraction: number): number =>
    rangeStart + fraction * (hasRange ? span : 0)

  const fractionFromEvent = (event: React.PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return clamp01((event.clientX - rect.left) / rect.width)
  }

  const updateScrub = (event: React.PointerEvent<HTMLDivElement>): void => {
    const time = timeFromFraction(fractionFromEvent(event))
    scrubTimeRef.current = time
    setScrubTime(time)
  }

  const onSeekDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!hasRange) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setScrubbing(true)
    onScrubStart?.()
    updateScrub(event)
  }

  const onSeekMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (scrubbing) {
      updateScrub(event)
    } else if (hasRange) {
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
    if (!hasRange) return
    const target = (() => {
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          return displayTime - 5
        case 'ArrowRight':
        case 'ArrowUp':
          return displayTime + 5
        case 'PageDown':
          return displayTime - 60
        case 'PageUp':
          return displayTime + 60
        case 'Home':
          // Oldest point still in the DVR window.
          return rangeStart
        case 'End':
          // Newest point still in the DVR window, i.e. the live edge.
          return rangeEnd
        default:
          return null
      }
    })()
    if (target == null) return
    event.preventDefault()
    event.stopPropagation()
    const clamped = clamp(target, rangeStart, rangeEnd)
    setSeekTarget(clamped)
    scrubTimeRef.current = clamped
    onSeek(clamped)
  }

  /** Playhead position along the bar, 0-100. */
  const playheadPct = hasRange ? clamp01((displayTime - rangeStart) / span) * 100 : 0
  const maxBufferedTime = Math.max(0, ...buffered.map(([, end]) => end))
  const bufferedPct = hasRange ? clamp01((maxBufferedTime - rangeStart) / span) * 100 : 0
  const hasChapters = !live && chapters.length > 0

  // Live: the "played" bar runs from the playhead *to the live edge*, so the
  // fill reads as "how much live is still ahead of you" rather than "how much
  // of the video you have watched" — absolute presentation timestamps are
  // meaningless on a stream that never ends.
  const behindPct = live && hasRange ? clamp01((rangeEnd - displayTime) / span) * 100 : 0
  const behindSeconds = live ? Math.max(0, rangeEnd - displayTime) : 0

  const chapterMetas = useMemo(() => {
    return chapters.map((ch) => ({
      title: ch.title,
      start: ch.start,
      end: ch.end,
      chDur: Math.max(0.1, ch.end - ch.start),
      label: `${ch.title} (${fmt(ch.start)} - ${fmt(ch.end)})`
    }))
  }, [chapters])

  // Hover preview calculations
  const hoverTime = hoverFraction != null && hasRange ? timeFromFraction(hoverFraction) : null
  const hoverPct = hoverFraction != null ? clamp01(hoverFraction) * 100 : null

  const hoverChapter = useMemo(() => {
    if (hoverTime == null || !hasChapters) return null
    return chapters.find((c) => hoverTime >= c.start && hoverTime < c.end) ?? null
  }, [hoverTime, hasChapters, chapters])

  const ariaValue = live
    ? {
        // Relative to the window start, so the values mean something to a
        // screen reader instead of being a 20-hour presentation timestamp.
        'aria-valuemin': 0,
        'aria-valuemax': Math.max(0, Math.round(span)),
        'aria-valuenow': Math.max(0, Math.round(displayTime - rangeStart)),
        'aria-valuetext':
          behindSeconds <= 1 ? 'Live' : `Live, ${Math.round(behindSeconds)} seconds behind`
      }
    : {
        'aria-valuemin': 0,
        'aria-valuemax': Math.max(0, Math.floor(duration)),
        'aria-valuenow': Math.floor(displayTime),
        'aria-valuetext': `${fmt(displayTime)} of ${fmt(duration)}`
      }

  return (
    <div
      className={`seek${scrubbing ? ' seek--scrubbing' : ''}${live ? ' seek--live' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={live ? 'Live stream position' : 'Seek'}
      aria-valuemin={ariaValue['aria-valuemin']}
      aria-valuemax={ariaValue['aria-valuemax']}
      aria-valuenow={ariaValue['aria-valuenow']}
      aria-valuetext={ariaValue['aria-valuetext']}
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
          {live ? (
            <span className="seek__tooltip-time seek__tooltip-time--live">
              {behindSeconds >= 1 ? `-${Math.round(rangeEnd - hoverTime)}s` : 'LIVE'}
            </span>
          ) : (
            <span className="seek__tooltip-time">{fmt(hoverTime)}</span>
          )}
          {hoverChapter && (
            <span className="seek__tooltip-chapter">{hoverChapter.title}</span>
          )}
        </div>
      )}

      {hasChapters ? (
        <div className="seek__chapters">
          {chapterMetas.map((ch, idx) => {
            const playedInCh = Math.max(0, Math.min(displayTime - ch.start, ch.chDur))
            const chPlayedPct = (playedInCh / ch.chDur) * 100

            const bufInCh = Math.max(0, Math.min(maxBufferedTime - ch.start, ch.chDur))
            const chBufPct = (bufInCh / ch.chDur) * 100

            return (
              <div
                key={idx}
                className="seek__chapter-segment"
                style={{ flex: ch.chDur }}
                title={ch.label}
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
          {live ? (
            <>
              <div
                className="seek__live-ahead"
                style={{ left: `${playheadPct}%`, width: `${behindPct}%` }}
              />
              <div className="seek__live-edge" aria-hidden="true" />
            </>
          ) : (
            <div className="seek__played" style={{ width: `${playheadPct}%` }} />
          )}
          {!live && duration > 0 && <SponsorLayer segments={segments} duration={duration} />}
        </div>
      )}
      <div className="seek__thumb" style={{ left: `${playheadPct}%` }} />
    </div>
  )
})
