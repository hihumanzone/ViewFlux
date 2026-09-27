import { useRef, useState } from 'react'
import { Icon, type IconName } from './Icons'
import { Menu, MenuItem } from './Menu'

export interface SelectOption<T> {
  value: T
  label: string
  /** Icon shown next to the option inside the menu. */
  icon?: IconName
  /** Secondary text shown at the end of the menu row, e.g. an item count. */
  hint?: string
}

export interface SelectFieldProps<T> {
  value: T
  options: SelectOption<T>[]
  onSelect: (value: T) => void
  /** Label shown when `value` matches none of the options. */
  placeholder?: string
  /** Accessible name for the trigger button. */
  ariaLabel?: string
  title?: string
  align?: 'start' | 'end' | 'center'
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Adaptive dropdown used everywhere a single value has to be picked from a
 * list. Built on the shared {@link Menu} popover instead of a native `<select>`
 * so it inherits the app's menu styling, keyboard navigation and the ability to
 * open above the anchor near the bottom of the window.
 */
export function SelectField<T extends string | number>({
  value,
  options,
  onSelect,
  placeholder = 'Select…',
  ariaLabel,
  title,
  align = 'end',
  size = 'md',
  className
}: SelectFieldProps<T>): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)

  return (
    <>
      <button
        type="button"
        className={[
          'select',
          size === 'sm' && 'select--sm',
          open && 'select--open',
          className
        ]
          .filter(Boolean)
          .join(' ')}
        ref={anchorRef}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="select__value">{current?.label ?? placeholder}</span>
        <Icon name="down" size={16} className="select__chevron" />
      </button>
      <Menu anchor={anchorRef.current} open={open} onClose={() => setOpen(false)} align={align}>
        {options.map((option) => (
          <MenuItem
            key={String(option.value)}
            icon={option.icon}
            label={option.label}
            hint={option.hint}
            selected={option.value === value}
            onSelect={() => {
              onSelect(option.value)
              setOpen(false)
            }}
          />
        ))}
      </Menu>
    </>
  )
}
