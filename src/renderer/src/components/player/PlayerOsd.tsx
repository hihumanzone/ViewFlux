import { memo, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../Icons'
import type { OsdState } from './types'

export const PlayerOsd = memo(function PlayerOsd({
  osd
}: {
  osd: OsdState | null
}): React.JSX.Element | null {
  const [activeOsd, setActiveOsd] = useState<OsdState | null>(osd)
  const [status, setStatus] = useState<'entering' | 'idle' | 'exiting' | 'hidden'>(() =>
    osd ? 'entering' : 'hidden'
  )
  const exitTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (exitTimerRef.current) {
      window.clearTimeout(exitTimerRef.current)
      exitTimerRef.current = null
    }

    if (osd) {
      setActiveOsd(osd)
      setStatus((prev) => (prev === 'hidden' || prev === 'exiting' ? 'entering' : prev))
    } else {
      setStatus((prev) => {
        if (prev === 'hidden') return 'hidden'
        // Fallback safety timeout if onAnimationEnd does not fire
        exitTimerRef.current = window.setTimeout(() => {
          setStatus('hidden')
          setActiveOsd(null)
        }, 220)
        return 'exiting'
      })
    }
  }, [osd])

  useEffect(() => {
    return () => {
      if (exitTimerRef.current) {
        window.clearTimeout(exitTimerRef.current)
      }
    }
  }, [])

  if (status === 'hidden' || !activeOsd) {
    return null
  }

  const handleAnimationEnd = (e: React.AnimationEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return

    if (status === 'entering') {
      setStatus('idle')
    } else if (status === 'exiting') {
      if (exitTimerRef.current) {
        window.clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
      setStatus('hidden')
      setActiveOsd(null)
    }
  }

  const animClass =
    status === 'entering'
      ? 'player__osd--enter'
      : status === 'exiting'
        ? 'player__osd--exit'
        : ''

  return (
    <div
      className={`player__osd ${animClass}`.trim()}
      role="status"
      aria-live="assertive"
      onAnimationEnd={handleAnimationEnd}
    >
      {activeOsd.icon && (
        <span className="player__osd-icon">
          <Icon name={activeOsd.icon as IconName} size={22} />
        </span>
      )}
      <span className="player__osd-text">{activeOsd.text}</span>
    </div>
  )
})

