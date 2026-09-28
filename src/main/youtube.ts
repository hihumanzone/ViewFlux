import { randomUUID } from 'node:crypto'
import type { Innertube } from 'youtubei.js'
import { rewriteDash, rewriteHls } from './proxy'
import { ORIGIN, REFERER, USER_AGENT } from './http'
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
  VideoDetails,
  VideoSummary
} from '../shared/types'
import type {
  CachedChannel,
  CachedInfo,
  CachedManifest,
  Continuable,
  ContinuationEntry,
  LockupViewNode,
  NodeMemo,
  PlaylistFeed,
  TextLike,
  ThumbLike
} from './youtube/types'
import {
  absUrl,
  classifyChannelTexts,
  extractVideoChapters,
  hasMusicBadge,
  hasMusicTitleBadge,
  lockupAuthor,
  lockupBadges,
  lockupRows,
  normalizeThumbs,
  parseAgoDays,
  parseCompactCount,
  parseDurationText,
  pickThumbnail,
  splitReleaseByline,
  text
} from './youtube/parsers'

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
/** YouTube Music serves every music release as an auto-generated playlist. */
const RELEASE_PLAYLIST_PREFIX = 'OLAK5uy_'
/**
 * LockupView `content_type`s that carry a playlist. Album lockups are labelled
 * `ALBUM`, not `PLAYLIST` — NewPipe drops those, which is why some clients show
 * an empty discography for auto-generated topic channels.
 */
const PLAYLIST_LOCKUP_TYPES = ['PLAYLIST', 'ALBUM', 'PODCAST', 'SHOW']
/** Node types a feed contributes playlists from (youtubei.js `GridShow` ≈ show). */
const PLAYLIST_NODE_TYPES = ['Playlist', 'GridPlaylist', 'GridShow']
/** Node types carrying a continuation token. */
const CONTINUATION_NODE_TYPES = ['ContinuationItem', 'ContinuationItemView', 'ContinuationCommand']
/** Home-page shelf holding a "- Topic" channel's discography. */
const ALBUMS_SHELF_TITLE = /album/i
/** "13 videos" / "13 songs" / "9 tracks" — the count on a playlist or album card. */
const TRACK_COUNT_REGEX = /\d+\s*(?:videos?|songs?|tracks?)\b/i
/** Type words LockupViews put in their first metadata row instead of a byline. */
const PLAYLIST_TYPE_WORDS = /^(?:playlist|album|ep|single|music video|video)$/i
/** "13 videos" — YouTube's wording for a track count. */
const VIDEO_COUNT_REGEX = /^(\d[\d,.]*)\s+videos?$/i

/** An album's tracks are songs; the raw count text still says "videos". */
function trackCountText(countText: string | null, isAlbum: boolean): string | null {
  if (!isAlbum || !countText) return countText
  return countText.replace(VIDEO_COUNT_REGEX, (_match, n: string) => {
    const count = Number.parseInt(n.replace(/[,.]/g, ''), 10)
    return `${n} ${count === 1 ? 'song' : 'songs'}`
  })
}

export class YoutubeService {
  private yt: Innertube | null = null
  private initPromise: Promise<Innertube> | null = null
  private proxyBase = ''
  private readonly continuations = new Map<string, ContinuationEntry>()
  private readonly infoCache = new Map<string, CachedInfo>()
  private readonly manifestCache = new Map<string, CachedManifest>()
  private readonly channelCache = new Map<string, CachedChannel>()
  private readonly inFlightChannels = new Map<string, Promise<any>>()
  private readonly inFlightInfo = new Map<string, Promise<any>>()

  setProxyBase(base: string): void {
    this.proxyBase = base
  }

