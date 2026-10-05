import type {
  ChannelSummary,
  PlaylistSummary,
  SearchItem,
  VideoSummary
} from '../../shared/types'
import type {
  LockupViewNode,
  PlaylistFeed,
  TextLike,
  ThumbLike
} from './types'
import {
  absUrl,
  classifyChannelTexts,
  hasMusicBadge,
  lockupAuthor,
  lockupBadges,
  lockupRows,
  parseCompactCount,
  parseDurationText,
  pickThumbnail,
  splitReleaseByline,
  text
} from './parsers'

/** YouTube Music serves every music release as an auto-generated playlist. */
export const RELEASE_PLAYLIST_PREFIX = 'OLAK5uy_'

/**
 * LockupView `content_type`s that carry a playlist. Album lockups are labelled
 * `ALBUM`, not `PLAYLIST` — NewPipe drops those, which is why some clients show
 * an empty discography for auto-generated topic channels.
 */
export const PLAYLIST_LOCKUP_TYPES = ['PLAYLIST', 'ALBUM', 'PODCAST', 'SHOW']

/** Node types a feed contributes playlists from (youtubei.js `GridShow` ≈ show). */
export const PLAYLIST_NODE_TYPES = ['Playlist', 'GridPlaylist', 'GridShow']

/** "13 videos" / "13 songs" / "9 tracks" — the count on a playlist or album card. */
export const TRACK_COUNT_REGEX = /\d+\s*(?:videos?|songs?|tracks?)\b/i

/** Type words LockupViews put in their first metadata row instead of a byline. */
export const PLAYLIST_TYPE_WORDS = /^(?:playlist|album|ep|single|music video|video)$/i

/** "13 videos" — YouTube's wording for a track count. */
export const VIDEO_COUNT_REGEX = /^(\d[\d,.]*)\s+videos?$/i

/** An album's tracks are songs; the raw count text still says "videos". */
export function trackCountText(countText: string | null, isAlbum: boolean): string | null {
  if (!isAlbum || !countText) return countText
  return countText.replace(VIDEO_COUNT_REGEX, (_match, n: string) => {
    const count = Number.parseInt(n.replace(/[,.]/g, ''), 10)
    return `${n} ${count === 1 ? 'song' : 'songs'}`
  })
}

export function isLockup(node: unknown): node is LockupViewNode {
  return (node as { type?: string })?.type === 'LockupView'
}

