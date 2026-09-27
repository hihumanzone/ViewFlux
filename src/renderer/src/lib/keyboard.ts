import type { KeyboardEvent } from 'react'

/**
 * Keyboard helpers for the large clickable surfaces — video/channel/playlist
 * cards and saved-channel tiles.
 *
 * These are styled as links but rendered as `<article>`/`<div>` so the markup
 * stays semantic and we avoid nesting a real `<button>` inside the author
 * button. That means they are not natively activatable, so each one needs the
 * same role + key handling, and all of them forgot it before this module
 * existed.
 */

/** Enter or Space: the two keys that activate a native `<button>`. */
function isActivationKey(event: KeyboardEvent): boolean {
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar'
}

/**
 * True when the event came from a nested control that already handles the key
 * itself — a channel-name button, an overflow menu, a text input. Without this
 * check, pressing Enter on a focused author button would also open the card.
 */
function isFromNestedControl(event: KeyboardEvent): boolean {
  const target = event.currentTarget as HTMLElement | null
  const origin = event.target as HTMLElement | null
  if (!target || !origin || origin === target) return false
  if (origin.isContentEditable) return true
  if (origin.tagName === 'INPUT' || origin.tagName === 'TEXTAREA' || origin.tagName === 'SELECT') {
    return true
  }
  // Any element that is itself a control, rather than a span of plain text.
  return origin !== target && origin.closest('button, a[href], [role="button"]') !== null
}

/**
 * Props that make a non-interactive element behave like a button: the role,
 * the tab stop, and the key handling that calls `onActivate`.
 *
 * Spread onto the root of a card:
 * ```tsx
 * <article className="video-card" {...activationProps(open)}>
 * ```
 */
export function activationProps(onActivate: () => void): {
  role: 'button'
  tabIndex: 0
  onKeyDown: (event: KeyboardEvent) => void
} {
  return {
    role: 'button',
    tabIndex: 0,
    onKeyDown: (event) => {
      if (isFromNestedControl(event)) return
      if (!isActivationKey(event)) return
      // Space would otherwise scroll the page, and Enter on a nested anchor
      // would activate the card as well as its own target.
      event.preventDefault()
      onActivate()
    }
  }
}

/**
 * A count of dismissable layers (menus, popups) that are currently open.
 *
 * This exists because of a genuine ordering problem, not for tidiness. Dialog
 * and Menu both need Escape, both register a capture-phase listener on
 * `window`, and `stopPropagation()` does not stop *other* listeners on the same
 * node — only `stopImmediatePropagation()` does, and that still only affects
 * listeners registered after the one that calls it. The Dialog's listener is
 * always registered first (the dialog opens before the menu inside it), so
 * without this counter pressing Escape to dismiss a folder dropdown would
 * tear down the whole dialog and lose the user's edits.
 *
 * The innermost layer therefore wins: the dialog asks `hasOpenDismissableLayer()`
 * first and does nothing if a menu owns the key.
 */
let dismissableLayers = 0

export function pushDismissableLayer(): void {
  dismissableLayers += 1
}

export function popDismissableLayer(): void {
  dismissableLayers = Math.max(0, dismissableLayers - 1)
}

export function hasOpenDismissableLayer(): boolean {
  return dismissableLayers > 0
}
