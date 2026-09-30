/**
 * Page-level scrolling.
 *
 * `html`/`body` never scroll in this app — `.content` (`#main-content`) is the scroller.
 */

let activeAnimationId: number | null = null
let cancelListeners: (() => void) | null = null

function stopActiveScroll(): void {
  if (activeAnimationId !== null) {
    cancelAnimationFrame(activeAnimationId)
    activeAnimationId = null
  }
  if (cancelListeners) {
    cancelListeners()
    cancelListeners = null
  }
}

/** The element that currently scrolls the page vertically, if any. */
export function pageScroller(): HTMLElement | null {
  return document.getElementById('main-content')
}

/** Smoothly animates scrolling of an element to top with ease-out cubic curve. */
function smoothScrollElementToTop(element: HTMLElement, duration = 320): void {
  stopActiveScroll()

  const startTop = element.scrollTop
  if (startTop <= 0) return

  // Honor reduced motion preference
  if (document.documentElement.dataset.reducedMotion === 'true') {
    element.scrollTop = 0
    return
  }

  const startTime = performance.now()

  // User wheel or touch interrupts the smooth animation naturally
  const onUserInterrupt = (): void => stopActiveScroll()
  element.addEventListener('wheel', onUserInterrupt, { passive: true })
  element.addEventListener('touchstart', onUserInterrupt, { passive: true })
  cancelListeners = () => {
    element.removeEventListener('wheel', onUserInterrupt)
    element.removeEventListener('touchstart', onUserInterrupt)
  }

  function step(currentTime: number): void {
    const elapsed = currentTime - startTime
    const progress = Math.min(elapsed / duration, 1)
    // easeOutCubic: fast start, soft deceleration
    const ease = 1 - Math.pow(1 - progress, 3)
    element.scrollTop = Math.round(startTop * (1 - ease))

    if (progress < 1) {
      activeAnimationId = requestAnimationFrame(step)
    } else {
      stopActiveScroll()
    }
  }

  activeAnimationId = requestAnimationFrame(step)
}

/** Scroll the page back to the top, whichever element owns the scroll. */
export function scrollPageToTop(behavior: ScrollBehavior = 'smooth'): void {
  const scroller = pageScroller()
  if (!scroller) return

  if (behavior === 'smooth') {
    smoothScrollElementToTop(scroller, 320)
  } else {
    stopActiveScroll()
    scroller.scrollTop = 0
  }
}
