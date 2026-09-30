import type { RemotePlaylist } from '../../shared/types'
import { getClient } from './client'
import { feedVideos } from './mappers'
import { parseCompactCount, pickThumbnail, text } from './parsers'
import type { TokenStore } from './tokens'
import type { Continuable, ThumbLike } from './types'

export class PlaylistService {
  constructor(private readonly tokens: TokenStore) {}

  async getRemotePlaylist(id: string): Promise<RemotePlaylist> {
    const yt = await getClient()
    const playlist = await yt.getPlaylist(id)
    const info = playlist.info ?? {}
    const feed = playlist as unknown as Continuable
    const items = feedVideos(playlist)
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
      thumbnail: pickThumbnail(infoThumbs, 480) || items[0]?.thumbnail || null,
      items,
      continuation: feed.has_continuation
        ? this.tokens.set({ kind: 'remote:playlist', feed })
        : null
    }
  }

  async remotePlaylistMore(token: string): Promise<RemotePlaylist> {
    const entry = this.tokens.get(token)
    if (!entry) return this.emptyRemotePlaylist()
    const next = (await entry.feed.getContinuation()) as Continuable
    this.tokens.delete(token)
    return {
      ...this.emptyRemotePlaylist(),
      items: feedVideos(next),
      continuation: next.has_continuation
        ? this.tokens.set({ kind: 'remote:playlist', feed: next })
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
}
