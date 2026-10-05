import type {
  AboutInfo,
  ChannelInfo,
  ChannelSort,
  ChannelVideosPage,
  PlaylistSummary,
  VideoSummary
} from '../../shared/types'
import { getClient } from './client'
import { feedPlaylists, feedVideos } from './mappers'
import {
  classifyChannelTexts,
  hasMusicBadge,
  hasMusicTitleBadge,
  parseAgoDays,
  pickThumbnail,
  text
} from './parsers'
import { pruneMap, type TokenStore } from './tokens'
import type {
  CachedChannel,
  Continuable,
  NodeMemo,
  PlaylistFeed,
  TextLike,
  ThumbLike
} from './types'

const CHANNEL_TTL_MS = 10 * 60 * 1000
const AVATAR_LOOKUP_CONCURRENCY = 5
const CONTINUATION_NODE_TYPES = ['ContinuationItem', 'ContinuationItemView', 'ContinuationCommand']
const PLAYLIST_NODE_TYPES = ['Playlist', 'GridPlaylist', 'GridShow']
const PLAYLIST_LOCKUP_TYPES = ['PLAYLIST', 'ALBUM', 'PODCAST', 'SHOW']
const ALBUMS_SHELF_TITLE = /album/i

export class ChannelService {
  private readonly channelCache = new Map<string, CachedChannel>()
  private readonly inFlightChannels = new Map<string, Promise<any>>()
  private readonly canonicalIdCache = new Map<string, string>()
  private readonly inFlightResolutions = new Map<string, Promise<string>>()

  constructor(private readonly tokens: TokenStore) {}

  async resolveCanonicalId(id: string): Promise<string> {
    const trimmed = id.trim()
    if (/^(UC|HC)[a-zA-Z0-9_-]{22}$/.test(trimmed)) {
      return trimmed
    }
    const cached = this.canonicalIdCache.get(trimmed)
    if (cached) return cached

    const pending = this.inFlightResolutions.get(trimmed)
    if (pending) return pending

    const promise = (async () => {
      const yt = await getClient()
      let url: string
      if (/^https?:\/\//i.test(trimmed)) {
        url = trimmed
      } else if (trimmed.startsWith('@')) {
        url = `https://www.youtube.com/${trimmed}`
      } else if (
        trimmed.startsWith('c/') ||
        trimmed.startsWith('user/') ||
        trimmed.startsWith('u/') ||
        trimmed.startsWith('custom/')
      ) {
        url = `https://www.youtube.com/${trimmed.startsWith('u/') ? 'user/' + trimmed.slice(2) : trimmed}`
      } else {
        url = `https://www.youtube.com/@${trimmed}`
      }

      try {
        const endpoint = await yt.resolveURL(url)
        const browseId = (endpoint?.payload as { browseId?: string } | undefined)?.browseId
        if (browseId && typeof browseId === 'string' && /^(UC|HC)[a-zA-Z0-9_-]{22}$/.test(browseId)) {
          this.canonicalIdCache.set(trimmed, browseId)
          return browseId
        }
      } catch (err: any) {
        if (!trimmed.startsWith('@') && !trimmed.startsWith('c/') && !trimmed.startsWith('user/')) {
          try {
            const fallbackUrl = `https://www.youtube.com/${trimmed}`
            const endpoint = await yt.resolveURL(fallbackUrl)
            const browseId = (endpoint?.payload as { browseId?: string } | undefined)?.browseId
            if (browseId && typeof browseId === 'string' && /^(UC|HC)[a-zA-Z0-9_-]{22}$/.test(browseId)) {
              this.canonicalIdCache.set(trimmed, browseId)
              return browseId
            }
          } catch {
            // continue to throw
          }
        }
        const msg = err?.info?.error?.message || err?.message || 'Not found'
        throw new Error(`Channel not found: ${trimmed} (${msg})`)
      }
      throw new Error(`Channel not found: ${trimmed}`)
    })().finally(() => {
      this.inFlightResolutions.delete(trimmed)
    })

    this.inFlightResolutions.set(trimmed, promise)
    return promise
  }

