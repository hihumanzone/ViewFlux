import type { SearchFilter, SearchItem, SearchPage, VideoSummary } from '../../shared/types'
import { getClient } from './client'
import { dedupe, isLockup, toChannelSummary, toMusicSummary, toPlaylistSummary, toSummary, toLockupVideo } from './mappers'
import type { TokenStore } from './tokens'
import type { Continuable, ContinuationEntry } from './types'

export class SearchService {
  constructor(private readonly tokens: TokenStore) {}

  async search(query: string, filter: SearchFilter = 'all'): Promise<SearchPage> {
    const yt = await getClient()
    const q = query.trim()
    if (!q) return { items: [], continuation: null }

    if (filter === 'music') {
      const feed = (await yt.music.search(q, { type: 'video' })) as unknown as Continuable
      const items = this.musicItems(feed)
        .map((n) => toMusicSummary(n))
        .filter((i): i is VideoSummary => i !== null)
        .map((v): SearchItem => ({ type: 'video', ...v }))
      return {
        items,
        continuation: feed.has_continuation
          ? this.tokens.set({ kind: 'search:music', feed })
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
        ? this.tokens.set({ kind, feed: results as unknown as Continuable })
        : null
    }
  }

  private searchItems(nodes: unknown[], kind: ContinuationEntry['kind']): SearchItem[] {
    const items: SearchItem[] = []
    if (kind === 'search:music') {
      for (const node of nodes) {
        const v = toMusicSummary(node)
        if (v) items.push({ type: 'video', ...v })
      }
      return items
    }
    for (const node of nodes) {
      const type = (node as { type?: string })?.type
      if (kind === 'search:videos') {
        const v = toSummary(node)
        if (v) items.push({ type: 'video', ...v })
      } else if (kind === 'search:channels') {
        const c = toChannelSummary(node)
        if (c) items.push({ type: 'channel', ...c })
      } else if (kind === 'search:playlists') {
        const p = toPlaylistSummary(node)
        if (p) items.push({ type: 'playlist', ...p })
      } else {
        // Mixed results: map by node type, skip shelves and promotions.
        if (type === 'Video' || type === 'GridVideo' || type === 'Movie') {
          const v = toSummary(node)
          if (v) items.push({ type: 'video', ...v })
        } else if (type === 'Channel' || type === 'GridChannel') {
          const c = toChannelSummary(node)
          if (c) items.push({ type: 'channel', ...c })
        } else if (isLockup(node)) {
          const mapped =
            node.content_type === 'PLAYLIST' || node.content_type === 'ALBUM'
              ? toPlaylistSummary(node)
              : toLockupVideo(node)
          if (mapped) {
            items.push(
              'videoId' in mapped
                ? { type: 'video', ...(mapped as VideoSummary) }
                : { type: 'playlist', ...(mapped as any) }
            )
          }
        }
      }
    }
    return dedupe(items)
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
    const entry = this.tokens.get(token)
    if (!entry) return { items: [], continuation: null }
    const next = (await entry.feed.getContinuation()) as Continuable
    this.tokens.delete(token)
    return {
      items: this.searchItems(
        entry.kind === 'search:music' ? this.musicItems(next) : (next as { results?: unknown[] }).results ?? [],
        entry.kind
      ),
      continuation: next.has_continuation
        ? this.tokens.set({ kind: entry.kind, feed: next })
        : null
    }
  }

  async suggestions(query: string): Promise<string[]> {
    const yt = await getClient()
    try {
      return await yt.getSearchSuggestions(query)
    } catch {
      return []
    }
  }
}
