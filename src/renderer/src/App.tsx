import { useEffect, useMemo, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { ScrollToTop } from './components/ScrollToTop'
import { SelectionCopyTooltip } from './components/SelectionCopyTooltip'
import { goBack, goForward, navigate, parse, useRoute, type Route } from './lib/router'
import { scrollPageToTop } from './lib/scroll'
import { clearPlaylistSession } from './lib/playlistSession'
import { clearSleepTimer } from './lib/sleepTimer'
import { SearchPage } from './pages/SearchPage'
import { WatchPage } from './pages/WatchPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { PlaylistDetailPage } from './pages/PlaylistDetailPage'
import { HistoryPage } from './pages/HistoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { ChannelPage } from './pages/ChannelPage'
import { RemotePlaylistPage } from './pages/RemotePlaylistPage'
import { SavedChannelsPage } from './pages/SavedChannelsPage'

/** Identity of the current screen, so the boundary resets when the route changes. */
function routeKey(route: Route): string {
  return route.name === 'watch'
    ? `watch:${route.videoId}`
    : route.name === 'search'
      ? 'search'
      : route.name === 'channel'
        ? `channel:${route.channelId}|${route.tab ?? ''}`
        : route.name === 'playlist'
          ? `playlist:${route.id}`
          : route.name === 'ytpl'
            ? `ytpl:${route.playlistId}`
            : route.name === 'channels'
              ? `channels:${route.tab ?? ''}`
              : route.name
}

/** True when the focused element is somewhere the user is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

export function App(): React.JSX.Element {
  const route = useRoute()
  const key = useMemo(() => routeKey(route), [route])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const [activeWatch, setActiveWatch] = useState<{
    videoId: string
    listId: string | null
    time?: number | null
  } | null>(() => {
    const init = parse(typeof window !== 'undefined' ? window.location.hash : '')
    return init.name === 'watch'
      ? { videoId: init.videoId, listId: init.listId, time: init.time }
      : null
  })

  // Sync activeWatch when navigating to a watch route
  useEffect(() => {
    if (route.name === 'watch') {
      setActiveWatch((prev) => {
        if (prev?.videoId === route.videoId && prev?.listId === route.listId) {
          return prev
        }
        return { videoId: route.videoId, listId: route.listId, time: route.time }
      })
    }
  }, [route])

  const isMini = Boolean(
    activeWatch && (route.name !== 'watch' || route.videoId !== activeWatch.videoId)
  )

  useEffect(() => {
    document.documentElement.dataset.miniplayer = isMini ? 'true' : 'false'
  }, [isMini])

  // Reset page scroller to top on route change
  useEffect(() => {
    scrollPageToTop('auto')
  }, [key])

  useEffect(() => {
    // 1. Prevent default native drag ghosts (localhost URLs / images)
    const handleDragStart = (e: DragEvent): void => {
      e.preventDefault()
    }

    // 2. Track keyboard vs pointer modality
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Show focus outlines ONLY when tabbing through the interface
      if (e.key === 'Tab') {
        document.documentElement.classList.add('keyboard-nav')
      }

      // Alt+Left is the app-wide "back" gesture. Skip it while typing so
      // Alt+Left inside the search box still edits the text.
      if (e.altKey && e.key === 'ArrowLeft') {
        if (isTypingTarget(document.activeElement)) return
        e.preventDefault()
        goBack()
        return
      }

      // Alt+Right is the app-wide "forward" gesture. Skip it while typing.
      if (e.altKey && e.key === 'ArrowRight') {
        if (isTypingTarget(document.activeElement)) return
        e.preventDefault()
        goForward()
        return
      }

      // `/` focuses search from anywhere, the way every other search-first app
      // behaves. Escape gives the field back, so a stray keypress does not
      // silently steal focus while the user is browsing.
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTypingTarget(document.activeElement)) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('viewflux:focus-search'))
        return
      }

      // Ctrl/Cmd+F is find-on-the-page in every other app, and there is nothing
      // useful for it to do here. The search field is the closest equivalent.
      if (e.key === 'f' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('viewflux:focus-search'))
        return
      }

      // `?` opens keyboard shortcuts cheat sheet
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTypingTarget(document.activeElement)) return
        e.preventDefault()
        setShortcutsOpen(true)
      }
    }

    const handlePointerDown = (e: PointerEvent): void => {
      document.documentElement.classList.remove('keyboard-nav')
      // If clicking outside text inputs, clear dormant activeElement focus
      // so subsequent shortcut keypresses (like Space, Arrows, letters) don't
      // trap focus or trigger unwanted focus borders on previously clicked elements.
      const target = e.target as HTMLElement | null
      const isInput = target?.closest('input, textarea, select, [contenteditable="true"]')
      if (!isInput && document.activeElement && document.activeElement !== document.body) {
        (document.activeElement as HTMLElement).blur?.()
      }
    }

    const handleOpenShortcuts = (): void => setShortcutsOpen(true)

    window.addEventListener('dragstart', handleDragStart)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('viewflux:open-shortcuts', handleOpenShortcuts)
    return () => {
      window.removeEventListener('dragstart', handleDragStart)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('viewflux:open-shortcuts', handleOpenShortcuts)
    }
  }, [])

  // Exit fullscreen if navigating away from watch screen, or clear playlist session when exiting playlist
  useEffect(() => {
    if (route.name !== 'watch' && typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    }
    if (!activeWatch?.listId && (route.name !== 'watch' || !route.listId)) {
      clearPlaylistSession()
    }
  }, [route.name, route.name === 'watch' ? route.listId : null, activeWatch?.listId])

  return (
    <div className="app">
      {/* Lets keyboard users jump past the title bar and five nav items on every
          single page. Hidden until focused, so it costs nothing visually. */}
      <a className="skip-link" href="#main-content" onClick={focusContent}>
        Skip to content
      </a>
      <TitleBar />
      <Sidebar />
      <main
        className={`content${route.name === 'search' ? ' content--search' : ''}`}
        id="main-content"
        tabIndex={-1}
      >
        {route.name !== 'watch' && (
          <ErrorBoundary resetKey={key}>{renderRoute(route)}</ErrorBoundary>
        )}
        {activeWatch && (
          <WatchPage
            key={activeWatch.videoId}
            videoId={activeWatch.videoId}
            listId={activeWatch.listId}
            initialSeek={activeWatch.time}
            isMini={isMini}
            onClose={() => {
              setActiveWatch(null)
              clearPlaylistSession()
              clearSleepTimer()
            }}
            onExpand={() =>
              navigate(
                activeWatch.listId
                  ? `#/watch/${activeWatch.videoId}?list=${activeWatch.listId}`
                  : `#/watch/${activeWatch.videoId}`
              )
            }
            onAdvanceVideo={(nextId) =>
              setActiveWatch((prev) => (prev ? { ...prev, videoId: nextId, time: 0 } : null))
            }
          />
        )}
      </main>
      <ScrollToTop />
      <SelectionCopyTooltip />
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  )
}

/**
 * Move focus into the content region. An anchor alone only scrolls, which
 * leaves the next Tab still on the sidebar — the whole point of a skip link is
 * that the *next* keystroke lands in the page.
 */
function focusContent(event: React.MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault()
  document.getElementById('main-content')?.focus()
  scrollPageToTop('auto')
}

function renderRoute(route: Route): React.JSX.Element | null {
  switch (route.name) {
    case 'search':
      return <SearchPage query={route.query} filter={route.filter} />
    case 'watch':
      return null
    case 'playlists':
      return <PlaylistsPage />
    case 'playlist':
      return <PlaylistDetailPage key={route.id} id={route.id} />
    case 'history':
      return <HistoryPage />
    case 'settings':
      return <SettingsPage />
    case 'channels':
      return <SavedChannelsPage initialTab={route.tab} />
    case 'channel':
      return <ChannelPage key={route.channelId} channelId={route.channelId} initialTab={route.tab} />

    case 'ytpl':
      return <RemotePlaylistPage key={route.playlistId} playlistId={route.playlistId} />
    default:
      return null
  }
}
