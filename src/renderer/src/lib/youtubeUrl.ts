/**
 * YouTube paths that are known reserved routes and should never be treated as
 * channel vanity URLs.
 */
const RESERVED_PATHS = new Set([
  'watch',
  'playlist',
  'shorts',
  'live',
  'embed',
  'v',
  'e',
  'results',
  'channel',
  'c',
  'user',
  'u',
  'custom',
  'feed',
  'feeds',
  'gaming',
  'premium',
  'music',
  'trends',
  'about',
  'browse',
  'creators',
  'howyoutubeworks',
  'intl',
  'static',
  't',
  'yt',
  'redirect',
  'attribution_link',
  'account',
  'view_play_list',
  'shared',
  'logout',
  'login',
  'signin',
  'signup',
  'post',
  'clip',
  'hashtag',
  'explore',
  'subscriptions',
  'library',
  'history'
])

const KNOWN_CHANNEL_TABS = new Set(['videos', 'playlists', 'releases', 'about'])

/**
 * Parses time strings from YouTube URLs (e.g. "120", "120s", "2m30s", "1h2m3s", "1h", "45m", "01:23:45", "2:30").
 * Returns seconds as an integer, or null if invalid.
 */
export function parseTimeString(t: string | null): number | null {
  if (!t) return null
  const clean = t.trim().toLowerCase()
  if (!clean) return null

  // Colon notation: "HH:MM:SS" or "MM:SS"
  const colonMatch = clean.match(/^(?:(?:(\d+):)?(\d{1,2}):)?(\d{1,2})$/)
  if (colonMatch && (colonMatch[1] != null || colonMatch[2] != null)) {
    const hours = parseInt(colonMatch[1] || '0', 10)
    const mins = parseInt(colonMatch[2] || '0', 10)
    const secs = parseInt(colonMatch[3] || '0', 10)
    return Math.floor(hours * 3600 + mins * 60 + secs)
  }

  // Formats like "120", "120s", "120.5", "120.5s"
  if (/^\d+(?:\.\d+)?s?$/.test(clean)) {
    return Math.floor(parseFloat(clean))
  }

  // Formats like "1h2m3s", "1h30m", "2m30s", "1h30s", "45m", "1h"
  const match = clean.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/)
  if (match && (match[1] || match[2] || match[3])) {
    const hours = parseInt(match[1] || '0', 10)
    const mins = parseInt(match[2] || '0', 10)
    const secs = parseFloat(match[3] || '0')
    return Math.floor(hours * 3600 + mins * 60 + secs)
  }

  return null
}

/**
 * Resolves a YouTube URL into a ViewFlux route hash, e.g.:
 * - `#/watch/VIDEO_ID`
 * - `#/watch/VIDEO_ID?list=yt:PLAYLIST_ID`
 * - `#/watch/VIDEO_ID?list=yt:PLAYLIST_ID&t=120`
 * - `#/watch/VIDEO_ID?t=120`
 * - `#/ytpl/PLAYLIST_ID`
 * - `#/channel/@HANDLE`
 * - `#/channel/@HANDLE?tab=videos`
 * - `#/channel/CHANNEL_ID`
 * - `#/channel/c/NAME`
 *
 * Returns null if the input is not a recognized YouTube URL.
 */
