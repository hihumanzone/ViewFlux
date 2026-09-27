import { memo } from 'react'
import { Icon, type IconName } from '../Icons'
import type { OsdState } from './types'

export const PlayerOsd = memo(function PlayerOsd({
  osd
}: {
  osd: OsdState | null
}): React.JSX.Element | null {
  if (!osd) return null

  return (
    <div className="player__osd" key={osd.id} role="status" aria-live="assertive">
      {osd.icon && (
        <span className="player__osd-icon">
          <Icon name={osd.icon as IconName} size={22} />
        </span>
      )}
      <span className="player__osd-text">{osd.text}</span>
    </div>
  )
})
