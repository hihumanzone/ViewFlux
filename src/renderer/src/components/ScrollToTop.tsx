import { memo, useEffect, useState } from 'react'
import { Icon } from './Icons'

export const ScrollToTop = memo(function ScrollToTop(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const main = document.getElementById('main-content')
    if (!main) return

    const handleScroll = (): void => {
      setVisible(main.scrollTop > 360)
    }

    main.addEventListener('scroll', handleScroll, { passive: true })
    return () => main.removeEventListener('scroll', handleScroll)
  }, [])

  const scrollToTop = (): void => {
    const main = document.getElementById('main-content')
    if (!main) return
    main.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (!visible) return null

  return (
    <button
      type="button"
      className="scroll-to-top"
      aria-label="Scroll to top"
      title="Scroll to top"
      onClick={scrollToTop}
    >
      <Icon name="up" size={20} />
    </button>
  )
})
