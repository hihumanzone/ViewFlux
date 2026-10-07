import { useEffect, useState } from 'react'
import type { SearchFilter } from '../../../shared/types'

export type Route =
  | { name: 'search'; query: string; filter: SearchFilter }
  | { name: 'watch'; videoId: string; listId: string | null; time?: number | null }
  | { name: 'playlists' }
  | { name: 'playlist'; id: string }
  | { name: 'history' }
  | { name: 'settings' }
  | { name: 'channels'; tab: string | null }
  | { name: 'channel'; channelId: string; tab: string | null }
  | { name: 'ytpl'; playlistId: string }

const FILTERS: SearchFilter[] = ['all', 'videos', 'channels', 'playlists', 'albums', 'music']

function parseFilter(value: string | null): SearchFilter {
  return FILTERS.includes(value as SearchFilter) ? (value as SearchFilter) : 'all'
}

export function searchRoute(query: string, filter: SearchFilter = 'all'): string {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (filter !== 'all') params.set('f', filter)
  const qs = params.toString()
  return qs ? `#/search?${qs}` : '#/search'
}

export function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const [path, search = ''] = raw.split('?')
  const params = new URLSearchParams(search)
  const segments = path.split('/').filter(Boolean)

  switch (segments[0]) {
    case 'watch': {
      if (segments[1]) {
        const timeStr = params.get('t')
        const timeVal = timeStr ? parseInt(timeStr, 10) : null
        return {
          name: 'watch',
          videoId: segments[1],
          listId: params.get('list'),
          time: Number.isFinite(timeVal) && timeVal! > 0 ? timeVal : null
        }
      }
      return { name: 'search', query: '', filter: 'all' }
    }
    case 'playlists':
      return { name: 'playlists' }
    case 'playlist':
      if (segments[1]) return { name: 'playlist', id: segments[1] }
      return { name: 'playlists' }
    case 'history':
      return { name: 'history' }
    case 'settings':
      return { name: 'settings' }
    case 'channels':
      return { name: 'channels', tab: params.get('tab') }
    case 'channel': {
      const channelId = segments.slice(1).map(decodeURIComponent).join('/')
      if (channelId) return { name: 'channel', channelId, tab: params.get('tab') }
      return { name: 'search', query: '', filter: 'all' }
    }
    case 'ytpl':
      if (segments[1]) return { name: 'ytpl', playlistId: segments[1] }
      return { name: 'search', query: '', filter: 'all' }
    case 'search':
      return { name: 'search', query: params.get('q') ?? '', filter: parseFilter(params.get('f')) }
    default:
      return { name: 'search', query: '', filter: 'all' }
  }
}

/**
 * Returns the fallback logical parent route for any given route.
 * Used when direct navigation occurred or stack is at a single leaf.
 */
export function getLogicalParent(route: Route): string | null {
  switch (route.name) {
    case 'watch': {
      if (route.listId) {
        if (route.listId.startsWith('yt:')) {
          return `#/ytpl/${route.listId.slice(3)}`
        }
        return `#/playlist/${route.listId}`
      }
      return '#/search'
    }
    case 'playlist':
    case 'ytpl':
      return '#/playlists'
    case 'channel':
    case 'channels':
    case 'playlists':
    case 'history':
    case 'settings':
      return '#/search'
    case 'search':
      return route.query ? '#/search' : null
    default:
      return null
  }
}

function normalizeHash(hash: string): string {
  if (!hash || hash === '#' || hash === '#/') return '#/search'
  return hash.startsWith('#') ? hash : `#${hash}`
}

function isRootHash(hash: string): boolean {
  const norm = normalizeHash(hash)
  return norm === '#/search' || norm === '#/search?'
}

// Global hierarchical navigation state
let hierarchyStack: string[] = [
  typeof window !== 'undefined' && window.location.hash
    ? normalizeHash(window.location.hash)
    : '#/search'
]
let forwardStack: string[] = []
const subscribers = new Set<() => void>()

function notify(): void {
  for (const sub of subscribers) sub()
}

function isSiblingTransition(fromRoute: Route, toRoute: Route): boolean {
  // Video to video transitions (whether in playlist or standalone watch)
  if (fromRoute.name === 'watch' && toRoute.name === 'watch') {
    return true
  }
  // Search query to search query transitions
  if (fromRoute.name === 'search' && toRoute.name === 'search') {
    return true
  }
  // Channel tab transitions within same channel
  if (
    fromRoute.name === 'channel' &&
    toRoute.name === 'channel' &&
    fromRoute.channelId === toRoute.channelId
  ) {
    return true
  }
  // Tab switches inside the saved-channels screen
  if (fromRoute.name === 'channels' && toRoute.name === 'channels') {
    return true
  }
  return false
}