export function resolveYouTubeUrl(input: string): string | null {
  try {
    if (!input) return null
    let urlStr = input.trim()
    if (!urlStr) return null

    // Strip enclosing quotes or brackets: "...", '...', <...>, (...)
    if (
      (urlStr.startsWith('"') && urlStr.endsWith('"')) ||
      (urlStr.startsWith("'") && urlStr.endsWith("'")) ||
      (urlStr.startsWith('<') && urlStr.endsWith('>')) ||
      (urlStr.startsWith('(') && urlStr.endsWith(')'))
    ) {
      urlStr = urlStr.slice(1, -1).trim()
    }
    if (!urlStr) return null

    // Strip trailing punctuation often copied from text/markdown
    urlStr = urlStr.replace(/[.,;:!?)]+$/, '').trim()
    if (!urlStr) return null

    if (!/^https?:\/\//i.test(urlStr)) {
      if (urlStr.startsWith('//')) {
        urlStr = 'https:' + urlStr
      } else if (
        /^(?:(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com))(?:[:\/?#]|$)/i.test(
          urlStr
        )
      ) {
        urlStr = 'https://' + urlStr
      } else {
        return null
      }
    }

    let parsed: URL
    try {
      parsed = new URL(urlStr)
    } catch {
      return null
    }

    const host = parsed.hostname.toLowerCase()
    const isYouTube =
      host === 'youtu.be' ||
      host.endsWith('.youtu.be') ||
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com')

    if (!isYouTube) return null

    const searchParams = parsed.searchParams
    const pathname = parsed.pathname.replace(/\/+$/, '')
    const segments = pathname.split('/').filter(Boolean)

    // Handle attribution links: /attribution_link?u=/watch?v=...
    if (segments[0] === 'attribution_link') {
      const u = searchParams.get('u')
      if (u) {
        const nested = u.startsWith('http')
          ? u
          : `https://www.youtube.com${u.startsWith('/') ? '' : '/'}${u}`
        return resolveYouTubeUrl(nested)
      }
    }

    // Handle redirects: /redirect?q=...
    if (segments[0] === 'redirect') {
      const q = searchParams.get('q')
      if (q) {
        return resolveYouTubeUrl(q)
      }
    }

    const extractTime = (): number | null => {
      let t = searchParams.get('t') || searchParams.get('time_continue') || searchParams.get('start')
      if (!t && parsed.hash) {
        const cleanHash = parsed.hash.replace(/^#/, '')
        const hashParams = new URLSearchParams(cleanHash)
        t = hashParams.get('t') || hashParams.get('time_continue') || hashParams.get('start')
        if (!t && cleanHash.startsWith('t=')) {
          t = cleanHash.slice(2)
        }
      }
      const parsedTime = parseTimeString(t)
      return parsedTime != null && parsedTime > 0 ? parsedTime : null
    }

    const time = extractTime()
    const buildWatchRoute = (videoId: string, listId?: string | null): string => {
      const list = listId || searchParams.get('list')
      const timeParam = time ? `&t=${time}` : ''
      const soloTimeParam = time ? `?t=${time}` : ''
      if (list) {
        return `#/watch/${encodeURIComponent(videoId)}?list=yt:${encodeURIComponent(list)}${timeParam}`
      }
      return `#/watch/${encodeURIComponent(videoId)}${soloTimeParam}`
    }

    // 1. youtu.be/VIDEO_ID
    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      const videoId = segments[0]
      if (videoId && !RESERVED_PATHS.has(videoId.toLowerCase())) {
        return buildWatchRoute(videoId, searchParams.get('list'))
      }
      return null
    }

    // 2. youtube.com/watch
    if (segments[0] === 'watch') {
      const videoId = searchParams.get('v')
      const list = searchParams.get('list')

      if (videoId) {
        return buildWatchRoute(videoId, list)
      }
      if (list) {
        return `#/ytpl/${encodeURIComponent(list)}`
      }
      return null
    }

    // 3. youtube.com/playlist
    if (segments[0] === 'playlist') {
      const list = searchParams.get('list')
      if (list) {
        return `#/ytpl/${encodeURIComponent(list)}`
      }
      return null
    }

    // 4. youtube.com/view_play_list (legacy playlist)
    if (segments[0] === 'view_play_list') {
      const list = searchParams.get('p') || searchParams.get('list')
      if (list) {
        return `#/ytpl/${encodeURIComponent(list)}`
      }
      return null
    }

    // 5. youtube.com/shorts/VIDEO_ID
    if (segments[0] === 'shorts' && segments[1]) {
      return buildWatchRoute(segments[1], searchParams.get('list'))
    }

    // 6. youtube.com/live/VIDEO_ID
    if (segments[0] === 'live' && segments[1]) {
      return buildWatchRoute(segments[1], searchParams.get('list'))
    }

    // 7. youtube.com/embed/VIDEO_ID, /v/VIDEO_ID, /e/VIDEO_ID
    if ((segments[0] === 'embed' || segments[0] === 'v' || segments[0] === 'e') && segments[1]) {
      return buildWatchRoute(segments[1], searchParams.get('list'))
    }

    // Helper for channel tab parameter
    const channelTabParam = (tab?: string): string => {
      if (tab && KNOWN_CHANNEL_TABS.has(tab.toLowerCase())) {
        return `?tab=${tab.toLowerCase()}`
      }
      return ''
    }

    // 8. Channel by handle: /@handle, /@handle/videos, /@handle/playlists, etc.
    if (segments[0]?.startsWith('@')) {
      const handle = segments[0]
      return `#/channel/${encodeURIComponent(handle)}${channelTabParam(segments[1])}`
    }

    // 9. Channel by /channel/CHANNEL_ID
    if (segments[0] === 'channel' && segments[1]) {
      const channelId = segments[1]
      return `#/channel/${encodeURIComponent(channelId)}${channelTabParam(segments[2])}`
    }

    // 10. Channel by /c/NAME, /user/NAME, /custom/NAME, /u/NAME
    if (['c', 'user', 'custom', 'u'].includes(segments[0]?.toLowerCase()) && segments[1]) {
      const prefix = segments[0].toLowerCase() === 'u' ? 'user' : segments[0]
      const fullId = `${prefix}/${segments[1]}`
      return `#/channel/${encodeURIComponent(fullId)}${channelTabParam(segments[2])}`
    }

    // 11. Search query: /results?search_query=...
    if (segments[0] === 'results') {
      const query = searchParams.get('search_query') || searchParams.get('q')
      if (query) {
        return `#/search?q=${encodeURIComponent(query)}`
      }
    }

    // 12. Vanity channel URLs: /TheInfographicsShow or /TheInfographicsShow/videos
    if (segments.length >= 1 && segments.length <= 2) {
      const first = segments[0]
      if (first && !RESERVED_PATHS.has(first.toLowerCase())) {
        return `#/channel/${encodeURIComponent(first)}${channelTabParam(segments[1])}`
      }
    }

    return null
  } catch {
    return null
  }
}