  private async client(): Promise<Innertube> {
    if (this.yt) return this.yt
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const { Innertube, Log, Parser, Platform } = await import('youtubei.js')
        Log.setLevel(Log.Level.NONE)
        // youtubei.js hands every unparseable node to a global reporter that
        // interpolates `packageInfo.bugs.url` into its "please report this"
        // text. electron-builder rewrites a dependency's package.json when it
        // packs it into app.asar and drops `bugs`, so in an installed build
        // `packageInfo.bugs` is undefined and the reporter itself throws
        // `TypeError: Cannot read properties of undefined (reading 'url')`.
        // That escapes the try/catch wrapping the node parse, so one unknown
        // renderer (which mixed "All" search surfaces constantly) took down the
        // whole request — packaged builds only, since `npm run dev` reads the
        // intact package.json off disk. `parseItem` already drops nodes it
        // cannot build, so a silent reporter restores the dev behaviour.
        Parser.setParserErrorHandler(() => {})
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
    for (const row of rows) {
      for (const part of row) {
        if (author && part === author) continue
        if (!published && /ago|streamed|premiered/i.test(part)) published = part
        else if (!viewsText && /\d/.test(part) && !part.startsWith('@')) viewsText = part
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
      isLive: Boolean(durationBadge && /live/i.test(durationBadge))
    }
  }

  private toChannelSummary(node: unknown): ChannelSummary | null {
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
      description: text(c.description) || null,
      isMusic: hasMusicBadge(c.author?.badges)
    }
  }

