import type { ReactNode } from 'react'
import { Icon } from './Icons'
import type { IconName } from './Icons'

export interface EmptyStateProps {
  icon: IconName
  title: string
  message?: ReactNode
  /** A call to action — usually a single button under the message. */
  action?: ReactNode
  /** The larger variant used on a page that has nothing else to show yet. */
  hero?: boolean
  iconSize?: number
}

/**
 * The "nothing here" panel every page falls back to: no results, empty
 * history, a playlist with no videos, a failed fetch. Keeping it in one place
 * means the icon, spacing and type ramp stay consistent, and gives each
 * instance a single place to hang an action.
 */
export function EmptyState({
  icon,
  title,
  message,
  action,
  hero = false,
  iconSize = 30
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className={hero ? 'empty empty--hero' : 'empty'}>
      <div className="empty__icon">
        <Icon name={icon} size={iconSize} />
      </div>
      <div className="empty__title">{title}</div>
      {message != null && message !== false && <div className="empty__text">{message}</div>}
      {action}
    </div>
  )
}

export interface LoaderProps {
  /** Announced to screen readers and shown next to the spinner. Omit for a bare spinner. */
  label?: string
}

/** Busy indicator. Pair with `role="status"` semantics via the `label`. */
export function Loader({ label }: LoaderProps): React.JSX.Element {
  return (
    <div className="loader" role={label ? 'status' : undefined}>
      <div className="spinner" />
      {label}
    </div>
  )
}
