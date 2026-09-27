import { Icon } from './Icons'
import type { IconName } from './Icons'

/**
 * The overflow ("⋯") trigger used by every card and row.
 *
 * The tricky part — and the reason this is a component rather than four copies
 * of a button — is that `event.currentTarget` is only readable while the event
 * is being dispatched, but `setState`'s updater function runs later, after
 * React has recycled the synthetic event. Every copy of this button had to
 * capture the node in a local before deferring, and one of them had grown a
 * comment explaining the bug it had already hit. Centralised, it is stated once.
 */
export function OverflowButton({
  label,
  onToggle,
  className,
  icon = 'more'
}: {
  /** Accessible name, e.g. `"Options for Never Gonna Give You Up"`. */
  label: string
  /** Receives the trigger element so the caller can pass it to `<Menu anchor>`. */
  onToggle: (anchor: HTMLElement) => void
  className?: string
  icon?: IconName
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`icon-btn icon-btn--sm${className ? ` ${className}` : ''}`}
      aria-label={label}
      aria-haspopup="menu"
      title={label}
      onClick={(event) => {
        // The card underneath is itself clickable; without this the menu would
        // open and the card would navigate at the same time.
        event.stopPropagation()
        onToggle(event.currentTarget)
      }}
    >
      <Icon name={icon} size={18} />
    </button>
  )
}
