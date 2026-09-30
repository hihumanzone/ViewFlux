/**
 * Parses time strings from YouTube URLs (e.g. "120", "120s", "2m30s", "1h2m3s", "1h", "45m").
 * Returns seconds as an integer, or null if invalid.
 */
export function parseTimeString(t: string | null): number | null {
  if (!t) return null
  const clean = t.trim().toLowerCase()
  if (!clean) return null
  // Formats like "120", "120s", "120.5", "120.5s"
  if (/^\d+(?:\.\d+)?s?$/.test(clean)) {
    return Math.floor(parseFloat(clean))
  }
  // Formats like "1h2m3s", "2m30s", "1h30s", "45m", "1h"
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
  if (!input) return null
  let urlStr = input.trim()
  if (!urlStr) return null

  // Strip wrapping quotes or angle brackets: "...", '...', <...>
  if (
    (urlStr.startsWith('"') && urlStr.endsWith('"')) ||
    (urlStr.startsWith("'") && urlStr.endsWith("'")) ||
    (urlStr.startsWith('<') && urlStr.endsWith('>'))
  ) {
    urlStr = urlStr.slice(1, -1).trim()
  }
  if (!urlStr) return null

  if (!/^https?:\/\//i.test(urlStr)) {
    if (urlStr.startsWith('//')) {
      urlStr = 'https:' + urlStr
    } else if (
      /^(?:(?:www\.|m\.|music\.|gaming\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com))(?:[:\/?#]|$)/i.test(
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
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com')

  if (!isYouTube) return null

  const searchParams = parsed.searchParams
  const pathname = parsed.pathname.replace(/\/+$/, '')
  const segments = pathname.split('/').filter(Boolean)

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
  const timeParam = time ? `&t=${time}` : ''
  const soloTimeParam = time ? `?t=${time}` : ''

  // 1. youtu.be/VIDEO_ID
  if (host === 'youtu.be') {
    const videoId = segments[0]
    if (videoId) {
      const list = searchParams.get('list')
      if (list) {
        return `#/watch/${encodeURIComponent(videoId)}?list=yt:${encodeURIComponent(list)}${timeParam}`
      }
      return `#/watch/${encodeURIComponent(videoId)}${soloTimeParam}`
    }
    return null
  }

  // 2. youtube.com/watch
  if (segments[0] === 'watch') {
    const videoId = searchParams.get('v')
    const list = searchParams.get('list')

    if (videoId) {
      if (list) {
        return `#/watch/${encodeURIComponent(videoId)}?list=yt:${encodeURIComponent(list)}${timeParam}`
      }
      return `#/watch/${encodeURIComponent(videoId)}${soloTimeParam}`
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

  // 4. youtube.com/shorts/VIDEO_ID
  if (segments[0] === 'shorts' && segments[1]) {
    return `#/watch/${encodeURIComponent(segments[1])}${soloTimeParam}`
  }

  // 5. youtube.com/live/VIDEO_ID
  if (segments[0] === 'live' && segments[1]) {
    return `#/watch/${encodeURIComponent(segments[1])}${soloTimeParam}`
  }

  // 6. youtube.com/embed/VIDEO_ID or /v/VIDEO_ID
  if ((segments[0] === 'embed' || segments[0] === 'v') && segments[1]) {
    return `#/watch/${encodeURIComponent(segments[1])}${soloTimeParam}`
  }

  // 7. Channel by handle: /@handle, /@handle/videos, /@handle/playlists, etc.
  if (segments[0]?.startsWith('@')) {
    const handle = segments[0]
    const tab = segments[1]
    if (tab && ['videos', 'playlists', 'releases', 'about'].includes(tab.toLowerCase())) {
      return `#/channel/${encodeURIComponent(handle)}?tab=${tab.toLowerCase()}`
    }
    return `#/channel/${encodeURIComponent(handle)}`
  }

  // 8. Channel by /channel/CHANNEL_ID, /channel/CHANNEL_ID/videos, etc.
  if (segments[0] === 'channel' && segments[1]) {
    const channelId = segments[1]
    const tab = segments[2]
    if (tab && ['videos', 'playlists', 'releases', 'about'].includes(tab.toLowerCase())) {
      return `#/channel/${encodeURIComponent(channelId)}?tab=${tab.toLowerCase()}`
    }
    return `#/channel/${encodeURIComponent(channelId)}`
  }

  // 9. Channel by /c/NAME or /user/NAME
  if ((segments[0] === 'c' || segments[0] === 'user') && segments[1]) {
    const fullId = `${segments[0]}/${segments[1]}`
    const tab = segments[2]
    if (tab && ['videos', 'playlists', 'releases', 'about'].includes(tab.toLowerCase())) {
      return `#/channel/${encodeURIComponent(fullId)}?tab=${tab.toLowerCase()}`
    }
    return `#/channel/${encodeURIComponent(fullId)}`
  }

  // 10. Search query: /results?search_query=...
  if (segments[0] === 'results') {
    const query = searchParams.get('search_query') || searchParams.get('q')
    if (query) {
      return `#/search?q=${encodeURIComponent(query)}`
    }
  }

  return null
}
