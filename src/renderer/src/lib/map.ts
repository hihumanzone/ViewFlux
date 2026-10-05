import type { PlaylistVideo } from '../../../shared/types'

/**
 * Widens a video listing shape into a `PlaylistVideo` for saving.
 *
 * Accepts any object carrying the four required fields, so `VideoSummary`
 * (search results), `HistoryEntry` and an already-saved `PlaylistVideo` can all
 * go straight to the add-to-playlist dialog with no per-call-site conversion.
 */
export function toPlaylistVideo(
  video: Pick<PlaylistVideo, 'videoId' | 'title' | 'author' | 'thumbnail'> &
    Partial<Omit<PlaylistVideo, 'videoId' | 'title' | 'author' | 'thumbnail'>>
): PlaylistVideo {
  return {
    videoId: video.videoId,
    title: video.title,
    author: video.author,
    authorId: video.authorId ?? null,
    authorAvatar: video.authorAvatar ?? null,
    viewCount: video.viewCount ?? null,
    published: video.published ?? null,
    publishTimestamp: video.publishTimestamp ?? null,
    isPremiere: video.isPremiere ?? false,
    isStreamed: video.isStreamed ?? false,
    isLive: video.isLive ?? false,
    thumbnail: video.thumbnail,
    duration: video.duration ?? null,
    // Preserve the original ordering when re-saving something already saved.
    addedAt: video.addedAt ?? Date.now()
  }
}
