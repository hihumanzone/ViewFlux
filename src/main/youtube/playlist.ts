import type { RemotePlaylist } from '../../shared/types'
import { getClient } from './client'
import { feedVideos } from './mappers'
import { absUrl, parseCompactCount, parseDurationText, pickThumbnail, text } from './parsers'
import type { TokenStore } from './tokens'
import type { Continuable, ThumbLike } from './types'

export class PlaylistService {
  constructor(private readonly tokens: TokenStore) {}

  async getRemotePlaylist(id: string): Promise<RemotePlaylist> {
    const yt = await getClient()

    if (id.startsWith('MPREb_')) {
      try {
        const album = await yt.music.getAlbum(id)
        const header = album.header as any
        const title = text(header?.title) || 'Album'
        const artist =
          text(header?.strapline_text_one?.text ?? header?.strapline_text_one) ||
          text(header?.author?.name ?? header?.author) ||
          text(header?.artists?.[0]?.name ?? header?.artists?.[0]) ||
          (Array.isArray(header?.subtitle?.runs)
            ? header.subtitle.runs.map((r: any) => text(r?.text ?? r)).filter((t: string) => t && t !== ' • ' && !/^\d{4}$/.test(t))[0]
            : text(header?.subtitle)) ||
          null

        const artistId =
          header?.strapline_text_one?.endpoint?.payload?.browseId ??
          header?.strapline_text_one?.endpoint?.browseEndpoint?.browseId ??
          header?.strapline_text_one?.runs?.[0]?.endpoint?.payload?.browseId ??
          header?.strapline_text_one?.runs?.[0]?.endpoint?.browseEndpoint?.browseId ??
          header?.author?.id ??
          header?.author?.channel_id ??
          header?.author?.endpoint?.payload?.browseId ??
          header?.artists?.[0]?.id ??
          header?.artists?.[0]?.channel_id ??
          header?.artists?.[0]?.endpoint?.payload?.browseId ??
          null

        const straplineThumbs =
          header?.strapline_thumbnail?.contents ??
          header?.strapline_thumbnail?.thumbnails ??
          header?.strapline_thumbnail ??
          header?.author?.thumbnails ??
          header?.artists?.[0]?.thumbnails
        const artistAvatar =
          pickThumbnail(Array.isArray(straplineThumbs) ? straplineThumbs : [straplineThumbs], 240) ||
          null

        const year = Array.isArray(header?.subtitle?.runs)
          ? header.subtitle.runs.find((r: any) => /^\d{4}$/.test(text(r?.text ?? r)))?.text ?? null
          : null
        const count = album.contents?.length ?? null
        const countText = count != null ? `${count} songs` : null
        const thumbs = header?.thumbnail?.contents ?? header?.thumbnail
        const thumbnail = pickThumbnail(Array.isArray(thumbs) ? thumbs : [thumbs], 480) || null

        const items = (album.contents ?? []).map((c: any) => {
          const trackArtistItem = (c.menu?.items as any[])?.find(
            (i) => i?.icon_type === 'ARTIST' || i?.text === 'Go to artist'
          )
          const trackArtistId =
            trackArtistItem?.endpoint?.payload?.browseId ??
            trackArtistItem?.endpoint?.browseEndpoint?.browseId ??
            c.author?.id ??
            c.author?.channel_id ??
            c.artists?.[0]?.id ??
            artistId

          const trackArtist =
            text(c.author?.name ?? c.author) ||
            text(c.artists?.[0]?.name ?? c.artists?.[0]) ||
            artist ||
            ''

          const artists = trackArtist
            ? [{ name: trackArtist, id: trackArtistId }]
            : undefined

          const itemThumb =
            pickThumbnail(c.thumbnail?.contents ?? c.thumbnails, 480) ||
            thumbnail ||
            ''

          return {
            videoId: c.id,
            title: text(c.title) || '',
            author: trackArtist,
            authorId: trackArtistId,
            authorAvatar: artistAvatar,
            duration: c.duration?.seconds ?? parseDurationText(c.duration?.text),
            thumbnail: itemThumb,
            viewCount: null,
            published: year,
            isLive: false,
            album: title,
            albumId: id,
            isMusicTrack: true,
            artists,
            thumbAspect: 'square' as const
          }
        })

        return {
          id,
          title,
          author: artist,
          authorId: artistId,
          authorAvatar: artistAvatar,
          count,
          countText,
          views: null,
          lastUpdated: year,
          description: text(header?.description) || null,
          thumbnail,
          items,
          continuation: null
        }
      } catch (err) {
        console.warn('[youtube] failed to fetch album via music API, falling back to standard playlist', err)
      }
    }

    const playlist = await yt.getPlaylist(id)
    const info = playlist.info ?? {}
    const feed = playlist as unknown as Continuable

    const authorObj = info.author as any
    const playlistAuthor =
      authorObj?.name ??
      (info.subtitle ? text(info.subtitle).split('•')[0]?.trim() : null) ??
      null

    const playlistAuthorId =
      authorObj?.id ??
      authorObj?.channel_id ??
      authorObj?.endpoint?.payload?.browseId ??
      null

    const playlistAuthorAvatar =
      pickThumbnail(authorObj?.thumbnails, 240) ||
      absUrl(authorObj?.avatar_thumbnail_url) ||
      null

    const items = feedVideos(playlist)

    const effectiveAuthor = playlistAuthor || items[0]?.author || null
    const effectiveAuthorId = playlistAuthorId || items[0]?.authorId || null
    const effectiveAuthorAvatar = playlistAuthorAvatar || items[0]?.authorAvatar || null

    const countText = text(info.total_items) || null
    const infoThumbs = (info.thumbnails ?? []) as ThumbLike[]
    return {
      id,
      title: text(info.title) || 'Playlist',
      author: effectiveAuthor,
      authorId: effectiveAuthorId,
      authorAvatar: effectiveAuthorAvatar,
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
