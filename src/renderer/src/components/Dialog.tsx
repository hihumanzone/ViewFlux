import { useEffect, useId, useRef } from 'react'
import { hasOpenDismissableLayer } from '../lib/keyboard'

/** Selector for the controls a Tab key should cycle through inside a dialog. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The one modal shell in the app.
 *
 * Before this existed every dialog re-implemented the same three things and
 * usually got one of them wrong: dismiss on a backdrop click, dismiss on
 * Escape, and give the panel the right dialog semantics. Escape in particular
 * was missing from the bookmark and playlist dialogs, so a user who opened a
 * dialog with the keyboard had no obvious way out of it.
 *
 * Behaviour worth knowing about:
 * - Escape and backdrop clicks both route through `onClose`, so callers only
 *   implement "dismiss" once.
 * - Escape is captured on the window (not just the panel) so it still works
 *   while focus sits on an input inside the panel, and it stops propagation so
 *   a parent handler cannot double-fire.
 * - The panel is focusable and gets the dialog role, its title is wired up via
 *   `aria-labelledby`, and `aria-modal` tells assistive tech that the rest of
 *   the app is inert behind it.
 * - Tab is trapped inside the panel. Without this, tabbing out of a dialog
 *   walked straight into the sidebar behind it, which read as the dialog
 *   having closed.
 * - `initialFocus` lets a caller skip the autofocus step (`'auto'`) when the
 *   dialog already autofocuses a real control, or when focusing the panel
 *   itself is the right announcement for a confirmation.
 */
export function Dialog({
  title,
  onClose,
  children,
  className,
  initialFocus
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  className?: string
  initialFocus?: 'panel' | 'auto'
}): React.JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (initialFocus === 'auto') return
    panelRef.current?.focus()
  }, [initialFocus])

  useEffect(() => {
    if (!onClose) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // A menu opened from inside this dialog owns the key. Our capture-phase
        // listener runs before the menu's, so without this check one Escape
        // would dismiss the dropdown and the dialog behind it.
        if (hasOpenDismissableLayer()) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      // Keep Tab inside the panel. Elements are collected in DOM order, which
      // matches the visual order, so the wrap-around is predictable.
      const panel = panelRef.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (!active || !panel.contains(active)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      }
    }
    // Capture so Escape wins over the player and menu shortcut handlers, which
    // are also listening on the window.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={panelRef}
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title" id={titleId}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  )
}
