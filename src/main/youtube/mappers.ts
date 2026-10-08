import type {
  ArtistRef,
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
export function toSummary(
  node: unknown,
  ctx?: { author?: string | null; authorId?: string | null; authorAvatar?: string | null }
): VideoSummary | null {
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
    ctx?.authorId ??
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
    author: v.author?.name || ctx?.author || '',
    authorId,
    authorAvatar:
      pickThumbnail(v.author?.thumbnails, 240) ||
      absUrl(v.author?.best_thumbnail?.url) ||
      ctx?.authorAvatar ||
      null,
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
  if (!isLockup(node)) return toSummary(node, ctx)
  if (!node.content_id || node.content_type !== 'VIDEO') return null

  const thumbs = node.content_image?.image
  const badges = lockupBadges(node)
  const durationBadge = badges.find((b) => b.includes(':'))
  const rows = lockupRows(node)

  const metaImg = (node as any).metadata?.image
  const avatarImages = (metaImg?.avatar?.image ??
    metaImg?.avatar?.sources ??
    metaImg?.decoratedAvatarViewModel?.avatar?.image ??
    metaImg?.decoratedAvatarViewModel?.avatar?.sources ??
    metaImg?.avatars?.[0]?.image) as ThumbLike[] | undefined

  let authorAvatar: string | null =
    (Array.isArray(avatarImages) && avatarImages.length > 0
      ? pickThumbnail(avatarImages, 240) || absUrl(avatarImages[0]?.url) || null
      : null) ??
    ctx?.authorAvatar ??
    null

  let authorId: string | null =
    metaImg?.renderer_context?.command_context?.on_tap?.payload?.browseId ??
    metaImg?.avatar?.endpoint?.payload?.browseId ??
    metaImg?.endpoint?.payload?.browseId ??
    metaImg?.on_tap_endpoint?.payload?.browseId ??
    null

  const rawRows = (node as any).metadata?.metadata?.metadata_rows ?? []
  if (!authorId) {
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

  if (!authorId) {
    const listItems =
      metaImg?.renderer_context?.command_context?.on_tap?.payload?.panelLoadingStrategy?.inlineContent
        ?.dialogViewModel?.customContent?.listViewModel?.listItems
    const firstBrowseId =
      listItems?.[0]?.listItemViewModel?.title?.commandRuns?.[0]?.onTap?.innertubeCommand
        ?.browseEndpoint?.browseId ??
      listItems?.[0]?.renderer_context?.command_context?.on_tap?.payload?.browseId
    if (typeof firstBrowseId === 'string' && firstBrowseId) {
      authorId = firstBrowseId
    }
  }

  if (!authorId) {
    authorId = ctx?.authorId ?? null
  }

  let author: string | null = null
  for (const row of rawRows) {
    for (const part of row.metadata_parts ?? []) {
      const ep =
        part.endpoint?.payload?.browseId ??
        part.endpoint?.browseEndpoint?.browseId ??
        part.endpoint?.browseId ??
        part.text?.endpoint?.payload?.browseId ??
        part.text?.runs?.[0]?.endpoint?.payload?.browseId
      const partText = text(part.text)
      if (typeof ep === 'string' && ep.startsWith('UC') && partText) {
        author = partText
        break
      }
    }
    if (author) break
  }

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

  if (author == null) {
    author = ctx?.author ?? null
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
  const c = node as any
  const id = c?.id ?? c?.author?.id ?? c?.endpoint?.payload?.browseId
  if (!id) return null
  const { handle, subscribers, videoCount } = classifyChannelTexts([
    c.subscriber_count,
    c.subscribers,
    c.video_count,
    c.subtitle,
    c.short_byline,
    c.long_byline
  ])
  const avatar =
    pickThumbnail(c.author?.thumbnails, 240) ||
    pickThumbnail(c.thumbnails, 240) ||
    absUrl(c.author?.best_thumbnail?.url) ||
    absUrl(c.author?.avatar_thumbnail_url) ||
    null
  const name =
    text(c.author?.name) ||
    text(c.title) ||
    text(c.name) ||
    (typeof c.author === 'string' ? c.author : '') ||
    'Channel'
  return {
    id,
    name,
    avatar,
    handle: handle ? String(handle) : null,
    subscribers: subscribers ? String(subscribers) : null,
    videoCount: videoCount ? String(videoCount) : null,
    description: text(c.description) || text(c.description_snippet) || null,
    isMusic: hasMusicBadge(c.author?.badges ?? c.badges)
  }
}

/**
 * Maps a playlist or music-release node. `isRelease` marks nodes that come
 * from a channel's "Releases" tab, where every entry is an album even if
 * YouTube hands out a plain playlist id.
 */
export function toPlaylistSummary(
  node: unknown,
  isRelease = false,
  ctx?: { author?: string | null; authorId?: string | null; authorAvatar?: string | null }
): PlaylistSummary | null {
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
    const { authorId: lockupId, authorAvatar: lockupAvatar } = lockupAuthor(node)
    return {
      id: node.content_id,
      title: text(node.metadata?.title),
      author: author || ctx?.author || null,
      authorId: lockupId ?? ctx?.authorId ?? null,
      authorAvatar: lockupAvatar ?? ctx?.authorAvatar ?? null,
      count: parseCompactCount(countText),
      countText: trackCountText(countText, isAlbum),
      thumbnail: thumbs ? pickThumbnail(thumbs, 480) : null,
      isAlbum,
      thumbAspect: isAlbum ? 'square' : 'wide',
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
    author: author || ctx?.author || null,
    authorId:
      p.author?.channel_id ?? p.author?.id ?? p.author?.endpoint?.payload?.browseId ?? ctx?.authorId ?? null,
    authorAvatar:
      pickThumbnail(p.author?.thumbnails, 240) || absUrl(p.author?.avatar_thumbnail_url) || ctx?.authorAvatar || null,
    count: parseCompactCount(countText),
    countText: trackCountText(countText, isAlbum),
    thumbnail:
      pickThumbnail(p.thumbnail_renderer?.thumbnail, 480) || pickThumbnail(p.thumbnails, 480) || null,
    isAlbum,
    thumbAspect: isAlbum ? 'square' : 'wide',
    year
  }
}

/** Identifies dynamic radio stations (RDAT, RDAM, RDEM, or radio playlists) that fail static playback. */
export function isRadioItem(
  id?: string | null,
  title?: string | null,
  subtitle?: string | null,
  itemType?: string | null
): boolean {
  if (itemType === 'radio') return true
  const cleanId = (id || '').replace(/^VL/, '')
  if (
    cleanId.startsWith('RDAT') ||
    cleanId.startsWith('RDAM') ||
    cleanId.startsWith('RDEM') ||
    (cleanId.startsWith('RD') && !cleanId.startsWith('RDCLAK'))
  ) {
    return true
  }
  const cleanTitle = (title || '').trim().toLowerCase()
  const cleanSubtitle = (subtitle || '').trim().toLowerCase()
  if (cleanTitle.startsWith('radio •') || cleanTitle.startsWith('radio -') || cleanTitle === 'radio') return true
  if (/^radio\s*[•\-:]/i.test(cleanTitle)) return true
  if (cleanSubtitle.startsWith('radio •') || cleanSubtitle.startsWith('radio -') || cleanSubtitle === 'radio') return true
  return false
}

/** Detects natural thumbnail aspect ratio from dimensions or track type. */
export function detectThumbAspect(thumbs: unknown, isMusicTrack = false): 'square' | 'wide' {
  if (Array.isArray(thumbs) && thumbs.length > 0) {
    const first = thumbs[0] as ThumbLike | undefined
    if (first?.width && first?.height) {
      const ratio = first.width / first.height
      if (ratio <= 1.2) return 'square'
      return 'wide'
    }
  }
  return isMusicTrack ? 'square' : 'wide'
}

/** Parses YouTube Music secondary flex column / subtitle runs into author, authorId, track count, year, and artists. */
export function parseMusicSecondaryRuns(runs: any[] | undefined): {
  author: string | null
  authorId: string | null
  countText: string | null
  year: string | null
  artists: ArtistRef[]
} {
  const result: {
    author: string | null
    authorId: string | null
    countText: string | null
    year: string | null
    artists: ArtistRef[]
  } = {
    author: null,
    authorId: null,
    countText: null,
    year: null,
    artists: []
  }

  if (!Array.isArray(runs) || runs.length === 0) return result

  const segments: any[][] = []
  let currentSegment: any[] = []
  for (const run of runs) {
    const t = text(run?.text ?? run)
    if (t.trim() === '•') {
      if (currentSegment.length > 0) segments.push(currentSegment)
      currentSegment = []
    } else {
      currentSegment.push(run)
    }
  }
  if (currentSegment.length > 0) segments.push(currentSegment)

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const segText = seg.map((r) => text(r?.text ?? r)).join('').trim()
    if (!segText) continue

    if (/\b\d+\s*(?:songs?|tracks?|videos?|episodes?)\b/i.test(segText)) {
      result.countText = segText
    } else if (/^[12]\d{3}$/.test(segText)) {
      result.year = segText
    } else if (
      !/^(playlist|album|single|ep|podcast|episode|song|video|radio)$/i.test(segText) &&
      !result.author
    ) {
      result.author = segText
      for (const r of seg) {
        const name = text(r?.text ?? r).replace(/^[\s,&•]+|[\s,&•]+$/g, '').trim()
        const id =
          r?.endpoint?.payload?.browseId ??
          r?.endpoint?.browseEndpoint?.browseId ??
          r?.navigationEndpoint?.browseEndpoint?.browseId ??
          r?.navigationEndpoint?.payload?.browseId ??
          r?.browseId ??
          null
        if (name && !/^[&,]$/.test(name) && name.toLowerCase() !== 'and more' && name.toLowerCase() !== 'more') {
          result.artists.push({ name, id })
          if (id && !result.authorId) {
            result.authorId = id
          }
        }
      }
    }
  }

  return result
}

export function toMusicSummary(node: unknown): VideoSummary | null {
  const m = node as any
  if (!m?.id) return null

  const artists: ArtistRef[] = []
  if (Array.isArray(m.artists)) {
    for (const a of m.artists) {
      const name = text(a.name) || text(a)
      const aId = a.channel_id ?? a.id ?? a.endpoint?.payload?.browseId ?? null
      if (name) artists.push({ name, id: aId })
    }
  } else if (Array.isArray(m.authors)) {
    for (const a of m.authors) {
      const name = text(a.name) || text(a)
      const aId = a.channel_id ?? a.id ?? a.endpoint?.payload?.browseId ?? null
      if (name) artists.push({ name, id: aId })
    }
  }

  const artistList = artists.map((a) => a.name).filter(Boolean)
  const authorName =
    artistList.length > 0
      ? artistList.join(', ')
      : text(m.authors?.[0]?.name) || text(m.author?.name) || text(m.author) || ''

  const rawPrimary = m.artists?.[0] ?? m.authors?.[0] ?? m.author
  const authorId =
    artists[0]?.id ??
    rawPrimary?.id ??
    rawPrimary?.channel_id ??
    rawPrimary?.endpoint?.payload?.browseId ??
    null

  const authorThumbs =
    rawPrimary?.thumbnail?.thumbnails ?? m.author?.thumbnails ?? undefined

  const rawThumbs =
    m.thumbnails ??
    (Array.isArray((m.thumbnail as any)?.contents)
      ? (m.thumbnail as any).contents
      : Array.isArray(m.thumbnail)
        ? m.thumbnail
        : undefined)

  const title = text(m.title) || ''
  if (isRadioItem(m.id, title, authorName, m.item_type)) return null

  const isSquareSong =
    m.item_type === 'song' ||
    !m.duration ||
    Boolean(rawThumbs?.[0]?.width && rawThumbs?.[0]?.height && Math.abs(rawThumbs[0].width - rawThumbs[0].height) <= 4)
  const thumbAspect = detectThumbAspect(rawThumbs, isSquareSong)

  return {
    videoId: m.id,
    title,
    author: authorName,
    authorId,
    authorAvatar: pickThumbnail(authorThumbs, 240) || null,
    duration: m.duration?.seconds ?? parseDurationText(m.duration?.text),
    thumbnail: pickThumbnail(rawThumbs, 480) || '',
    viewCount: parseCompactCount(m.views),
    published: null,
    isLive: false,
    album: m.album?.name ? text(m.album.name) : text(m.album) || null,
    albumId: m.album?.id ?? m.album?.endpoint?.payload?.browseId ?? null,
    isMusicTrack: true,
    artists: artists.length > 0 ? artists : undefined,
    thumbAspect
  }
}

/** YouTube Music search result item (albums). */
export function toMusicAlbumSummary(node: unknown): PlaylistSummary | null {
  const m = node as any
  const id = (m?.id ?? m?.endpoint?.payload?.browseId ?? '').replace(/^VL/, '')
  if (!id) return null
  const title = text(m.title) || text(m.name) || 'Album'
  const rawThumbs =
    m.thumbnails ??
    (Array.isArray(m.thumbnail?.contents)
      ? m.thumbnail.contents
      : Array.isArray(m.thumbnail)
        ? m.thumbnail
        : undefined)

  const sec = parseMusicSecondaryRuns(m.flex_columns?.[1]?.title?.runs ?? m.subtitle?.runs)

  const primaryAuthor = m.author ?? m.artists?.[0]
  const author =
    (primaryAuthor ? text(primaryAuthor.name) || text(primaryAuthor) : null) ||
    sec.author ||
    null

  const authorId =
    primaryAuthor?.channel_id ??
    primaryAuthor?.id ??
    primaryAuthor?.endpoint?.payload?.browseId ??
    sec.authorId ??
    null

  const artists: ArtistRef[] = []
  if (Array.isArray(m.artists) && m.artists.length > 0) {
    for (const a of m.artists) {
      const name = text(a.name) || text(a)
      const aId = a.channel_id ?? a.id ?? a.endpoint?.payload?.browseId ?? null
      if (name) artists.push({ name, id: aId })
    }
  } else if (sec.artists.length > 0) {
    artists.push(...sec.artists)
  } else if (author) {
    artists.push({ name: author, id: authorId })
  }

  const rawCount = sec.countText || (m.item_count ? text(m.item_count) : null)
  const countText = rawCount && !/^(album|ep|single|release|playlist)$/i.test(rawCount.trim()) ? rawCount : null

  if (isRadioItem(id, title, author, m.item_type)) return null

  return {
    id,
    title,
    author,
    authorId,
    authorAvatar: null,
    count: null,
    countText,
    thumbnail: pickThumbnail(rawThumbs, 480) || null,
    isAlbum: true,
    year: m.year ? text(m.year) : sec.year,
    artists: artists.length > 0 ? artists : undefined,
    thumbAspect: 'square'
  }
}

/** Maps any standard YouTube Music result (cards, songs, albums, artists, playlists) to a SearchItem. */
export function toMusicSearchItem(node: unknown): SearchItem | null {
  if (!node || typeof node !== 'object') return null
  const item = node as any

  // 1. MusicCardShelf (top hero card)
  if (item.type === 'MusicCardShelf') {
    const browseId: string | undefined =
      item.on_tap?.payload?.browseId ??
      item.buttons?.find((b: any) => b.endpoint?.payload?.browseId)?.endpoint?.payload?.browseId
    const videoId: string | undefined =
      item.on_tap?.payload?.videoId ??
      item.buttons?.find((b: any) => b.endpoint?.payload?.videoId)?.endpoint?.payload?.videoId
    const playlistId: string | undefined =
      item.on_tap?.payload?.playlistId ??
      item.buttons?.find((b: any) => b.endpoint?.payload?.playlistId)?.endpoint?.payload?.playlistId
    const cardTitle = text(item.title) || ''
    const subtitle = text(item.subtitle) || ''
    const thumbs = item.thumbnail?.contents ?? item.thumbnail

    // Radio check
    if (isRadioItem(browseId || playlistId, cardTitle, subtitle, item.item_type || (playlistId?.startsWith('RD') ? 'radio' : undefined))) return null

    const sec = parseMusicSecondaryRuns(item.subtitle?.runs)

    if (browseId && (browseId.startsWith('MPREb_') || /album/i.test(subtitle))) {
      const parts = subtitle.split('•').map((s: string) => s.trim())
      const author = sec.author || (parts.length > 1 ? parts[1] : null)
      const year = sec.year || (parts.length > 2 ? parts[2] : null)
      return {
        type: 'playlist',
        id: browseId,
        title: cardTitle || 'Album',
        author,
        authorId: sec.authorId ?? null,
        authorAvatar: null,
        count: null,
        countText: null,
        thumbnail: pickThumbnail(thumbs, 480) || null,
        isAlbum: true,
        year,
        artists: sec.artists.length > 0 ? sec.artists : author ? [{ name: author, id: sec.authorId ?? null }] : undefined,
        thumbAspect: 'square'
      }
    }

    if (browseId && browseId.startsWith('UC')) {
      return {
        type: 'channel',
        id: browseId,
        name: cardTitle,
        handle: null,
        subscribers: subtitle || null,
        videoCount: null,
        description: null,
        avatar: pickThumbnail(thumbs, 240) || null,
        isMusic: true
      }
    }

    if (videoId) {
      return {
        type: 'video',
        videoId,
        title: cardTitle,
        author: sec.author || subtitle.split('•')[0]?.trim() || '',
        authorId: sec.authorId || browseId || null,
        authorAvatar: null,
        duration: null,
        thumbnail: pickThumbnail(thumbs, 480) || '',
        viewCount: null,
        published: null,
        isLive: false,
        isMusicTrack: true,
        artists: sec.artists.length > 0 ? sec.artists : undefined,
        thumbAspect: detectThumbAspect(thumbs, true)
      }
    }

    if (browseId) {
      const parts = subtitle.split('•').map((s: string) => s.trim())
      const author = sec.author || (parts.length > 0 ? parts[0] : null)
      const countPart = sec.countText || (parts.find((p) => /\b\d+\s*(?:songs?|tracks?|videos?)\b/i.test(p)) ?? null)
      return {
        type: 'playlist',
        id: browseId.replace(/^VL/, ''),
        title: cardTitle,
        author,
        authorId: sec.authorId ?? null,
        authorAvatar: null,
        count: null,
        countText: countPart,
        thumbnail: pickThumbnail(thumbs, 480) || null,
        isAlbum: false,
        artists: sec.artists.length > 0 ? sec.artists : author ? [{ name: author, id: sec.authorId ?? null }] : undefined,
        thumbAspect: detectThumbAspect(thumbs)
      }
    }
    return null
  }

  // 2. MusicResponsiveListItem
  const itemType: string = item.item_type ?? ''
  const itemTitle = text(item.title) || text(item.name) || ''
  const rawId = item.id || item.endpoint?.payload?.browseId || ''
  const itemPlaylistId = item.overlay?.content?.endpoint?.payload?.playlistId ?? item.endpoint?.payload?.playlistId
  if (isRadioItem(rawId || itemPlaylistId, itemTitle, text(item.subtitle), itemType || (itemPlaylistId?.startsWith('RD') ? 'radio' : undefined))) {
    return null
  }

  if (itemType === 'album') {
    const summary = toMusicAlbumSummary(item)
    return summary ? { type: 'playlist', ...summary } : null
  }

  if (itemType === 'playlist') {
    const id: string = (item.id || item.endpoint?.payload?.browseId || '').replace(/^VL/, '')
    if (!id) return null
    if (isRadioItem(id, itemTitle, null, itemType)) return null

    const sec = parseMusicSecondaryRuns(item.flex_columns?.[1]?.title?.runs ?? item.subtitle?.runs)
    const authorName =
      text(item.author?.name) ||
      text(item.author) ||
      text(item.artists?.[0]?.name) ||
      text(item.authors?.[0]?.name) ||
      sec.author ||
      null
    const authorId =
      item.author?.id ??
      item.author?.channel_id ??
      item.artists?.[0]?.id ??
      item.authors?.[0]?.id ??
      sec.authorId ??
      null

    const thumbs = item.thumbnail?.contents ?? item.thumbnails ?? item.thumbnail
    const countText =
      sec.countText ||
      text(item.item_count) ||
      (text(item.subtitle) && /\b\d+\s*songs\b/i.test(text(item.subtitle)) ? text(item.subtitle) : null)

    return {
      type: 'playlist',
      id,
      title: itemTitle || 'Playlist',
      author: authorName,
      authorId,
      authorAvatar: null,
      count: null,
      countText,
      thumbnail: pickThumbnail(thumbs, 480) || null,
      isAlbum: false,
      artists: sec.artists.length > 0 ? sec.artists : authorName ? [{ name: authorName, id: authorId }] : undefined,
      thumbAspect: detectThumbAspect(thumbs)
    }
  }

  if (itemType === 'artist') {
    const id: string = item.id || item.endpoint?.payload?.browseId || ''
    if (!id) return null
    const thumbs = item.thumbnail?.contents ?? item.thumbnails ?? item.thumbnail
    return {
      type: 'channel',
      id,
      name: text(item.name) || itemTitle || '',
      handle: null,
      subscribers: text(item.subscribers) || text(item.subtitle) || null,
      videoCount: null,
      description: null,
      avatar: pickThumbnail(thumbs, 240) || null,
      isMusic: true
    }
  }

  if (
    itemType === 'song' ||
    itemType === 'video' ||
    itemType === 'non_music_track' ||
    (item.id && !item.id.startsWith('UC') && !item.id.startsWith('MPREb_') && !item.id.startsWith('VL'))
  ) {
    const summary = toMusicSummary(item)
    return summary ? { type: 'video', ...summary } : null
  }

  return null
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

export function feedPlaylists(
  feed: PlaylistFeed | null | undefined,
  isRelease = false,
  ctx?: { author?: string | null; authorId?: string | null; authorAvatar?: string | null }
): PlaylistSummary[] {
  const nodes = feed?.playlists ?? feed?.results ?? []
  return nodes
    .map((n) => toPlaylistSummary(n, isRelease, ctx))
    .filter((p): p is PlaylistSummary => p !== null)
}
