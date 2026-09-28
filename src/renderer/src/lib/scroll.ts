/**
 * Page-level scrolling.
 *
 * `html`/`body` never scroll in this app — `.content` (`#main-content`) is the scroller.
 */

/** The element that currently scrolls the page vertically, if any. */
export function pageScroller(): HTMLElement | null {
  return document.getElementById('main-content')
}

/** Scroll the page back to the top, whichever element owns the scroll. */
export function scrollPageToTop(behavior: ScrollBehavior = 'smooth'): void {
  pageScroller()?.scrollTo({ top: 0, behavior })
}