/** Classic `Video` / `GridVideo` search node. */
export function toSummary(node: unknown): VideoSummary | null {
  const v = node as {
    video_id?: string
    id?: string
    title?: TextLike
    author?: {
      name?: string
      id?: string
      best_thumbnail?: { url?: string }
      thumbnails?: ThumbLike[]
      endpoint?: { browseEndpoint?: { browseId?: string }; payload?: { browseId?: string } }
    }
    duration?: { seconds?: number }
    thumbnails?: ThumbLike[]
    view_count?: TextLike
    short_view_count?: TextLike
    views?: TextLike
    published?: TextLike
    video_info?: TextLike
    accessibility_label?: string
    is_live?: boolean
  }
  const videoId = v.video_id ?? v.id
  if (!videoId) return null
  const authorId =
    v.author?.id ??
    v.author?.endpoint?.payload?.browseId ??
    v.author?.endpoint?.browseEndpoint?.browseId ??
    null

  let viewCount =
    parseCompactCount(text(v.view_count)) ??
    parseCompactCount(text(v.short_view_count)) ??
    parseCompactCount(text(v.views))
  let published = text(v.published) || null

  const viText = text(v.video_info)
  if (viText) {
    const parts = viText
      .split(/[•·|]/)
      .map((p) => p.trim())
      .filter(Boolean)
    for (const part of parts) {
      if (!published && /ago|streamed|premiered|\d{4}/i.test(part)) {
        published = part
      } else if (viewCount == null && /\d/.test(part) && !part.startsWith('@')) {
        viewCount = parseCompactCount(part)
      }
    }
    if (viewCount == null) {
      const match = viText.match(/(\d[\d,.]*\s*[KMBkmb]?)\s*(?:views)?/i)
      if (match) viewCount = parseCompactCount(match[1])
    }
    if (!published) {
      const match = viText.match(
        /((?:(?:streamed(?: live)?|premiered)\s+)?(?:\d+\s+(?:years?|months?|weeks?|days?|hours?|minutes?|y|mo|w|d|h|m)\s+ago|\w+\s+\d{1,2},\s*\d{4}))/i
      )
      if (match) published = match[1]
    }
  }

  // Fallback to accessibility label if still missing
  if ((viewCount == null || !published) && v.accessibility_label) {
    const a11y = v.accessibility_label
    if (viewCount == null) {
      const vMatch = a11y.match(/(\d[\d,.]*\s*[KMBkmb]?|\d[\d,.]*)\s+views/i)
      if (vMatch) viewCount = parseCompactCount(vMatch[1])
    }
    if (!published) {
      const pMatch = a11y.match(
        /((?:(?:streamed(?: live)?|premiered)\s+)?\d+\s+(?:years?|months?|weeks?|days?|hours?|minutes?)\s+ago)/i
      )
      if (pMatch) published = pMatch[1]
    }
  }

  const isLive = Boolean(v.is_live)
  const isPremiere = Boolean(
    (v as any).is_premiere ||
    (v as any).badges?.some((b: any) => /premiere/i.test(text(b?.label ?? b?.text))) ||
    /premiered?/i.test(viText) ||
    /premiered?/i.test(published ?? '')
  )
  const isStreamed = Boolean(
    !isLive && (
      /streamed/i.test(viText) ||
      /streamed/i.test(published ?? '') ||
      /streamed/i.test(v.accessibility_label ?? '') ||
      (v as any).badges?.some((b: any) => /streamed/i.test(text(b?.label ?? b?.text)))
    )
  )

  let publishTimestamp: number | null = null
  if (published) {
    const dateMatch = published.match(
      /(?:streamed(?: live)?|premiered)?\s*(?:on\s+)?([A-Za-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/i
    )
    if (dateMatch) {
      const parsed = Date.parse(dateMatch[1])
      if (!Number.isNaN(parsed)) publishTimestamp = parsed
    }
  }

  return {
    videoId,
    title: text(v.title),
    author: v.author?.name ?? '',
    authorId,
    authorAvatar:
      pickThumbnail(v.author?.thumbnails, 240) || absUrl(v.author?.best_thumbnail?.url) || null,
    duration: v.duration?.seconds ?? null,
    thumbnail: pickThumbnail(v.thumbnails),
    viewCount,
    published,
    publishTimestamp,
    isPremiere,
    isStreamed,
    isLive
  }
}

/**
 * New unified `LockupView` renderer (channel videos, playlists, remote
 * playlist items…). `ctx` optionally supplies channel context.
 */
export function toLockupVideo(
  node: unknown,
  ctx?: { author?: string | null; authorId?: string | null; authorAvatar?: string | null }
): VideoSummary | null {
  if (!isLockup(node)) return toSummary(node)
  if (!node.content_id || node.content_type !== 'VIDEO') return null

  const thumbs = node.content_image?.image
  const badges = lockupBadges(node)
  const durationBadge = badges.find((b) => b.includes(':'))
  const rows = lockupRows(node)

  let authorAvatar: string | null = ctx?.authorAvatar ?? null
  if (!authorAvatar) {
    const metaImg = (node as any).metadata?.image
    const avatarImages = (metaImg?.avatar?.image ??
      metaImg?.avatar?.sources ??
      metaImg?.decoratedAvatarViewModel?.avatar?.image ??
      metaImg?.decoratedAvatarViewModel?.avatar?.sources) as ThumbLike[] | undefined
    if (Array.isArray(avatarImages) && avatarImages.length > 0) {
      authorAvatar = pickThumbnail(avatarImages, 240) || absUrl(avatarImages[0]?.url) || null
    }
  }

  let authorId: string | null = ctx?.authorId ?? null
  if (!authorId) {
    const metaImg = (node as any).metadata?.image
    const imgBrowseId =
      metaImg?.renderer_context?.command_context?.on_tap?.payload?.browseId ??
      metaImg?.avatar?.endpoint?.payload?.browseId ??
      metaImg?.endpoint?.payload?.browseId ??
      metaImg?.on_tap_endpoint?.payload?.browseId
    if (typeof imgBrowseId === 'string' && imgBrowseId) {
      authorId = imgBrowseId
    }
  }
  if (!authorId) {
    const rawRows = (node as any).metadata?.metadata?.metadata_rows ?? []
    for (const row of rawRows) {
      for (const part of row.metadata_parts ?? []) {
        const ep =
          part.endpoint?.payload?.browseId ??
          part.endpoint?.browseEndpoint?.browseId ??
          part.endpoint?.browseId ??
          part.text?.endpoint?.payload?.browseId ??
          part.text?.runs?.[0]?.endpoint?.payload?.browseId
        if (typeof ep === 'string' && ep) {
          authorId = ep
          break
        }
      }
      if (authorId) break
    }
  }

  let author: string | null = ctx?.author ?? null
  if (author == null) {
    const firstRow = rows[0] ?? []
    const candidate =
      firstRow.find(
        (p) =>
          /[a-zA-Z]/.test(p) &&
          !/^(playlist|mixes?)$/i.test(p.trim()) &&
          !/ago|streamed|premiered/i.test(p) &&
          !/^\d[\d,.\sKMB]*\s*(views|subscribers|followers)?$/i.test(p.trim())
      ) ?? null
    if (candidate) {
      author = candidate
    } else {
      const a11y = (node as any).metadata?.image?.a11y_label
      if (typeof a11y === 'string' && a11y) {
        author = a11y.replace(/^go to channel\s+/i, '').replace(/^go to\s+/i, '').trim()
      }
    }
  }

  let viewsText: string | null = null
  let published: string | null = null
  for (const row of rows) {
    for (const part of row) {
      if (author && part === author) continue
      if (!published && /ago|streamed|premiered/i.test(part)) published = part
      else if (!viewsText && /\d/.test(part) && !part.startsWith('@')) viewsText = part
    }
  }

  const isLive = Boolean(durationBadge && /live/i.test(durationBadge))
  const isPremiere = Boolean(
    badges.some((b) => /premiere/i.test(b)) ||
    (node as any).metadata?.badges?.some((b: any) => /premiere/i.test(text(b))) ||
    rows.some((r) => r.some((part) => /premiered?/i.test(part))) ||
    /premiered?/i.test(published ?? '')
  )
  const isStreamed = Boolean(
    !isLive && (
      rows.some((r) => r.some((part) => /streamed/i.test(part))) ||
      /streamed/i.test(published ?? '') ||
      badges.some((b) => /streamed/i.test(b))
    )
  )

  let publishTimestamp: number | null = null
  if (published) {
    const dateMatch = published.match(
      /(?:streamed(?: live)?|premiered)?\s*(?:on\s+)?([A-Za-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/i
    )
    if (dateMatch) {
      const parsed = Date.parse(dateMatch[1])
      if (!Number.isNaN(parsed)) publishTimestamp = parsed
    }
  }

  return {
    videoId: node.content_id,
    title: text(node.metadata?.title),
    author: author ?? '',
    authorId,
    authorAvatar,
    duration: durationBadge ? parseDurationText(durationBadge) : null,
    thumbnail: pickThumbnail(thumbs, 480),
    viewCount: parseCompactCount(viewsText),
    published,
    publishTimestamp,
    isPremiere,
    isStreamed,
    isLive
  }
}

export function toChannelSummary(node: unknown): ChannelSummary | null {
  const c = node as {
    type?: string
    id?: string
    author?: {
      name?: string
      id?: string
      thumbnails?: ThumbLike[]
      best_thumbnail?: { url?: string }
      avatar_thumbnail_url?: string
      badges?: unknown[]
    }
    description?: TextLike
    subscriber_count?: TextLike
    subscribers?: TextLike
    video_count?: TextLike
  }
  const id = c?.id ?? c?.author?.id
  if (!id) return null
  const { handle, subscribers, videoCount } = classifyChannelTexts([
    text(c.subscriber_count),
    text(c.subscribers),
    text(c.video_count)
  ])
  const avatar =
    pickThumbnail(c.author?.thumbnails, 240) ||
    absUrl(c.author?.best_thumbnail?.url) ||
    absUrl(c.author?.avatar_thumbnail_url) ||
    null
  return {
    id,
    name: c.author?.name ?? '',
    avatar,
    handle,
    subscribers,
    videoCount,
    description: text(c.description) || null,
    isMusic: hasMusicBadge(c.author?.badges)
  }
}

/**
 * Maps a playlist or music-release node. `isRelease` marks nodes that come
 * from a channel's "Releases" tab, where every entry is an album even if
 * YouTube hands out a plain playlist id.
 */
export function toPlaylistSummary(node: unknown, isRelease = false): PlaylistSummary | null {
  if (isLockup(node)) {
    if (!node.content_id) return null
    const isAlbum = isRelease || node.content_type === 'ALBUM'
    if (node.content_type !== 'PLAYLIST' && !isAlbum) return null
    const thumbs = node.content_image?.primary_thumbnail?.image
    const countText =
      lockupBadges(node).find((b) => TRACK_COUNT_REGEX.test(b)) ??
      lockupRows(node).flat().find((p) => TRACK_COUNT_REGEX.test(p)) ??
      null
    const firstRow = lockupRows(node)[0] ?? []
    const byline =
      firstRow.find(
        (p) => p && !PLAYLIST_TYPE_WORDS.test(p.trim()) && !/^view /i.test(p)
      ) ?? null
    const { artist: author, year } = isAlbum
      ? splitReleaseByline(byline)
      : { artist: byline, year: null }
    const { authorId, authorAvatar } = lockupAuthor(node)
    return {
      id: node.content_id,
      title: text(node.metadata?.title),
      author,
      authorId,
      authorAvatar,
      count: parseCompactCount(countText),
      countText: trackCountText(countText, isAlbum),
      thumbnail: thumbs ? pickThumbnail(thumbs, 480) : null,
      isAlbum,
      year
    }
  }

  const p = node as {
    id?: string
    playlist_id?: string
    title?: TextLike
    author?: {
      name?: string
      id?: string
      channel_id?: string
      thumbnails?: ThumbLike[]
      avatar_thumbnail_url?: string
      endpoint?: { payload?: { browseId?: string } }
    }
    video_count?: TextLike
    thumbnails?: ThumbLike[]
    thumbnail_renderer?: { thumbnail?: ThumbLike[] }
  }
  const pid = p?.id ?? p?.playlist_id
  if (!pid) return null
  const isAlbum = isRelease || pid.startsWith(RELEASE_PLAYLIST_PREFIX)
  const byline = p.author?.name ?? null
  const { artist: author, year } = isAlbum
    ? splitReleaseByline(byline)
    : { artist: byline, year: null }
  const countText = text(p.video_count) || null
  return {
    id: pid,
    title: text(p.title),
    author,
    authorId:
      p.author?.channel_id ?? p.author?.id ?? p.author?.endpoint?.payload?.browseId ?? null,
    authorAvatar:
      pickThumbnail(p.author?.thumbnails, 240) || absUrl(p.author?.avatar_thumbnail_url) || null,
    count: parseCompactCount(countText),
    countText: trackCountText(countText, isAlbum),
    thumbnail:
      pickThumbnail(p.thumbnail_renderer?.thumbnail, 480) || pickThumbnail(p.thumbnails, 480) || null,
    isAlbum,
    year
  }
}

/** YouTube Music search result item. */
export function toMusicSummary(node: unknown): VideoSummary | null {
  const m = node as {
    id?: string
    title?: string
    author?: {
      name?: string
      id?: string
      channel_id?: string
      thumbnail?: { thumbnails?: ThumbLike[] }
      endpoint?: { payload?: { browseId?: string } }
    }
    authors?: {
      name?: string
      channel_id?: string
      id?: string
      thumbnail?: { thumbnails?: ThumbLike[] }
      endpoint?: { payload?: { browseId?: string } }
    }[]
    duration?: { seconds?: number; text?: string }
    views?: string
    thumbnails?: ThumbLike[]
  }
  if (!m?.id) return null
  const authorId =
    m.authors?.[0]?.channel_id ??
    m.authors?.[0]?.id ??
    m.authors?.[0]?.endpoint?.payload?.browseId ??
    m.author?.channel_id ??
    m.author?.id ??
    m.author?.endpoint?.payload?.browseId ??
    null
  const authorThumbs =
    m.authors?.[0]?.thumbnail?.thumbnails ?? m.author?.thumbnail?.thumbnails ?? undefined
  return {
    videoId: m.id,
    title: m.title ?? '',
    author: m.authors?.[0]?.name ?? m.author?.name ?? '',
    authorId,
    authorAvatar: pickThumbnail(authorThumbs, 240) || null,
    duration: m.duration?.seconds ?? parseDurationText(m.duration?.text),
    thumbnail: pickThumbnail(m.thumbnails, 480),
    viewCount: parseCompactCount(m.views),
    published: null,
    isLive: false
  }
}

export function dedupe(items: SearchItem[]): SearchItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.type}:${'videoId' in item ? item.videoId : 'id' in item ? item.id : ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function feedVideos(
  feed: unknown,
  ctx?: { author?: string | null; authorId?: string | null; authorAvatar?: string | null }
): VideoSummary[] {
  let nodes: unknown[] | undefined
  try {
    const videos = (feed as { videos?: unknown[] }).videos
    if (Array.isArray(videos)) nodes = videos
  } catch {
    /* ignore */
  }
  if (!nodes) {
    try {
      const items = (feed as { items?: unknown[] }).items
      if (Array.isArray(items)) nodes = items
    } catch {
      /* ignore */
    }
  }
  if (!nodes) {
    const results = (feed as { results?: unknown[] })?.results
    if (Array.isArray(results)) nodes = results
  }
  const items: VideoSummary[] = []
  for (const node of nodes ?? []) {
    const summary = toLockupVideo(node, ctx)
    if (summary) items.push(summary)
  }
  return items
}

export function feedPlaylists(feed: PlaylistFeed | null | undefined, isRelease = false): PlaylistSummary[] {
  const nodes = feed?.playlists ?? feed?.results ?? []
  return nodes
    .map((n) => toPlaylistSummary(n, isRelease))
    .filter((p): p is PlaylistSummary => p !== null)
}
