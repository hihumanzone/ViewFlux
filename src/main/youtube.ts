import { randomUUID } from 'node:crypto'
import type { Innertube } from 'youtubei.js'
import { rewriteHls } from './proxy'
import type {
  AboutInfo,
  CaptionTrack,
  ChannelInfo,
  ChannelSort,
  ChannelSummary,
  ChannelVideosPage,
  Chapter,
  PlaylistSummary,
  RemotePlaylist,
  SearchFilter,
  SearchItem,
  SearchPage,
  Thumb,
  VideoDetails,
  VideoSummary
} from '../shared/types'

/**
 * We use YouTube's internal VISIONOS client. Unlike WEB it needs no PO-token /
 * BotGuard dance, and unlike IOS it does not restrict arbitrary HTTP Range
 * requests or seeking on googlevideo media URLs.
 *
 * `retrieve_player: true` downloads the player JS so youtubei.js can decipher
 * the `n`/`sig` parameters on stream URLs (the same approach NewPipe takes
 * with its JavaScript extractor and FreeTube takes via youtubei.js).
 * The interpreter runs through `Platform.shim.eval` below (plain Function in
 * the main process — no extra dependencies).
 */
const CLIENT = 'VISIONOS' as const

const INFO_TTL_MS = 10 * 60 * 1000
/** Stream URLs carry an `expire` param, so manifests are regenerated often. */
const MANIFEST_TTL_MS = 3 * 60 * 1000
/** Live manifests rotate fast (segments + variant playlists), so cache briefly. */
const LIVE_TTL_MS = 60 * 1000
const CHANNEL_TTL_MS = 10 * 60 * 1000
/** Channel-picture lookups fire in parallel; keep the fan-out polite. */
const AVATAR_LOOKUP_CONCURRENCY = 5

// ---------------------------------------------------------------------------
// Loose node shapes (duck-typed to stay resilient across YouTube layout drift).
// ---------------------------------------------------------------------------

interface TextLike {
  text?: string
  runs?: { text?: string }[]
  endpoint?: { payload?: { browseId?: string } }
  toString?: () => string
}

interface ThumbLike {
  url: string
  width: number
  height: number
}

interface LockupViewNode {
  type: 'LockupView'
  content_id: string
  content_type: string
  content_image: {
    image?: ThumbLike[]
    primary_thumbnail?: { image?: ThumbLike[]; overlays?: unknown[] }
    overlays?: unknown[]
  }
  metadata: {
    title?: TextLike
    image?: {
      image?: ThumbLike[]
      sources?: ThumbLike[]
      decoratedAvatarViewModel?: { avatar?: { image?: ThumbLike[]; sources?: ThumbLike[] } }
      renderer_context?: { command_context?: { on_tap?: { payload?: { browseId?: string } } } }
      avatar?: { endpoint?: { payload?: { browseId?: string } }; image?: ThumbLike[]; sources?: ThumbLike[] }
      endpoint?: { payload?: { browseId?: string } }
      on_tap_endpoint?: { payload?: { browseId?: string } }
    }
    metadata?: {
      metadata_rows?: {
        metadata_parts?: {
          text?: TextLike
          endpoint?: { payload?: { browseId?: string }; browseEndpoint?: { browseId?: string }; browseId?: string }
        }[]
      }[]
    }
  } | null
}

/** Any feed object that can be continued (search, channel tabs, playlists…). */
interface Continuable {
  has_continuation?: boolean
  getContinuation(): Promise<unknown>
}

interface ContinuationEntry {
  kind:
    | 'search:all'
    | 'search:videos'
    | 'search:channels'
    | 'search:playlists'
    | 'search:music'
    | 'channel:videos'
    | 'channel:playlists'
    | 'remote:playlist'
  feed: Continuable
  ctx?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Text / number helpers
// ---------------------------------------------------------------------------

function text(value: TextLike | string | null | undefined): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (value.text) return value.text
  if (Array.isArray(value.runs)) return value.runs.map((r) => r.text ?? '').join('')
  if (typeof value.toString === 'function') {
    const out = value.toString()
    if (out && out !== '[object Object]') return out
  }
  return ''
}

function parseCount(value: TextLike | string | null | undefined): number | null {
  const raw = text(value)
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = Number.parseInt(digits, 10)
  return Number.isFinite(n) ? n : null
}

/** Parses compact counts like "8.1M", "1.8B views", "960". */
function parseCompactCount(raw: string | null | undefined): number | null {
  if (!raw) return null
  const m = /(\d[\d,]*(?:\.\d+)?)\s*([KMB])?\b/i.exec(raw)
  if (!m) return parseCount(raw)
  const n = Number.parseFloat(m[1].replace(/[,\s]/g, ''))
  if (!Number.isFinite(n)) return parseCount(raw)
  const suffix = m[2]?.toUpperCase()
  const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1
  return Math.round(n * mult)
}

