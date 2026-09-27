/**
 * The app's toggle control.
 *
 * Settings and the player's settings sheet both need a switch, and they were
 * carrying byte-identical copies that had already drifted (one had no
 * accessible name, so a screen reader announced it as just "switch"). One
 * component with an optional `label` fixes that for both call sites.
 */
export function Switch({
  on,
  onClick,
  label,
  className
}: {
  on: boolean
  onClick: () => void
  /** Accessible name. Strongly recommended — an unlabelled switch is announced as "switch". */
  label?: string
  className?: string
}): React.JSX.Element {
  return (
    <button
      className={`switch${on ? ' switch--on' : ''}${className ? ` ${className}` : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
    />
  )
}