  async getChannel(id: string): Promise<any> {
    const canonicalId = await this.resolveCanonicalId(id)

    const cached = this.channelCache.get(canonicalId) ?? this.channelCache.get(id)
    if (cached && Date.now() - cached.fetchedAt < CHANNEL_TTL_MS) {
      this.channelCache.delete(canonicalId)
      this.channelCache.set(canonicalId, cached)
      if (id !== canonicalId) {
        this.channelCache.set(id, cached)
      }
      return cached.channel
    }
    const pending = this.inFlightChannels.get(canonicalId)
    if (pending) return pending

    const promise = (async () => {
      const yt = await getClient()
      const channel = await yt.getChannel(canonicalId)
      const entry = { channel, fetchedAt: Date.now() }
      this.channelCache.set(canonicalId, entry)
      if (id !== canonicalId) {
        this.channelCache.set(id, entry)
      }
      pruneMap(this.channelCache, 40)
      return channel
    })().finally(() => {
      this.inFlightChannels.delete(canonicalId)
    })

    this.inFlightChannels.set(canonicalId, promise)
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

    const isMusic =
      hasMusicTitleBadge(headerContent.title) ||
      hasMusicTitleBadge(headerContent.page_title) ||
      hasMusicBadge(header.author?.badges) ||
      Boolean(meta.music_artist_name)

    try {
      const names: string[] = channel.tabs ?? []
      if (names.includes('Videos') || safeHas('has_videos')) tabs.push('videos')
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

    const canonicalId = (meta.external_id as string) || (channel.id as string) || id
    return {
      id: canonicalId,
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
      /* channel is gone or private */
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

  async getChannelVideos(id: string, sort: ChannelSort): Promise<ChannelVideosPage> {
    const channel = await this.getChannel(id)
    const ctx = {
      author: text(channel.metadata?.title) || null,
      authorId: id as string | null,
      authorAvatar: pickThumbnail(channel.metadata?.avatar, 240) || null
    }
    let feed = (await channel.getVideos()) as Continuable

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

    const items = feedVideos(feed, ctx)

    return {
      items,
      continuation: feed.has_continuation
        ? this.tokens.set({ kind: 'channel:videos', feed, ctx })
        : null
    }
  }

  async channelVideosMore(token: string): Promise<ChannelVideosPage> {
    const entry = this.tokens.get(token)
    if (!entry) return { items: [], continuation: null }
    const next = (await entry.feed.getContinuation()) as Continuable
    this.tokens.delete(token)
    const ctx =
      entry.ctx as
        | { author?: string; authorId?: string | null; authorAvatar?: string | null }
        | undefined
    return {
      items: feedVideos(next, ctx),
      continuation: next.has_continuation
        ? this.tokens.set({ kind: 'channel:videos', feed: next, ctx })
        : null
    }
  }

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

    const fetchChannelRssTimestamps = async (channelId: string): Promise<Map<string, number>> => {
      const map = new Map<string, number>()
      try {
        const canonical = await this.resolveCanonicalId(channelId).catch(() => channelId)
        const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${canonical}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          signal: AbortSignal.timeout(6000)
        })
        if (!res.ok) return map
        const xml = await res.text()
        const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
        let match: RegExpExecArray | null
        while ((match = entryRegex.exec(xml)) !== null) {
          const entryContent = match[1]
          const idMatch = entryContent.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)
          const pubMatch = entryContent.match(/<published>([^<]+)<\/published>/)
          if (idMatch && pubMatch) {
            const time = Date.parse(pubMatch[1])
            if (!Number.isNaN(time)) {
              map.set(idMatch[1], time)
            }
          }
        }
      } catch {
        // RSS fallback
      }
      return map
    }

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
        const [page, rssTimestamps] = await Promise.all([
          fetchChannelWithTimeout(id),
          fetchChannelRssTimestamps(id)
        ])
        done += 1
        if (page?.items) {
          page.items.forEach((item, itemIdx) => {
            if (!seenVideoIds.has(item.videoId)) {
              seenVideoIds.add(item.videoId)
              const rssTs = rssTimestamps.get(item.videoId)
              let publishTs = rssTs ?? item.publishTimestamp ?? null
              if (publishTs == null) {
                const ageDays = parseAgoDays(item.published) ?? 99999
                // Subtract itemIdx to keep channel-native chronological order as deterministic tie-breaker
                publishTs = Date.now() - ageDays * 86400000 - itemIdx * 1000
              }
              item.publishTimestamp = publishTs
              allVideos.push(item)
            }
          })
        }
        onProgress?.(done, total)
      }
    }

    const workerCount = Math.min(CONCURRENCY, uniqueIds.length)
    const workers = Array.from({ length: workerCount }, () => worker())
    await Promise.all(workers)

    const now = Date.now()
    const filtered =
      typeof maxAgeDays === 'number' && maxAgeDays > 0
        ? allVideos.filter((v) => {
            const ts = v.publishTimestamp ?? (now - (parseAgoDays(v.published) ?? 99999) * 86400000)
            return now - ts <= maxAgeDays * 86400000
          })
        : allVideos

    // Sort strictly by exact publish timestamps (newest first).
    // Break ties deterministically by video ID so internal order is 100% stable and deterministic.
    filtered.sort((a, b) => {
      const diff = (b.publishTimestamp ?? 0) - (a.publishTimestamp ?? 0)
      if (diff !== 0) return diff
      return a.videoId.localeCompare(b.videoId)
    })

    return filtered
  }

  async getChannelPlaylists(id: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    const channel = await this.getChannel(id)
    const feed = (await channel.getPlaylists()) as PlaylistFeed
    return {
      items: feedPlaylists(feed),
      continuation: feed.has_continuation
        ? this.tokens.set({ kind: 'channel:playlists', feed })
        : null
    }
  }

  async channelPlaylistsMore(token: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    const entry = this.tokens.get(token)
    if (!entry) return { items: [], continuation: null }
    const next = (await entry.feed.getContinuation()) as PlaylistFeed
    this.tokens.delete(token)
    return {
      items: feedPlaylists(next),
      continuation: next.has_continuation
        ? this.tokens.set({ kind: 'channel:playlists', feed: next })
        : null
    }
  }

  private browseMemos(response: unknown): NodeMemo[] {
    if (!response || typeof response !== 'object') return []
    return Object.values(response).filter(
      (value): value is NodeMemo => value instanceof Map
    )
  }

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

  private async continuationFeed(continuation: string): Promise<PlaylistFeed> {
    const yt = await getClient()
    const response = await yt.actions.execute('/browse', { continuation, parse: true })
    return this.feedFrom(response)
  }

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
        /* no discography */
      }
    }
    if (!feed) return { items: [], continuation: null }
    return {
      items: feedPlaylists(feed, true),
      continuation: feed.has_continuation
        ? this.tokens.set({ kind: 'channel:releases', feed })
        : null
    }
  }

  async channelReleasesMore(token: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    const entry = this.tokens.get(token)
    if (!entry) return { items: [], continuation: null }
    const next = (await entry.feed.getContinuation()) as PlaylistFeed
    this.tokens.delete(token)
    return {
      items: feedPlaylists(next, true),
      continuation: next.has_continuation
        ? this.tokens.set({ kind: 'channel:releases', feed: next })
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
}
