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
  }, [collapsed])

  return (
    <nav className="sidebar" aria-label="Primary">
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