/**
 * Props for an anchor that navigates the app.
 *
 * Real `<a href="#/...">` elements are better than clickable `<div>`s: screen
 * readers announce them as links, they get a context menu, and Ctrl/Cmd-click
 * or middle-click open the route in a new window. A plain hash change would
 * bypass {@link navigate}, though, and the hierarchy stack drives our Back
 * button — so a plain left click is intercepted and routed through the
 * router, while every modified click falls through to the browser.
 */
export function routeLinkProps(to: string): {
  href: string
  onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void
} {
  return {
    href: normalizeHash(to),
    onClick: (event) => {
      if (event.defaultPrevented) return
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return
      }
      event.preventDefault()
      navigate(to)
    }
  }
}

export function navigate(to: string, clearForward = true): void {
  const target = normalizeHash(to)
  const current = normalizeHash(window.location.hash)

  if (target === current) {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    return
  }

  if (clearForward) {
    forwardStack = []
  }

  const fromRoute = parse(current)
  const toRoute = parse(target)

  // If navigating directly to home root, reset stack
  if (isRootHash(target)) {
    hierarchyStack = ['#/search']
  } else if (isSiblingTransition(fromRoute, toRoute)) {
    // Sibling replaces the current level
    if (hierarchyStack.length > 0) {
      hierarchyStack[hierarchyStack.length - 1] = target
    } else {
      hierarchyStack = ['#/search', target]
    }
  } else {
    // If target is already earlier in the stack (e.g. returning to an ancestor), trim back to it
    const existingIndex = hierarchyStack.indexOf(target)
    if (existingIndex >= 0) {
      hierarchyStack = hierarchyStack.slice(0, existingIndex + 1)
    } else {
      // If we were at watch with a playlist and target is that playlist, pop watch
      if (fromRoute.name === 'watch' && fromRoute.listId) {
        const parentPlaylist = fromRoute.listId.startsWith('yt:')
          ? `#/ytpl/${fromRoute.listId.slice(3)}`
          : `#/playlist/${fromRoute.listId}`
        if (target === parentPlaylist) {
          hierarchyStack.pop()
        } else {
          hierarchyStack.push(target)
        }
      } else {
        // Child navigation: push onto hierarchy stack
        hierarchyStack.push(target)
      }
    }
  }

  // Ensure root is at the bottom of the stack
  if (hierarchyStack.length === 0 || !isRootHash(hierarchyStack[0])) {
    hierarchyStack.unshift('#/search')
  }

  window.location.hash = target
  notify()
}

export function canGoBack(): boolean {
  const current = normalizeHash(
    typeof window !== 'undefined' ? window.location.hash : '#/search'
  )
  if (isRootHash(current)) return false
  if (hierarchyStack.length > 1) return true
  const route = parse(current)
  return getLogicalParent(route) !== null
}

export function goBack(): void {
  const current = normalizeHash(window.location.hash)
  if (isRootHash(current)) return

  // If stack has multiple entries, pop to the parent
  if (hierarchyStack.length > 1) {
    const popped = hierarchyStack.pop()!
    forwardStack.push(popped)
    const target = hierarchyStack[hierarchyStack.length - 1]
    window.location.hash = target
    notify()
    return
  }

  // Fallback to logical parent
  const route = parse(current)
  const parent = getLogicalParent(route)
  if (parent) {
    forwardStack.push(current)
    hierarchyStack = isRootHash(parent) ? ['#/search'] : ['#/search', parent]
    window.location.hash = parent
    notify()
  }
}

export function canGoForward(): boolean {
  return forwardStack.length > 0
}

export function goForward(): void {
  if (forwardStack.length === 0) return
  const next = forwardStack.pop()!
  navigate(next, false)
}

export function useCanGoBack(): boolean {
  const [canBack, setCanBack] = useState(() => canGoBack())

  useEffect(() => {
    const update = (): void => setCanBack(canGoBack())
    subscribers.add(update)
    window.addEventListener('hashchange', update)
    return () => {
      subscribers.delete(update)
      window.removeEventListener('hashchange', update)
    }
  }, [])

  return canBack
}

export function useCanGoForward(): boolean {
  const [canForward, setCanForward] = useState(() => canGoForward())

  useEffect(() => {
    const update = (): void => setCanForward(canGoForward())
    subscribers.add(update)
    window.addEventListener('hashchange', update)
    return () => {
      subscribers.delete(update)
      window.removeEventListener('hashchange', update)
    }
  }, [])

  return canForward
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash))

  useEffect(() => {
    const onChange = (): void => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', onChange)
    if (!window.location.hash) window.location.hash = '#/search'
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}
