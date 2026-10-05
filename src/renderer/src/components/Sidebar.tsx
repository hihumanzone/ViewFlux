import { useEffect, useState, useCallback } from 'react'
import { Icon, type IconName } from './Icons'
import { useRoute, routeLinkProps, type Route } from '../lib/router'
import { readStoredWithLegacy, writeStored } from '../lib/storage'

interface NavItem {
  label: string
  icon: IconName
  to: string
  matches: (route: Route) => boolean
}

const items: NavItem[] = [
  {
    label: 'Search',
    icon: 'search',
    to: '#/search',
    matches: (r) => r.name === 'search' || r.name === 'watch'
  },
  {
    label: 'Channels',
    icon: 'bookmark',
    to: '#/channels',
    matches: (r) => r.name === 'channels'
  },
  {
    label: 'Playlists',
    icon: 'playlist',
    to: '#/playlists',
    matches: (r) => r.name === 'playlists' || r.name === 'playlist' || r.name === 'ytpl'
  },
  { label: 'History', icon: 'history', to: '#/history', matches: (r) => r.name === 'history' },
  { label: 'Settings', icon: 'settings', to: '#/settings', matches: (r) => r.name === 'settings' }
]

const STORE_KEY = 'viewflux.sidebar'
const LEGACY_STORE_KEY = 'libretube.sidebar'

export function Sidebar(): React.JSX.Element {
  const route = useRoute()
  const [collapsed, setCollapsed] = useState(
    () => readStoredWithLegacy(STORE_KEY, LEGACY_STORE_KEY) === 'collapsed'
  )

  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => !value)
  }, [])

  // Drives the `--sidebar-w` override on the app grid.
  useEffect(() => {
    document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded'
    writeStored(STORE_KEY, collapsed ? 'collapsed' : 'expanded')
    if (collapsed) {
      document.documentElement.style.removeProperty('--sidebar-w')
    } else {
      const savedW = readStoredWithLegacy('viewflux.sidebar-w', 'libretube.sidebar-w')
      if (savedW) {
        document.documentElement.style.setProperty('--sidebar-w', savedW)
      }
    }
  }, [collapsed])

  const handleResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()

    document.documentElement.dataset.resizing = 'true'
    let rafId = 0
    let latestCollapsed = collapsed
    let latestWidth = 240

    const handlePointerMove = (moveEv: PointerEvent): void => {
      const currentWidth = moveEv.clientX
      if (currentWidth < 140) {
        latestCollapsed = true
      } else {
        latestCollapsed = false
        latestWidth = Math.max(160, Math.min(380, currentWidth))
      }

      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0
          if (latestCollapsed) {
            document.documentElement.dataset.sidebar = 'collapsed'
            document.documentElement.style.removeProperty('--sidebar-w')
          } else {
            document.documentElement.dataset.sidebar = 'expanded'
            document.documentElement.style.setProperty('--sidebar-w', `${latestWidth}px`)
          }
        })
      }
    }

    const handlePointerUp = (): void => {
      if (rafId) cancelAnimationFrame(rafId)
      delete document.documentElement.dataset.resizing

      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)

      setCollapsed(latestCollapsed)
      writeStored(STORE_KEY, latestCollapsed ? 'collapsed' : 'expanded')
      if (!latestCollapsed) {
        writeStored('viewflux.sidebar-w', `${latestWidth}px`)
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }, [collapsed])

  return (
    <nav className="sidebar" aria-label="Primary">
      <div
        className="sidebar__resizer"
        onPointerDown={handleResizePointerDown}
        title="Drag to resize sidebar (drag below 140px to collapse)"
      />
      <div className="sidebar__brand">
        <span className="sidebar__logo-wrap">
          <span className="sidebar__logo" aria-hidden="true">
            <svg width={24} height={24} viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </span>
        <div className="sidebar__brand-text">
          <span className="sidebar__title">ViewFlux</span>
        </div>
      </div>
      <ul className="sidebar__nav">
        {items.map((item) => {
          const active = item.matches(route)
          return (
            <li key={item.to}>
              {/* A real link: middle-click and Ctrl/Cmd-click open in a new
                  window, and assistive tech announces it as navigation. */}
              <a
                className={`nav-item${active ? ' nav-item--active' : ''}`}
                aria-current={active ? 'page' : undefined}
                title={item.label}
                {...routeLinkProps(item.to)}
              >
                <span className="nav-item__icon">
                  <Icon
                    name={item.icon === 'bookmark' && active ? 'bookmarkFilled' : item.icon}
                    size={24}
                  />
                </span>
                <span className="nav-item__label">{item.label}</span>
              </a>
            </li>
          )
        })}
      </ul>
      <div className="sidebar__footer">
        <button
          type="button"
          className="nav-item sidebar__toggle"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span className="nav-item__icon">
            <svg
              className="sidebar__toggle-icon"
              width={24}
              height={24}
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
            </svg>
          </span>
          <span className="nav-item__label">{collapsed ? 'Expand' : 'Collapse'}</span>
        </button>
      </div>
    </nav>
  )
}
