import { memo, useEffect, useState } from 'react'
import { Icon } from './Icons'
import { pageScroller, scrollPageToTop } from '../lib/scroll'

export const ScrollToTop = memo(function ScrollToTop(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Element scroll events do not bubble, and on the watch page the page
    // scroller is the main column rather than `.content` — so listen in the
    // capture phase on the document, which sees whichever one is moving.
    const handleScroll = (event: Event): void => {
      const scroller = pageScroller()
      if (!scroller) return
      // Pane-level scrolling (the playlist, menus) must not raise the button.
      if (event.target !== scroller) return
      setVisible(scroller.scrollTop > 360)
    }
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true })
    return () => document.removeEventListener('scroll', handleScroll, true)
  }, [])

  const scrollToTop = (): void => scrollPageToTop('smooth')

  return (
    <button
      type="button"
      className={`scroll-to-top${visible ? ' scroll-to-top--visible' : ''}`}
      aria-label="Scroll to top"
      title="Scroll to top"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      onClick={scrollToTop}
    >
      <Icon name="up" size={20} />
    </button>
  )
})