/** Parses "47:42" / "1:02:03" style duration text into seconds. */
function parseDurationText(raw: string | null | undefined): number | null {
  if (!raw || !raw.includes(':')) return null
  const parts = raw.trim().split(':').map((p) => Number.parseInt(p, 10))
  if (parts.some((p) => !Number.isFinite(p))) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/** Parses relative dates ("5d ago", "2mo ago", "13 years ago") into days. */
function parseAgoDays(raw: string | null | undefined): number | null {
  if (!raw) return null
  const m = /(\d+)\s*(years?|yrs?|y|months?|mo|weeks?|w|days?|d|hours?|h|minutes?|min|m|seconds?|s)\b/i.exec(raw)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  const unit = m[2].toLowerCase()
  const days: Record<string, number> = {
    y: 365, yr: 365, yrs: 365, year: 365, years: 365,
    mo: 30, month: 30, months: 30,
    w: 7, week: 7, weeks: 7,
    d: 1, day: 1, days: 1,
    h: 1 / 24, hour: 1 / 24, hours: 1 / 24,
    m: 1 / 1440, min: 1 / 1440, minute: 1 / 1440, minutes: 1 / 1440,
    s: 1 / 86400, sec: 1 / 86400, second: 1 / 86400, seconds: 1 / 86400
  }
  return n * (days[unit] ?? 1)
}

/** Some thumbnails come protocol-relative ("//yt3.ggpht.com/…"); make them absolute. */
function absUrl(url: string | null | undefined): string {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  return url
}

function pickThumbnail(thumbs: ThumbLike[] | undefined, targetWidth = 480): string {
  if (!thumbs || thumbs.length === 0) return ''
  const sorted = [...thumbs].sort(
    (a, b) => Math.abs(a.width - targetWidth) - Math.abs(b.width - targetWidth)
  )
  return absUrl(sorted[0]?.url)
}

function normalizeThumbs(thumbs: { url: string; width: number; height: number }[] | undefined): Thumb[] {
  if (!thumbs) return []
  return thumbs.map((t) => ({ url: t.url, width: t.width, height: t.height }))
}

/** Collects badge texts from thumbnail overlays (duration, video counts…). */
function badgeTexts(overlays: unknown[] | undefined): string[] {
  const out: string[] = []
  for (const overlay of overlays ?? []) {
    const badges = (overlay as { badges?: unknown[] })?.badges
    if (Array.isArray(badges)) {
      for (const badge of badges) {
        // Badges can be plain strings or { text } objects depending on view.
        const t = typeof badge === 'string' ? badge : text((badge as { text?: TextLike })?.text)
        if (t) out.push(t)
      }
    }
  }
  return out
}

/** LockupView overlays can sit on the image view itself or on the collection's primary thumbnail. */
function lockupBadges(node: LockupViewNode): string[] {
  const image = node.content_image
  return [...badgeTexts(image?.overlays), ...badgeTexts(image?.primary_thumbnail?.overlays)]
}

/** Flattens LockupView metadata rows into plain text rows. */
function lockupRows(node: LockupViewNode): string[][] {
  const rows = node.metadata?.metadata?.metadata_rows ?? []
  return rows.map((row) =>
    (row.metadata_parts ?? []).map((part) => text(part?.text)).filter(Boolean)
  )
}

/**
 * Digs the owning channel's id and picture out of a LockupView node. The
 * avatar is exposed on the metadata image and the browse id either on that
 * image's tap endpoint or on one of the metadata text parts, so all three are
 * probed before giving up.
 */
function lockupAuthor(node: LockupViewNode): { authorId: string | null; authorAvatar: string | null } {
  const metaImg = node.metadata?.image
  const avatarImages =
    metaImg?.avatar?.image ??
    metaImg?.avatar?.sources ??
    metaImg?.decoratedAvatarViewModel?.avatar?.image ??
    metaImg?.decoratedAvatarViewModel?.avatar?.sources
  const authorAvatar =
    Array.isArray(avatarImages) && avatarImages.length > 0
      ? pickThumbnail(avatarImages, 240) || absUrl(avatarImages[0]?.url) || null
      : null

  const directId =
    metaImg?.renderer_context?.command_context?.on_tap?.payload?.browseId ??
    metaImg?.avatar?.endpoint?.payload?.browseId ??
    metaImg?.endpoint?.payload?.browseId ??
    metaImg?.on_tap_endpoint?.payload?.browseId

  let authorId: string | null = typeof directId === 'string' && directId ? directId : null
  if (!authorId) {
    const rows = node.metadata?.metadata?.metadata_rows ?? []
    for (const row of rows) {
      for (const part of row.metadata_parts ?? []) {
        const ep =
          part.endpoint?.payload?.browseId ??
          part.endpoint?.browseEndpoint?.browseId ??
          part.endpoint?.browseId ??
          part.text?.endpoint?.payload?.browseId
        if (typeof ep === 'string' && ep) {
          authorId = ep
          break
        }
      }
      if (authorId) break
    }
  }

  return { authorId, authorAvatar }
}

/** Classifies loose channel-related texts into handle / subscribers / video count. */
function classifyChannelTexts(candidates: (string | null | undefined)[]): {
  handle: string | null
  subscribers: string | null
  videoCount: string | null
} {
  let handle: string | null = null
  let subscribers: string | null = null
  let videoCount: string | null = null
  for (const candidate of candidates) {
    const t = text(candidate)
    if (!t) continue
    if (!handle && t.startsWith('@')) handle = t
    else if (!subscribers && /subscriber/i.test(t)) subscribers = t
    else if (!videoCount && /\bvideos?\b/i.test(t)) videoCount = t
  }
  return { handle, subscribers, videoCount }
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

interface CachedInfo {
  info: Awaited<ReturnType<Innertube['getInfo']>>
  fetchedAt: number
}

interface CachedManifest {
  xml: string
  fetchedAt: number
  /** Live manifests rotate fast — they expire sooner than VOD DASH. */
  ttl: number
}

interface CachedChannel {
  channel: any
  fetchedAt: number
}

export class YoutubeService {
  private yt: Innertube | null = null
  private initPromise: Promise<Innertube> | null = null
  private proxyBase = ''
  private readonly continuations = new Map<string, ContinuationEntry>()
  private readonly infoCache = new Map<string, CachedInfo>()
  private readonly manifestCache = new Map<string, CachedManifest>()
  private readonly channelCache = new Map<string, CachedChannel>()

  setProxyBase(base: string): void {
    this.proxyBase = base
  }

  private async client(): Promise<Innertube> {
    if (this.yt) return this.yt
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const { Innertube, Log, Platform } = await import('youtubei.js')
        Log.setLevel(Log.Level.NONE)
        // Lets youtubei.js execute YouTube's decipher function (base.js) in
        // the main process. `data.output` is a function body ending with
        // `return process(...)`, so wrapping it in `new Function` and calling
        // it yields the deciphered `{ sig, n }` object.
        Platform.shim.eval = (async (data: { output: string }) =>
          new Function(data.output)()) as typeof Platform.shim.eval
        const yt = await Innertube.create({
          retrieve_player: true,
          lang: 'en',
          location: 'US'
        })
        this.yt = yt
        return yt
      })().catch((err) => {
        this.initPromise = null
        throw err
      })
    }
    return this.initPromise
  }

  private token(entry: ContinuationEntry): string {
    const token = randomUUID()
    this.continuations.set(token, entry)
    this.pruneContinuations()
    return token
  }

  private pruneContinuations(): void {
    while (this.continuations.size > 60) {
      const first = this.continuations.keys().next().value
      if (!first) break
      this.continuations.delete(first)
    }
  }

  private pruneMap<K, V>(map: Map<K, V>, max = 100): void {
    while (map.size > max) {
      const first = map.keys().next().value
      if (!first) break
      map.delete(first)
    }
  }

  // -------------------------------------------------------------------------
  // Mappers
  // -------------------------------------------------------------------------

  /** Classic `Video` / `GridVideo` search node. */
  private toSummary(node: unknown): VideoSummary | null {
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
      is_live?: boolean
    }
    const videoId = v.video_id ?? v.id
    if (!videoId) return null
    const authorId =
      v.author?.id ??
      v.author?.endpoint?.payload?.browseId ??
      v.author?.endpoint?.browseEndpoint?.browseId ??
      null
    return {
      videoId,
      title: text(v.title),
      author: v.author?.name ?? '',
      authorId,
      authorAvatar:
        pickThumbnail(v.author?.thumbnails, 240) || absUrl(v.author?.best_thumbnail?.url) || null,
      duration: v.duration?.seconds ?? null,
      thumbnail: pickThumbnail(v.thumbnails),
      viewCount:
        parseCompactCount(text(v.view_count)) ??
        parseCompactCount(text(v.short_view_count)) ??
        parseCompactCount(text(v.views)),
      published: text(v.published) || null,
      isLive: Boolean(v.is_live)
    }
  }

  private isLockup(node: unknown): node is LockupViewNode {
    return (node as { type?: string })?.type === 'LockupView'
  }

  /**
   * New unified `LockupView` renderer (channel videos, playlists, remote
   * playlist items…). `ctx` optionally supplies channel context.
   */
  private toLockupVideo(
    node: unknown,
    ctx?: { author?: string | null; authorId?: string | null; authorAvatar?: string | null }
  ): VideoSummary | null {
    if (!this.isLockup(node)) return this.toSummary(node)
    if (!node.content_id || node.content_type !== 'VIDEO') return null

    const thumbs = node.content_image?.image
    const badges = lockupBadges(node)
    const durationBadge = badges.find((b) => b.includes(':'))
    const rows = lockupRows(node)

    // Remote playlist items (and mixed-search videos) carry no channel
    // context — the author sits in the first metadata row (e.g. row0 =
    // ['Lofi Girl'], later rows = views/age). Channel tabs always pass ctx,
    // so this only fires where the author would otherwise be blank.
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
    for (const part of rows.flat()) {
      if (author && part === author) continue
      if (!published && /ago|streamed|premiered/i.test(part)) published = part
      else if (!viewsText && /\d/.test(part) && !/^@/.test(part)) viewsText = part
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
      isLive: Boolean(durationBadge && /live/i.test(durationBadge))
    }
  }

  private toChannelSummary(node: unknown): ChannelSummary | null {
    const c = node as {
      type?: string
      id?: string
      author?: { name?: string; id?: string; thumbnails?: ThumbLike[]; best_thumbnail?: { url?: string }; avatar_thumbnail_url?: string }
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
    // Some channel renderers only populate `avatar_thumbnail_url`, so it is a
    // fallback source next to the usual thumbnail list.
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
      description: text(c.description) || null
    }
  }

  private toPlaylistSummary(node: unknown): PlaylistSummary | null {
    if (this.isLockup(node)) {
      if (node.content_type !== 'PLAYLIST' || !node.content_id) return null
      const thumbs = node.content_image?.primary_thumbnail?.image
      const countText = lockupBadges(node).find((b) => /videos?/i.test(b)) ?? null
      const firstRow = lockupRows(node)[0] ?? []
      const author =
        firstRow.find((p) => p && p !== 'Playlist' && !/^view /i.test(p)) ?? null
      const { authorId, authorAvatar } = lockupAuthor(node)
      return {
        id: node.content_id,
        title: text(node.metadata?.title),
        author,
        authorId,
        authorAvatar,
        count: parseCompactCount(countText),
        countText,
        thumbnail: thumbs ? pickThumbnail(thumbs, 480) : null
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
    const countText = text(p.video_count) || null
    return {
      id: pid,
      title: text(p.title),
      author: p.author?.name ?? null,
      authorId:
        p.author?.channel_id ?? p.author?.id ?? p.author?.endpoint?.payload?.browseId ?? null,
      authorAvatar:
        pickThumbnail(p.author?.thumbnails, 240) || absUrl(p.author?.avatar_thumbnail_url) || null,
      count: parseCompactCount(countText),
      countText,
      thumbnail:
        pickThumbnail(p.thumbnail_renderer?.thumbnail, 480) || pickThumbnail(p.thumbnails, 480) || null
    }
  }

  /** YouTube Music search result item. */
  private toMusicSummary(node: unknown): VideoSummary | null {
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
    // Music results carry the artist picture on the same node as the name, so
    // search for it — without it every music card fell back to initials.
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

  private dedupe(items: SearchItem[]): SearchItem[] {
    const seen = new Set<string>()
    return items.filter((item) => {
      const key = `${item.type}:${'videoId' in item ? item.videoId : 'id' in item ? item.id : ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async search(query: string, filter: SearchFilter = 'all'): Promise<SearchPage> {
    const yt = await this.client()
    const q = query.trim()
    if (!q) return { items: [], continuation: null }

    if (filter === 'music') {
      const feed = (await yt.music.search(q, { type: 'video' })) as unknown as Continuable
      const items = this.musicItems(feed)
        .map((n) => this.toMusicSummary(n))
        .filter((i): i is VideoSummary => i !== null)
        .map((v): SearchItem => ({ type: 'video', ...v }))
      return {
        items,
        continuation: feed.has_continuation
          ? this.token({ kind: 'search:music', feed })
          : null
      }
    }

    const results =
      filter === 'videos'
        ? await yt.search(q, { type: 'video' })
        : filter === 'channels'
          ? await yt.search(q, { type: 'channel' })
          : filter === 'playlists'
            ? await yt.search(q, { type: 'playlist' })
            : await yt.search(q)

    const kind: ContinuationEntry['kind'] =
      filter === 'videos'
        ? 'search:videos'
        : filter === 'channels'
          ? 'search:channels'
          : filter === 'playlists'
            ? 'search:playlists'
            : 'search:all'

    const items = this.searchItems(results.results, kind)
    return {
      items,
      continuation: results.has_continuation
        ? this.token({ kind, feed: results as unknown as Continuable })
        : null
    }
  }

  private searchItems(nodes: unknown[], kind: ContinuationEntry['kind']): SearchItem[] {
    const items: SearchItem[] = []
    if (kind === 'search:music') {
      for (const node of nodes) {
        const v = this.toMusicSummary(node)
        if (v) items.push({ type: 'video', ...v })
      }
      return items
    }
    for (const node of nodes) {
      const type = (node as { type?: string })?.type
      if (kind === 'search:videos') {
        const v = this.toSummary(node)
        if (v) items.push({ type: 'video', ...v })
      } else if (kind === 'search:channels') {
        const c = this.toChannelSummary(node)
        if (c) items.push({ type: 'channel', ...c })
      } else if (kind === 'search:playlists') {
        const p = this.toPlaylistSummary(node)
        if (p) items.push({ type: 'playlist', ...p })
      } else {
        // Mixed results: map by node type, skip shelves and promotions.
        if (type === 'Video' || type === 'GridVideo' || type === 'Movie') {
          const v = this.toSummary(node)
          if (v) items.push({ type: 'video', ...v })
        } else if (type === 'Channel' || type === 'GridChannel') {
          const c = this.toChannelSummary(node)
          if (c) items.push({ type: 'channel', ...c })
        } else if (this.isLockup(node)) {
          const mapped =
            node.content_type === 'PLAYLIST'
              ? this.toPlaylistSummary(node)
              : this.toLockupVideo(node)
          if (mapped) {
            items.push(
              'videoId' in mapped
                ? { type: 'video', ...(mapped as VideoSummary) }
                : { type: 'playlist', ...(mapped as PlaylistSummary) }
            )
          }
        }
      }
    }
    return this.dedupe(items)
  }

  /** Extracts MusicResponsiveListItem arrays from music search / continuations. */
  private musicItems(feed: unknown): unknown[] {
    const contents = (feed as { contents?: unknown })?.contents
    if (Array.isArray(contents)) {
      for (const node of contents) {
        const inner = (node as { contents?: unknown[] })?.contents
        if (Array.isArray(inner)) return inner
      }
      return []
    }
    const inner = (contents as { contents?: unknown[] })?.contents
    return Array.isArray(inner) ? inner : []
  }

  async searchMore(token: string): Promise<SearchPage> {
    const entry = this.continuations.get(token)
    if (!entry) return { items: [], continuation: null }
    const next = (await entry.feed.getContinuation()) as Continuable
    this.continuations.delete(token)
    return {
      items: this.searchItems(
        entry.kind === 'search:music' ? this.musicItems(next) : (next as { results?: unknown[] }).results ?? [],
        entry.kind
      ),
      continuation: next.has_continuation
        ? this.token({ kind: entry.kind, feed: next })
        : null
    }
  }

  async suggestions(query: string): Promise<string[]> {
    const yt = await this.client()
    try {
      return await yt.getSearchSuggestions(query)
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  private async getChannel(id: string): Promise<any> {
    const cached = this.channelCache.get(id)
    if (cached && Date.now() - cached.fetchedAt < CHANNEL_TTL_MS) return cached.channel
    const yt = await this.client()
    const channel = await yt.getChannel(id)
    this.channelCache.set(id, { channel, fetchedAt: Date.now() })
    this.pruneMap(this.channelCache, 40)
    return channel
  }

  async getChannelInfo(id: string): Promise<ChannelInfo> {
    const channel = await this.getChannel(id)

    const meta = channel.metadata ?? {}
    const headerContent = channel.header?.content ?? {}
    const rows = headerContent.metadata?.metadata_rows ?? []
    const parts = rows.flatMap(
      (row: { metadata_parts?: { text?: TextLike }[] }) =>
        (row.metadata_parts ?? []).map((part) => text(part?.text))
    )
    const { handle, subscribers, videoCount } = classifyChannelTexts(parts)

    const tabs: string[] = []
    const safeHas = (prop: string): boolean => {
      try {
        return Boolean(channel[prop])
      } catch {
        return false
      }
    }
    try {
      const names: string[] = channel.tabs ?? []
      if (names.includes('Videos') || safeHas('has_videos')) tabs.push('videos')
      if (names.includes('Playlists') || safeHas('has_playlists')) tabs.push('playlists')
      if (safeHas('has_about')) tabs.push('about')
    } catch {
      /* fall back to defaults below */
    }
    if (tabs.length === 0) tabs.push('videos', 'playlists', 'about')

    return {
      id,
      name: text(meta.title) || text(headerContent.page_title) || text(headerContent.title),
      avatar: meta.avatar ? pickThumbnail(meta.avatar, 240) : null,
      banner: this.bannerUrl(headerContent.banner),
      handle,
      subscribers,
      videoCount,
      description: text(meta.description) || null,
      tabs
    }
  }

  /**
   * Resolve just the channel pictures for a set of browse ids.
   *
   * YouTube omits the channel picture from several search payloads — playlist
   * LockupViews set `metadata.image` to null, and music search results have no
   * thumbnail on the author node at all — even though both carry the author's
   * browse id. Rather than chase the missing field through every node shape (and
   * re-break when YouTube reshuffles its markup), we fall back to the channel
   * page, which always has the avatar. `getChannel` is already TTL-cached, so
   * repeated cards for the same channel cost nothing after the first hit.
   *
   * Batched (one IPC round trip for a whole page of results) and capped at
   * `AVATAR_LOOKUP_CONCURRENCY` so a long list cannot stampede YouTube.
   */
  async getChannelAvatars(ids: string[]): Promise<Record<string, string | null>> {
    const wanted = [...new Set(ids.filter(Boolean))]
    const out: Record<string, string | null> = {}
    if (wanted.length === 0) return out

    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < wanted.length) {
        const id = wanted[cursor++]
        out[id] = await this.getChannelAvatar(id)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(AVATAR_LOOKUP_CONCURRENCY, wanted.length) }, worker)
    )
    return out
  }

  private async getChannelAvatar(id: string): Promise<string | null> {
    try {
      const channel = await this.getChannel(id)
      const meta = (channel.metadata ?? {}) as { avatar?: ThumbLike[] }
      if (Array.isArray(meta.avatar)) {
        const picked = pickThumbnail(meta.avatar, 240)
        if (picked) return picked
      }
    } catch {
      /* channel is gone or private — the caller falls back to initials */
    }
    return null
  }

  private bannerUrl(banner: unknown): string | null {
    if (!banner || typeof banner !== 'object') return null
    const b = banner as {
      url?: string
      image?: ThumbLike[]
      sources?: ThumbLike[]
    }
    if (typeof b.url === 'string') return b.url
    const thumbs = b.image ?? b.sources
    return Array.isArray(thumbs) ? pickThumbnail(thumbs, 1280) || null : null
  }

  private feedVideos(
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
        // Remote playlists expose their items through a memoized `items` getter.
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
      const summary = this.toLockupVideo(node, ctx)
      if (summary) items.push(summary)
    }
    return items
  }

  async getChannelVideos(id: string, sort: ChannelSort): Promise<ChannelVideosPage> {
    const channel = await this.getChannel(id)
    const ctx = {
      author: text(channel.metadata?.title) || null,
      authorId: id as string | null,
      authorAvatar: pickThumbnail(channel.metadata?.avatar, 240) || null
    }
    let feed = (await channel.getVideos()) as Continuable

    // YouTube native server-side sorting via InnerTube filter chips: 'Latest', 'Popular', 'Oldest'
    if (sort === 'popular') {
      try {
        feed = (await (feed as any).applyFilter('Popular')) as Continuable
      } catch (err) {
        console.warn('[youtube] failed to apply server-side Popular filter', err)
      }
    } else if (sort === 'oldest') {
      try {
        feed = (await (feed as any).applyFilter('Oldest')) as Continuable
      } catch (err) {
        console.warn('[youtube] failed to apply server-side Oldest filter', err)
      }
    }

    const items = this.feedVideos(feed, ctx)

    return {
      items,
      continuation: feed.has_continuation
        ? this.token({ kind: 'channel:videos', feed, ctx })
        : null
    }
  }

  /**
   * Fetches recent uploads from a list of bookmarked channels with bounded concurrency
   * and per-channel error isolation.
   *
   * `onProgress(done, total)` fires as each channel lands, so the renderer can
   * show a determinate bar instead of an indeterminate spinner. It is a plain
   * callback rather than an event emitter because only the IPC layer in
   * `index.ts` needs to turn it into an event, and that layer already has the
   * request id it needs to tag the event with.
   */
  async getSavedChannelsFeed(
    channelIds: string[],
    maxAgeDays?: number,
    onProgress?: (done: number, total: number) => void
  ): Promise<VideoSummary[]> {
    if (!channelIds || channelIds.length === 0) return []
    const uniqueIds = Array.from(new Set(channelIds))
    const CHUNK_SIZE = 5
    const allVideos: VideoSummary[] = []
    const seenVideoIds = new Set<string>()
    const total = uniqueIds.length
    let done = 0
    onProgress?.(done, total)

    for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + CHUNK_SIZE)
      const results = await Promise.allSettled(
        chunk.map(async (id) => {
          return Promise.race([
            this.getChannelVideos(id, 'newest'),
            new Promise<ChannelVideosPage>((_, reject) =>
              setTimeout(() => reject(new Error('Channel feed fetch timed out')), 8000)
            )
          ])
        })
      )
      for (const res of results) {
        done += 1
        if (res.status === 'fulfilled' && res.value?.items) {
          for (const item of res.value.items) {
            if (!seenVideoIds.has(item.videoId)) {
              seenVideoIds.add(item.videoId)
              allVideos.push(item)
            }
          }
        }
      }
      onProgress?.(done, total)
    }

    let filtered = allVideos
    if (typeof maxAgeDays === 'number' && maxAgeDays > 0) {
      filtered = allVideos.filter((v) => {
        const days = parseAgoDays(v.published)
        return days == null || days <= maxAgeDays
      })
    }

    // Sort newest first (smallest days ago first)
    filtered.sort((a, b) => {
      const da = parseAgoDays(a.published) ?? 99999
      const db = parseAgoDays(b.published) ?? 99999
      return da - db
    })

    return filtered
  }

  async channelVideosMore(token: string): Promise<ChannelVideosPage> {
    const entry = this.continuations.get(token)
    if (!entry) return { items: [], continuation: null }
    const next = (await entry.feed.getContinuation()) as Continuable
    this.continuations.delete(token)
    const ctx =
      entry.ctx as
        | { author?: string; authorId?: string | null; authorAvatar?: string | null }
        | undefined
    return {
      items: this.feedVideos(next, ctx),
      continuation: next.has_continuation
        ? this.token({ kind: 'channel:videos', feed: next, ctx })
        : null
    }
  }

  async getChannelPlaylists(id: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    const channel = await this.getChannel(id)
    const feed = (await channel.getPlaylists()) as Continuable & {
      playlists?: unknown[]
      results?: unknown[]
    }
    const nodes = feed.playlists ?? feed.results ?? []
    const items = nodes
      .map((n) => this.toPlaylistSummary(n))
      .filter((p): p is PlaylistSummary => p !== null)
    return {
      items,
      continuation: feed.has_continuation
        ? this.token({ kind: 'channel:playlists', feed })
        : null
    }
  }

  async channelPlaylistsMore(token: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    const entry = this.continuations.get(token)
    if (!entry) return { items: [], continuation: null }
    const next = (await entry.feed.getContinuation()) as Continuable & {
      playlists?: unknown[]
      results?: unknown[]
    }
    this.continuations.delete(token)
    const nodes = next.playlists ?? next.results ?? []
    return {
      items: nodes
        .map((n) => this.toPlaylistSummary(n))
        .filter((p): p is PlaylistSummary => p !== null),
      continuation: next.has_continuation
        ? this.token({ kind: 'channel:playlists', feed: next })
        : null
    }
  }

  async getChannelAbout(id: string): Promise<AboutInfo> {
    const channel = await this.getChannel(id)
    const about = await channel.getAbout()
    const m = about?.metadata ?? {}
    const links: { title: string; url: string }[] = []
    for (const l of ((m.links ?? []) as any[])) {
      const title = text(l.title)
      let url =
        l.link?.endpoint?.payload?.url ??
        l.endpoint?.payload?.url ??
        l.navigation_endpoint?.payload?.url ??
        (typeof l.url === 'string' ? l.url : '')
      if (typeof url === 'string' && url) {
        try {
          const parsed = new URL(url)
          const q = parsed.searchParams.get('q')
          if (q && (q.startsWith('http://') || q.startsWith('https://'))) {
            url = q
          }
        } catch {
          /* keep raw url */
        }
      }
      if (!url) {
        const raw = typeof l.link === 'string' ? l.link : text(l.link) || text(l.url)
        if (raw) {
          url = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
        }
      }
      if (
        title &&
        typeof url === 'string' &&
        (url.startsWith('http://') || url.startsWith('https://'))
      ) {
        links.push({ title, url })
      }
    }
    return {
      description: text(m.description) || null,
      country: text(m.country) || null,
      subscriberCount: text(m.subscriber_count) || null,
      viewCount: text(m.view_count) || null,
      joinedDate: text(m.joined_date) || null,
      videoCount: text(m.video_count) || null,
      links
    }
  }

  // -------------------------------------------------------------------------
  // Remote (YouTube) playlists
  // -------------------------------------------------------------------------

  async getRemotePlaylist(id: string): Promise<RemotePlaylist> {
    const yt = await this.client()
    const playlist = await yt.getPlaylist(id)
    const info = playlist.info ?? {}
    const feed = playlist as unknown as Continuable
    const items = this.feedVideos(playlist)
    const countText = text(info.total_items) || null
    const infoThumbs = (info.thumbnails ?? []) as ThumbLike[]
    return {
      id,
      title: text(info.title) || 'Playlist',
      author: info.author?.name ?? null,
      count: parseCompactCount(countText),
      countText,
      views: text(info.views) || null,
      lastUpdated: text(info.last_updated) || null,
      description: text(info.description) || null,
      thumbnail:
        pickThumbnail(infoThumbs, 480) || items[0]?.thumbnail || null,
      items,
      continuation: feed.has_continuation
        ? this.token({ kind: 'remote:playlist', feed })
        : null
    }
  }

  async remotePlaylistMore(token: string): Promise<RemotePlaylist> {
    const entry = this.continuations.get(token)
    if (!entry) return this.emptyRemotePlaylist()
    const next = (await entry.feed.getContinuation()) as Continuable
    this.continuations.delete(token)
    return {
      ...this.emptyRemotePlaylist(),
      items: this.feedVideos(next),
      continuation: next.has_continuation
        ? this.token({ kind: 'remote:playlist', feed: next })
        : null
    }
  }

  private emptyRemotePlaylist(): RemotePlaylist {
    return {
      id: '',
      title: '',
      author: null,
      count: null,
      countText: null,
      views: null,
      lastUpdated: null,
      description: null,
      thumbnail: null,
      items: [],
      continuation: null
    }
  }

  // -------------------------------------------------------------------------
  // Video details / manifest
  // -------------------------------------------------------------------------

  private async getInfo(videoId: string) {
    const cached = this.infoCache.get(videoId)
    if (cached && Date.now() - cached.fetchedAt < INFO_TTL_MS) return cached.info
    const yt = await this.client()
    let info: Awaited<ReturnType<Innertube['getInfo']>>
    try {
      info = await yt.getInfo(videoId, { client: CLIENT })
    } catch {
      info = await yt.getBasicInfo(videoId, { client: CLIENT })
    }
    this.infoCache.set(videoId, { info, fetchedAt: Date.now() })
    this.pruneMap(this.infoCache, 50)
    return info
  }

  /**
   * Language of the video's original audio track, resolved exactly the way
   * NewPipe does: the player response marks one audio format via
   * `audioTrack.audioIsDefault`, and the `acont` xtag marks originals
   * (`Format.is_original`, excluding Stable-Volume/voice-boost variants).
   */
  private defaultAudioLanguage(
    info: Awaited<ReturnType<YoutubeService['getInfo']>>
  ): string | null {
    const adaptive = info.streaming_data?.adaptive_formats as
      | {
          has_audio?: boolean
          language?: string | null
          audio_track?: { audio_is_default?: boolean }
          is_original?: boolean
          is_drc?: boolean
        }[]
      | undefined
    if (!adaptive) return null
    const audio = adaptive.filter((f) => f?.has_audio && f.language)
    if (audio.length === 0) return null
    const marked =
      audio.find((f) => f.audio_track?.audio_is_default && f.language) ??
      audio.find((f) => f.is_original && !f.is_drc && f.language)
    return (marked?.language ?? null) as string | null
  }

  private buildCaptions(raw: { base_url: string; language_code: string; name?: TextLike; kind?: string; is_translatable?: boolean; vss_id?: string }[] | undefined): CaptionTrack[] {
    if (!raw) return []
    return raw.map((track) => ({
      languageCode: track.language_code,
      name: text(track.name) || track.language_code,
      kind: track.kind ?? null,
      isTranslatable: Boolean(track.is_translatable),
      isAutomatic: track.kind === 'asr',
      url: this.proxyBase
        ? `${this.proxyBase}/captions?lang=${encodeURIComponent(track.language_code)}&u=${encodeURIComponent(track.base_url)}`
        : ''
    }))
  }

  /**
   * Extracts video chapters from official YouTube player bar markers,
   * macro markers engagement panels, or falls back to description timestamps.
   */
  private extractChapters(
    info: Awaited<ReturnType<YoutubeService['getInfo']>>,
    duration: number,
    description: string
  ): Chapter[] {
    // 1. Official YouTube player bar markers (markers_map)
    try {
      const markers = (info as unknown as { player_overlays?: { decorated_player_bar?: { player_bar?: { markers_map?: { value?: { chapters?: { title?: TextLike; time_range_start_millis?: number; thumbnail?: ThumbLike[] }[] } }[] } } } })?.player_overlays?.decorated_player_bar?.player_bar?.markers_map
      if (Array.isArray(markers)) {
        for (const marker of markers) {
          const rawChapters = marker?.value?.chapters
          if (Array.isArray(rawChapters) && rawChapters.length > 0) {
            const list: Chapter[] = []
            for (let i = 0; i < rawChapters.length; i++) {
              const ch = rawChapters[i]
              const title = text(ch?.title) || `Chapter ${i + 1}`
              const start =
                typeof ch?.time_range_start_millis === 'number'
                  ? Math.max(0, Math.floor(ch.time_range_start_millis / 1000))
                  : 0
              const thumbnail = pickThumbnail(ch?.thumbnail, 640) || null
              list.push({ title, start, end: 0, thumbnail })
            }
            if (list.length > 0) {
              return this.finalizeChapters(list, duration)
            }
          }
        }
      }
    } catch {
      // Fall through to next source
    }

    // 2. Engagement panels (MacroMarkersList)
    try {
      const panels = (info as unknown as { page?: [{ [key: string]: unknown }, { engagement_panels?: { panel_identifier?: string; content?: { type?: string; contents?: { type?: string; title?: TextLike; time_description?: TextLike; thumbnail?: ThumbLike[] }[] } }[] }] })?.page?.[1]?.engagement_panels
      if (Array.isArray(panels)) {
        const macroPanel = panels.find(
          (p) =>
            p?.panel_identifier?.includes('macro-markers') ||
            p?.content?.type === 'MacroMarkersList'
        )
        const contents = macroPanel?.content?.contents
        if (Array.isArray(contents) && contents.length > 0) {
          const list: Chapter[] = []
          for (let i = 0; i < contents.length; i++) {
            const item = contents[i]
            if (item?.type !== 'MacroMarkersListItem') continue
            const title = text(item.title) || `Chapter ${i + 1}`
            const timeStr = text(item.time_description)
            const start = this.parseTimestampToSeconds(timeStr)
            const thumbnail = pickThumbnail(item.thumbnail, 640) || null
            list.push({ title, start, end: 0, thumbnail })
          }
          if (list.length > 0) {
            return this.finalizeChapters(list, duration)
          }
        }
      }
    } catch {
      // Fall through to next source
    }

    // 3. Fallback: Parse description timestamps
    try {
      const descChapters = this.parseDescriptionChapters(description, duration)
      if (descChapters.length > 0) {
        return descChapters
      }
    } catch {
      // Fall through
    }

    return []
  }

  private parseTimestampToSeconds(str: string): number {
    if (!str) return 0
    const parts = str.trim().split(':').map((p) => parseInt(p, 10))
    if (parts.some((p) => isNaN(p))) return 0
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2]
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1]
    } else if (parts.length === 1) {
      return parts[0]
    }
    return 0
  }

  private parseDescriptionChapters(desc: string, duration: number): Chapter[] {
    if (!desc) return []
    const lines = desc.split(/\r?\n/)
    const found: { title: string; start: number }[] = []

    const p1 = /^(?:\[|\()?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\]|\))?\s*[-–—:]?\s*(.+)$/
    const p2 = /^(.+?)\s*[-–—:]?\s*(?:\[|\()?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\]|\))?$/

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      const m1 = line.match(p1)
      if (m1) {
        const hours = m1[1] ? parseInt(m1[1], 10) : 0
        const mins = parseInt(m1[2], 10)
        const secs = parseInt(m1[3], 10)
        const sec = (isNaN(hours) ? 0 : hours) * 3600 + (isNaN(mins) ? 0 : mins) * 60 + (isNaN(secs) ? 0 : secs)
        const title = m1[4].trim()
        if (title) found.push({ title, start: sec })
        continue
      }
      const m2 = line.match(p2)
      if (m2) {
        const hours = m2[2] ? parseInt(m2[2], 10) : 0
        const mins = parseInt(m2[3], 10)
        const secs = parseInt(m2[4], 10)
        const sec = (isNaN(hours) ? 0 : hours) * 3600 + (isNaN(mins) ? 0 : mins) * 60 + (isNaN(secs) ? 0 : secs)
        const title = m2[1].trim()
        if (title) found.push({ title, start: sec })
      }
    }

    if (found.length < 2) return []
    if (found[0].start > 5) return []
    for (let i = 1; i < found.length; i++) {
      if (found[i].start <= found[i - 1].start) return []
      if (duration > 0 && found[i].start >= duration) return []
    }

    const list: Chapter[] = found.map((item) => ({
      title: item.title,
      start: item.start,
      end: 0,
      thumbnail: null
    }))
    return this.finalizeChapters(list, duration)
  }

  private finalizeChapters(chapters: Chapter[], duration: number): Chapter[] {
    chapters.sort((a, b) => a.start - b.start)
    const unique: Chapter[] = []
    for (const ch of chapters) {
      if (unique.length === 0 || unique[unique.length - 1].start !== ch.start) {
        unique.push({ ...ch })
      }
    }
    if (unique.length > 0 && unique[0].start > 0) {
      unique.unshift({
        title: 'Intro',
        start: 0,
        end: unique[0].start,
        thumbnail: unique[0].thumbnail
      })
    }
    for (let i = 0; i < unique.length; i++) {
      if (i < unique.length - 1) {
        unique[i].end = unique[i + 1].start
      } else {
        unique[i].end = duration > unique[i].start ? duration : unique[i].start + 1
      }
    }
    return unique
  }

  async getVideo(videoId: string): Promise<VideoDetails> {
    const info = await this.getInfo(videoId)
    const basic = info.basic_info
    const status = info.playability_status
    const playable = status?.status === 'OK' && Boolean(info.streaming_data)
    const thumbs = normalizeThumbs(basic.thumbnail)
    const duration = basic.duration ?? 0
    const description =
      text(info.secondary_info?.description) || basic.short_description || ''
    const authorThumb =
      pickThumbnail((info.secondary_info as unknown as { owner?: { author?: { thumbnails?: ThumbLike[] } } })?.owner?.author?.thumbnails, 176) || null
    const chapters = this.extractChapters(info, duration, description)

    return {
      videoId: basic.id ?? videoId,
      title: basic.title ?? '',
      author: basic.channel?.name ?? basic.author ?? '',
      authorId: basic.channel?.id ?? basic.channel_id ?? null,
      authorThumbnail: authorThumb,
      duration,
      viewCount: basic.view_count ?? null,
      likeCount: basic.like_count ?? null,
      publishDate: info.primary_info?.published ? text(info.primary_info.published) || null : null,
      description,
      thumbnails: thumbs,
      isLive: Boolean(basic.is_live),
      playable,
      reason: playable ? null : (status?.reason ?? 'This video is not available'),
      manifestUrl: playable && this.proxyBase ? `${this.proxyBase}/manifest?id=${videoId}` : null,
      defaultAudioLanguage: this.defaultAudioLanguage(info),
      captions: this.buildCaptions(info.captions?.caption_tracks),
      keywords: basic.keywords ?? [],
      chapters
    }
  }

  /**
   * Direct progressive (single-file, audio+video) stream URL through the
   * proxy — the bottom rung of the playback ladder. When adaptive/DASH keeps
   * failing (expired URLs, stubborn 403s), the player falls back to loading
   * this URL directly, the same DASH→progressive fallback FreeTube and
   * NewPipe use. Always resolved fresh so the URL cannot be stale.
   */
  async getProgressiveUrl(videoId: string): Promise<string | null> {
    try {
      const yt = await this.client()
      const info = await yt.getBasicInfo(videoId, { client: CLIENT })
      if (info.playability_status?.status !== 'OK' || !info.streaming_data || !this.proxyBase) {
        return null
      }
      const muxed = (info.streaming_data.formats ?? []).filter(
        (f) => f?.has_video && f?.has_audio && f.url
      )
      if (muxed.length === 0) return null
      // Highest muxed rendition available (usually 360p/720p itag 18/22).
      muxed.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
      const best = muxed[0]
      return best?.url
        ? `${this.proxyBase}/media?u=${encodeURIComponent(best.url)}`
        : null
    } catch {
      return null
    }
  }

  async getManifest(videoId: string, force = false): Promise<string | null> {
    if (force) {
      this.infoCache.delete(videoId)
      this.manifestCache.delete(videoId)
    } else {
      const cached = this.manifestCache.get(videoId)
      if (cached && Date.now() - cached.fetchedAt < cached.ttl) return cached.xml
    }

    // Always use fresh streaming data here: the cached `getInfo` copy may
    // hold `expire`/`n` params that have since rotted, which surfaces in the
    // player as Shaka 1001 (BAD_HTTP_STATUS) on seeking.
    const yt = await this.client()
    const info = await yt.getBasicInfo(videoId, { client: CLIENT })
    if (info.playability_status?.status !== 'OK' || !info.streaming_data) return null

    const sd = info.streaming_data as unknown as {
      dash_manifest_url?: string
      hls_manifest_url?: string
    }
    const providedManifest = sd.dash_manifest_url ?? sd.hls_manifest_url
    const adaptive = info.streaming_data.adaptive_formats
    const isLive = info.basic_info?.is_live || (providedManifest && !adaptive?.length)

    // Live / post-live-DVR streams carry no adaptive formats, so `toDash`
    // throws. Like NewPipe/LibreTube (ExoPlayer) and FreeTube, serve the
    // manifest YouTube provides instead — fetched here and rewritten so every
    // segment request keeps flowing through our localhost proxy.
    // The IOS client returns no provided manifest for live, but VISIONOS and
    // ANDROID do (verified live) — so fall back to those player responses
    // when IOS has nothing to serve.
    if (isLive) {
      const xml =
        (providedManifest ? await this.fetchLiveManifest(providedManifest) : null) ??
        (await this.liveFallbackManifest(videoId))
      if (xml) {
        this.manifestCache.set(videoId, { xml, fetchedAt: Date.now(), ttl: LIVE_TTL_MS })
        this.pruneMap(this.manifestCache, 30)
        return xml
      }
      return null
    }

    // `toDash` deciphers `n`/`sig` internally via `session.player`. It decides
    // liveness from the inner player-response `video_details`, which can disagree
    // with `basic_info.is_live` — so a throw here also falls back to the
    // YouTube-provided manifest instead of 502ing (which the player showed as
    // "Unable to play the video / Shaka Error 1001").
    try {
      const xml = await info.toDash({
        url_transformer: (url: URL) =>
          new URL(`${this.proxyBase}/media?u=${encodeURIComponent(url.toString())}`)
      })
      this.manifestCache.set(videoId, { xml, fetchedAt: Date.now(), ttl: MANIFEST_TTL_MS })
      this.pruneMap(this.manifestCache, 30)
      return xml
    } catch {
      const xml =
        (providedManifest ? await this.fetchLiveManifest(providedManifest) : null) ??
        (await this.liveFallbackManifest(videoId))
      if (xml) {
        this.manifestCache.set(videoId, { xml, fetchedAt: Date.now(), ttl: LIVE_TTL_MS })
        this.pruneMap(this.manifestCache, 30)
        return xml
      }
      return null
    }
  }

  /**
   * Live-manifest fallback through alternate clients. IOS returns playability
   * OK for live but no `dash/hls_manifest_url` (verified live), so ask
   * elsewhere: VISIONOS first (token-free live HLS — the same source NewPipe
   * uses exclusively for running live), then ANDROID. HLS is preferred over
   * server DASH because running-live DASH rots/403s quickly while HLS is what
   * NewPipe, yt-dlp and FreeTube all play for ongoing live. Returns null on
   * any failure — callers treat that as "manifest unavailable".
   */
  private async liveFallbackManifest(videoId: string): Promise<string | null> {
    const yt = await this.client()
    for (const client of ['VISIONOS', 'ANDROID'] as const) {
      try {
        const info = await yt.getBasicInfo(videoId, { client })
        if (info.playability_status?.status !== 'OK' || !info.streaming_data) continue
        const sd = info.streaming_data as unknown as {
          dash_manifest_url?: string
          hls_manifest_url?: string
        }
        const provided = sd.hls_manifest_url ?? sd.dash_manifest_url
        if (!provided) continue
        // Decipher the `n` (throttle) param, like `toDash` does for formats.
        let url = provided
        try {
          url = (await yt.session.player?.decipher(provided)) ?? provided
        } catch {
          /* play the undeciphered URL rather than failing outright */
        }
        const xml = await this.fetchLiveManifest(url)
        if (xml) return xml
      } catch {
        /* try the next client */
      }
    }
    return null
  }

  /**
   * Fetches a YouTube-provided live manifest (DASH MPD or HLS playlist) and
   * rewrites every googlevideo URL inside it to our localhost media proxy so
   * the segments are requested with the Referer/Origin/UA headers YouTube
   * expects. Returns null when the body is not XML/text we can rewrite.
   */
  private async fetchLiveManifest(manifestUrl: string): Promise<string | null> {
    try {
      const res = await fetch(manifestUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Referer: 'https://www.youtube.com/',
          Origin: 'https://www.youtube.com'
        }
      })
      if (!res.ok) return null
      const body = await res.text()
      if (!this.proxyBase) return body
      if (body.trimStart().startsWith('#EXTM3U')) {
        try {
          return rewriteHls(body, this.proxyBase, new URL(manifestUrl))
        } catch {
          // fallback to regex if target URL parsing fails
        }
      }
      // MPD uses <BaseURL>https://…</BaseURL>; HLS uses bare URI lines.
      return body.replace(/https:\/\/[^\s"'<>\]]+/g, (url) =>
        url.includes('.googlevideo.com') || url.includes('.youtube.com')
          ? `${this.proxyBase}/media?u=${encodeURIComponent(url)}`
          : url
      )
    } catch {
      return null
    }
  }
}