  /**
   * Maps a playlist or music-release node. `isRelease` marks nodes that come
   * from a channel's "Releases" tab, where every entry is an album even if
   * YouTube hands out a plain playlist id.
   */
  private toPlaylistSummary(node: unknown, isRelease = false): PlaylistSummary | null {
    if (this.isLockup(node)) {
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
    // YouTube Music serves every release as an auto-generated playlist; that
    // prefix is the only thing distinguishing an album from a hand-made one.
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
            node.content_type === 'PLAYLIST' || node.content_type === 'ALBUM'
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
    if (cached && Date.now() - cached.fetchedAt < CHANNEL_TTL_MS) {
      this.channelCache.delete(id)
      this.channelCache.set(id, cached)
      return cached.channel
    }
    const pending = this.inFlightChannels.get(id)
    if (pending) return pending

    const promise = (async () => {
      const yt = await this.client()
      const channel = await yt.getChannel(id)
      this.channelCache.set(id, { channel, fetchedAt: Date.now() })
      this.pruneMap(this.channelCache, 40)
      return channel
    })().finally(() => {
      this.inFlightChannels.delete(id)
    })

    this.inFlightChannels.set(id, promise)
    return promise
  }

  async getChannelInfo(id: string): Promise<ChannelInfo> {
    const channel = await this.getChannel(id)

    const meta = channel.metadata ?? {}
    const header = channel.header ?? {}
    const headerContent = header.content ?? {}
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

    // The note logo rides along with the channel name: as a badge on the legacy
    // tabbed header, and — on the current layout, where `header.author` is left
    // empty — as an attachment on the title run itself. `music_artist_name` is
    // only set on auto-generated "- Topic" channels; official artist channels
    // send an empty string there.
    const isMusic =
      hasMusicTitleBadge(headerContent.title) ||
      hasMusicTitleBadge(headerContent.page_title) ||
      hasMusicBadge(header.author?.badges) ||
      Boolean(meta.music_artist_name)

    try {
      const names: string[] = channel.tabs ?? []
      if (names.includes('Videos') || safeHas('has_videos')) tabs.push('videos')
      // Music channels put their albums on a "Releases" tab, between videos and
      // playlists — same order YouTube renders them in. "- Topic" channels are
      // music channels without that tab, so fall back to their discography
      // shelf; without the music check a stray "Albums" shelf would invent one.
      if (
        names.includes('Releases') ||
        safeHas('has_releases') ||
        (isMusic && this.albumsShelfToken(channel))
      ) {
        tabs.push('releases')
      }
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
      tabs,
      isMusic
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
    const CONCURRENCY = 5
    const allVideos: VideoSummary[] = []
    const seenVideoIds = new Set<string>()
    const total = uniqueIds.length
    let done = 0
    onProgress?.(done, total)

    const fetchChannelWithTimeout = async (id: string): Promise<ChannelVideosPage | null> => {
      let timer: NodeJS.Timeout | null = null
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Channel feed fetch timed out')), 8000)
        })
        const result = await Promise.race([
          this.getChannelVideos(id, 'newest'),
          timeoutPromise
        ])
        return result
      } catch {
        return null
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    let currentIndex = 0
    const worker = async (): Promise<void> => {
      while (currentIndex < uniqueIds.length) {
        const idx = currentIndex++
        const id = uniqueIds[idx]
        const page = await fetchChannelWithTimeout(id)
        done += 1
        if (page?.items) {
          for (const item of page.items) {
            if (!seenVideoIds.has(item.videoId)) {
              seenVideoIds.add(item.videoId)
              allVideos.push(item)
            }
          }
        }
        onProgress?.(done, total)
      }
    }

    const workerCount = Math.min(CONCURRENCY, uniqueIds.length)
    const workers = Array.from({ length: workerCount }, () => worker())
    await Promise.all(workers)

    // Precompute age in days for all videos in a single O(N) pass to avoid
    // running regex parsing repeatedly inside the sort comparator.
    const withAge = allVideos.map((v) => ({
      video: v,
      age: parseAgoDays(v.published) ?? 99999
    }))

    // Filter by maxAgeDays if requested
    const filtered =
      typeof maxAgeDays === 'number' && maxAgeDays > 0
        ? withAge.filter((item) => item.age <= maxAgeDays)
        : withAge

    // Sort newest first using precomputed numeric age
    filtered.sort((a, b) => a.age - b.age)

    return filtered.map((item) => item.video)
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

  /** Playlist/release nodes of a channel tab or its continuation feed. */
  private feedPlaylists(feed: PlaylistFeed | null | undefined, isRelease = false): PlaylistSummary[] {
    const nodes = feed?.playlists ?? feed?.results ?? []
    return nodes
      .map((n) => this.toPlaylistSummary(n, isRelease))
      .filter((p): p is PlaylistSummary => p !== null)
  }

  async getChannelPlaylists(id: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    const channel = await this.getChannel(id)
    const feed = (await channel.getPlaylists()) as PlaylistFeed
    return {
      items: this.feedPlaylists(feed),
      continuation: feed.has_continuation
        ? this.token({ kind: 'channel:playlists', feed })
        : null
    }
  }

  async channelPlaylistsMore(token: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    const entry = this.continuations.get(token)
    if (!entry) return { items: [], continuation: null }
    const next = (await entry.feed.getContinuation()) as PlaylistFeed
    this.continuations.delete(token)
    return {
      items: this.feedPlaylists(next),
      continuation: next.has_continuation
        ? this.token({ kind: 'channel:playlists', feed: next })
        : null
    }
  }

  /**
   * The `Memo` indexes of a parsed `browse` response. `Parser.parseResponse`
   * returns a plain object keyed by response field (`contents_memo`,
   * `on_response_received_endpoints_memo`, …), each a `Memo extends Map` of
   * node type → nodes.
   */
  private browseMemos(response: unknown): NodeMemo[] {
    if (!response || typeof response !== 'object') return []
    return Object.values(response).filter(
      (value): value is NodeMemo => value instanceof Map
    )
  }

  /** Playlist/album nodes of a raw browse response (what youtubei.js `Feed` collects). */
  private memoPlaylists(memos: NodeMemo[]): unknown[] {
    const out: unknown[] = []
    for (const memo of memos) {
      for (const type of PLAYLIST_NODE_TYPES) out.push(...(memo.get(type) ?? []))
      out.push(
        ...(memo.get('LockupView') ?? []).filter((lockup) =>
          PLAYLIST_LOCKUP_TYPES.includes((lockup as { content_type?: string })?.content_type ?? '')
        )
      )
    }
    return out
  }

  /** Continuation token of a raw browse response, when it has another page. */
  private memoContinuation(memos: NodeMemo[]): string | null {
    for (const memo of memos) {
      for (const type of CONTINUATION_NODE_TYPES) {
        for (const item of memo.get(type) ?? []) {
          const token =
            (item as { endpoint?: { payload?: { token?: string } } }).endpoint?.payload?.token ??
            (item as { token?: string }).token
          if (typeof token === 'string' && token) return token
        }
      }
    }
    return null
  }

  /**
   * Presents a raw `browse` response as a `Feed`, so listings that only exist
   * behind a one-off endpoint (a "- Topic" discography, say) feed the same
   * mappers and continuation bookkeeping as a real tab.
   */
  private feedFrom(response: unknown): PlaylistFeed {
    const memos = this.browseMemos(response)
    const nextToken = this.memoContinuation(memos)
    const svc = this
    return {
      get playlists() {
        return svc.memoPlaylists(memos)
      },
      has_continuation: Boolean(nextToken),
      getContinuation: () =>
        nextToken ? svc.continuationFeed(nextToken) : Promise.resolve({ playlists: [] })
    }
  }

  /** Follows a raw `browse` continuation token and wraps the page as a feed. */
  private async continuationFeed(continuation: string): Promise<PlaylistFeed> {
    const yt = await this.client()
    const response = await yt.actions.execute('/browse', { continuation, parse: true })
    return this.feedFrom(response)
  }

  /**
   * Continuation token of a "- Topic" channel's discography.
   *
   * Auto-generated topic channels have a single `Home` tab and no `/releases`
   * route — YouTube hides their albums behind an "Albums & Singles" shelf whose
   * title links to an engagement panel holding a continuation token. The shelf
   * only ever previews a dozen `LockupView`s with no playlist id, so the panel is
   * the first place the real `OLAK5uy_` ids show up.
   */
  private albumsShelfToken(channel: unknown): string | null {
    type Run = { endpoint?: { name?: string; payload?: unknown } }
    type Shelf = { title?: { toString?: () => string; runs?: Run[] } }
    type Panel = {
      engagementPanel?: {
        engagementPanelSectionListRenderer?: {
          content?: {
            sectionListRenderer?: {
              contents?: { itemSectionRenderer?: { contents?: { continuationItemRenderer?: unknown }[] } }[]
            }
          }
        }
      }
    }
    const shelves: Shelf[] = (channel as { shelves?: Shelf[] })?.shelves ?? []
    for (const shelf of shelves) {
      const title = shelf.title?.toString?.() ?? ''
      if (!ALBUMS_SHELF_TITLE.test(title)) continue
      for (const run of shelf.title?.runs ?? []) {
        if (run.endpoint?.name !== 'showEngagementPanelEndpoint') continue
        const sectionList = (run.endpoint.payload as Panel | undefined)?.engagementPanel
          ?.engagementPanelSectionListRenderer?.content?.sectionListRenderer
        const token = (
          sectionList?.contents?.[0]?.itemSectionRenderer?.contents?.[0]
            ?.continuationItemRenderer as
            | { continuationEndpoint?: { continuationCommand?: { token?: string } } }
            | undefined
        )?.continuationEndpoint?.continuationCommand?.token
        if (token) return token
      }
    }
    return null
  }

  /**
   * Albums of a music channel: its "Releases" tab, or — for auto-generated
   * "- Topic" channels, which have no such tab — the discography shelf on the
   * channel home page.
   *
   * `getReleases()` throws when the tab is missing, which is every non-music
   * channel, so failures degrade to an empty list rather than an error the
   * renderer would have to special-case.
   */
  async getChannelReleases(id: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    const channel = await this.getChannel(id)
    let feed: PlaylistFeed | null = null
    try {
      feed = (await channel.getReleases()) as PlaylistFeed
    } catch {
      try {
        const token = this.albumsShelfToken(channel)
        if (token) feed = await this.continuationFeed(token)
      } catch {
        /* no discography we can reach — same as a channel without one */
      }
    }
    if (!feed) return { items: [], continuation: null }
    return {
      items: this.feedPlaylists(feed, true),
      continuation: feed.has_continuation
        ? this.token({ kind: 'channel:releases', feed })
        : null
    }
  }

  async channelReleasesMore(token: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    const entry = this.continuations.get(token)
    if (!entry) return { items: [], continuation: null }
    const next = (await entry.feed.getContinuation()) as PlaylistFeed
    this.continuations.delete(token)
    return {
      items: this.feedPlaylists(next, true),
      continuation: next.has_continuation
        ? this.token({ kind: 'channel:releases', feed: next })
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
    if (cached && Date.now() - cached.fetchedAt < INFO_TTL_MS) {
      this.infoCache.delete(videoId)
      this.infoCache.set(videoId, cached)
      return cached.info
    }
    const pending = this.inFlightInfo.get(videoId)
    if (pending) return pending

    const promise = (async () => {
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
    })().finally(() => {
      this.inFlightInfo.delete(videoId)
    })

    this.inFlightInfo.set(videoId, promise)
    return promise
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
    return extractVideoChapters(info, duration, description)
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
      if (cached && Date.now() - cached.fetchedAt < cached.ttl) {
        this.manifestCache.delete(videoId)
        this.manifestCache.set(videoId, cached)
        return cached.xml
      }
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
    // Live streams are served from YouTube's HLS master playlist, which provides
    // clean separate audio (ADTS AAC) and video (MPEG-TS) renditions with
    // valid presentation timestamps. Shaka Player uses built-in transmuxers
    // (AacTransmuxer and TsTransmuxer) to package them into fMP4 on the fly.
    // VISIONOS hands out `hls_manifest_url` token-free; if unavailable,
    // we fall back across VISIONOS, ANDROID, and ANDROID_VR.
    const providedManifest = sd.hls_manifest_url ?? sd.dash_manifest_url
    // `is_live` is the authoritative marker. The adaptive-format count is *not*
    // a live signal: VISIONOS returns 8 adaptive formats for a live stream
    // (137/136/135/134/133/160 + 139/140), so an emptiness test would only ever
    // fire on genuinely broken responses and misroute those to the live path.
    const isLive = Boolean(info.basic_info?.is_live)

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
   * Live-manifest fallback through alternate clients.
   *
   * Queries VISIONOS, ANDROID, and ANDROID_VR for a valid live manifest (HLS
   * preferred, DASH as secondary fallback). Returns null on failure.
   */
  private async liveFallbackManifest(videoId: string): Promise<string | null> {
    const yt = await this.client()
    for (const client of ['VISIONOS', 'ANDROID', 'ANDROID_VR'] as const) {
      try {
        const info = await yt.getBasicInfo(videoId, { client })
        if (info.playability_status?.status !== 'OK' || !info.streaming_data) continue
        const sd = info.streaming_data as unknown as {
          dash_manifest_url?: string
          hls_manifest_url?: string
        }
        const provided = sd.hls_manifest_url ?? sd.dash_manifest_url
        if (!provided) continue
        const xml = await this.fetchLiveManifest(provided)
        if (xml) return xml
      } catch {
        /* try the next client */
      }
    }
    return null
  }

  /**
   * Fetches a YouTube-provided live manifest (HLS master playlist or DASH MPD)
   * and rewrites every googlevideo URL inside it to our localhost media proxy,
   * so the nested playlists and segments are requested with the
   * Referer/Origin/User-Agent YouTube expects. Returns null when the body
   * cannot be fetched — callers treat that as "manifest unavailable".
   */
  private async fetchLiveManifest(manifestUrl: string): Promise<string | null> {
    // Decipher the `n` (throttle) parameter the same way `toDash` does for
    // formats. It is a no-op for the current YouTube live manifests (the
    // `n` values arrive undeciphered and are accepted as-is), but skipping it
    // is exactly the kind of shortcut that rots the day YouTube starts
    // throttling, and a failed decipher must never sink the whole manifest.
    let target = manifestUrl
    try {
      const decipher = (await this.client()).session.player
      if (decipher) target = (await decipher.decipher(manifestUrl)) ?? manifestUrl
    } catch {
      /* play the undeciphered URL rather than failing outright */
    }

    try {
      const res = await fetch(target, {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: REFERER,
          Origin: ORIGIN
        }
      })
      if (!res.ok) return null
      const body = await res.text()
      if (!this.proxyBase) return body
      if (body.trimStart().startsWith('#EXTM3U')) {
        try {
          return rewriteHls(body, this.proxyBase, new URL(target))
        } catch {
          // fallback to regex if target URL parsing fails
        }
      }
      // DASH MPD. YouTube's live MPDs put every `<SegmentURL media="…"/>` in a
      // *relative* form that only resolves against the enclosing
      // `<Representation>`'s `<BaseURL>`, so the representation-scoped rewriter
      // is required here — a bare absolute-URL regex would leave every segment
      // pointing at googlevideo and the renderer CSP would block them all.
      try {
        return rewriteDash(body, this.proxyBase, new URL(target))
      } catch {
        // fall through to the absolute-URL sweep
      }
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
