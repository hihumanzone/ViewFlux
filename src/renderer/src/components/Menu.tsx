import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icons'
import { popDismissableLayer, pushDismissableLayer } from '../lib/keyboard'

/** Distance between the anchor and the panel, and the minimum gap to the window edges. */
const GAP = 8
const MARGIN = 8
const MAX_PANEL_HEIGHT = 420

interface Placement {
  top: number
  left: number
  maxHeight: number
}

interface MenuProps {
  /** Element the panel is positioned against. */
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  align?: 'start' | 'end' | 'center'
  title?: string
  className?: string
  /** Space left between the anchor and the panel (raise it to clear nearby chrome). */
  gap?: number
  /**
   * Pin the panel to one side of the anchor instead of auto-flipping. Player
   * menus use `above` so they always open over the video, clear of the seek
   * bar — auto-flip near the boundary is what made them visibly jump.
   */
  prefer?: 'above' | 'below'
  /**
   * Marks the panel as a set of mutually exclusive choices (quality, audio
   * language, sort). Its items are then exposed as `menuitemradio` with
   * `aria-checked`, instead of plain actions.
   */
  checkable?: boolean
  children: React.ReactNode
}

/**
 * Lets a panel declare "my items are radio choices" once, instead of every
 * `MenuItem` in a quality or audio menu having to repeat it.
 */
const CheckableContext = createContext(false)

/**
 * Floating panel used for every option list in the app (player settings, quality,
 * audio, captions, channel sort, card overflow menus and settings dropdowns).
 *
 * It is rendered into `document.body` so it can never be clipped by the player or a
 * scrolling grid, it flips above the anchor when there is no room below, it is
 * clamped to the window, it closes on outside click or Escape, and it follows the
 * anchor while scrolling or resizing.
 */
export function Menu({
  anchor,
  open,
  onClose,
  align = 'start',
  title,
  className,
  gap = GAP,
  prefer,
  checkable = false,
  children
}: MenuProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)

  const place = useCallback((): void => {
    const panel = panelRef.current
    if (!panel || !anchor) return

    const rect = anchor.getBoundingClientRect()
    const width = panel.offsetWidth
    const height = panel.offsetHeight
    const spaceBelow = window.innerHeight - rect.bottom - gap - MARGIN
    const spaceAbove = rect.top - gap - MARGIN
    const fullHeight = Math.min(height, MAX_PANEL_HEIGHT)
    let flip: boolean
    if (prefer === 'above') {
      // Stay above unless there is genuinely no room (then take below).
      flip = spaceAbove >= fullHeight || spaceAbove >= spaceBelow
    } else if (prefer === 'below') {
      flip = spaceBelow < fullHeight && spaceAbove > spaceBelow
    } else {
      flip = height > spaceBelow && spaceAbove > spaceBelow
    }
    const maxHeight = Math.max(140, Math.min(flip ? spaceAbove : spaceBelow, height, MAX_PANEL_HEIGHT))
    const top = flip
      ? Math.max(MARGIN, rect.top - Math.min(height, maxHeight) - gap)
      : rect.bottom + gap

    const preferred =
      align === 'end'
        ? rect.right - width
        : align === 'center'
          ? rect.left + rect.width / 2 - width / 2
          : rect.left
    const left = Math.min(
      Math.max(MARGIN, preferred),
      Math.max(MARGIN, window.innerWidth - width - MARGIN)
    )

    setPlacement((prev) =>
      prev && prev.top === top && prev.left === left && prev.maxHeight === maxHeight
        ? prev
        : { top, left, maxHeight }
    )
  }, [anchor, align, gap, prefer])

  // Position on open, then only re-position when the panel's own size changes
  // (async content) or the window resizes. Deliberately NOT on every parent
  // render: components like the player re-render several times a second, and
  // re-measuring there made open panels visibly tremble.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    place()
    const panel = panelRef.current
    if (!panel || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => place())
    observer.observe(panel)
    return () => observer.disconnect()
  }, [open, place])

  // The anchor never moves for most menus, but a window resize, a fullscreen change or a scroll
  // of any container shifts every viewport-relative rect, so follow those.
  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', place)
    // Capture phase: menus anchored inside scrolling containers (settings, filter bars) must
    // stay glued to their trigger while that container scrolls.
    window.addEventListener('scroll', place, true)
    document.addEventListener('fullscreenchange', place)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('fullscreenchange', place)
    }
  }, [open, place])

  // Close when clicking anywhere outside the panel or its anchor.
  useEffect(() => {
    if (!open) return
    // Claim Escape while open so an enclosing Dialog leaves the key to us.
    pushDismissableLayer()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      popDismissableLayer()
    }
  }, [open, anchor, onClose])

  if (!open) return null

  const onPanelKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[data-menu-item]:not([disabled])') ?? []
    )
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'ArrowDown'
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const portalTarget =
    (anchor?.closest(':fullscreen') as HTMLElement | null) ??
    (anchor?.closest('.player--fullscreen') as HTMLElement | null) ??
    (typeof document !== 'undefined' ? (document.fullscreenElement as HTMLElement | null) : null) ??
    (typeof document !== 'undefined' ? document.body : null)

  if (!portalTarget) return null

  return createPortal(
    <CheckableContext.Provider value={checkable}>
      <div
        ref={panelRef}
        className={['menu', 'popover', className].filter(Boolean).join(' ')}
        role="menu"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onPanelKeyDown}
        style={
          placement
            ? {
                top: `${placement.top}px`,
                left: `${placement.left}px`,
                maxHeight: `${placement.maxHeight}px`
              }
            : { top: 0, left: 0, visibility: 'hidden' }
        }
      >
        {title ? <div className="menu__title">{title}</div> : null}
        <div className="menu__content">{children}</div>
      </div>
    </CheckableContext.Provider>,
    portalTarget
  )
}

interface MenuItemProps {
  /** An {@link IconName} (rendered as an icon) or any node for custom art. */
  icon?: IconName | React.ReactNode
  label: string
  hint?: string
  selected?: boolean
  danger?: boolean
  onSelect: () => void
}

/** A selectable option inside a {@link Menu}. */
export function MenuItem({
  icon,
  label,
  hint,
  selected,
  danger,
  onSelect
}: MenuItemProps): React.JSX.Element {
  // Inside a `checkable` panel the items are alternatives, not actions, so
  // they need `aria-checked` for assistive tech to report which one is current.
  const checkable = useContext(CheckableContext)
  return (
    <button
      type="button"
      role={checkable ? 'menuitemradio' : 'menuitem'}
      aria-checked={checkable ? Boolean(selected) : undefined}
      data-menu-item=""
      className={['menu__item', selected && 'menu__item--active', danger && 'menu__item--danger']
        .filter(Boolean)
        .join(' ')}
      onClick={(event) => {
        // Menus are portalled, so React still bubbles this through the React tree —
        // stop here or a menu opened over a card would also activate the card.
        event.stopPropagation()
        onSelect()
      }}
    >
      {typeof icon === 'string' ? (
        <span className="menu__item-icon">
          <Icon name={icon as IconName} size={18} />
        </span>
      ) : icon ? (
        <span className="menu__item-icon">{icon}</span>
      ) : null}
      <span className="menu__item-label">{label}</span>
      {hint ? <span className="menu__item-hint">{hint}</span> : null}
      {selected ? (
        <span className="menu__item-check">
          <Icon name="check" size={16} />
        </span>
      ) : null}
    </button>
  )
}
