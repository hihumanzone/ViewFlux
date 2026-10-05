import type { HistoryEntry, PlaylistVideo, VideoSummary } from '../../../shared/types'

/**
 * Enriches a video summary (or playlist video) with watch history metadata if available.
 *
 * When a video is watched, full authoritative metadata (such as exact stream/premiere
 * relative date, premiere/streamed status, and publish timestamp) is captured on the watch page.
 * Merging with history ensures that this rich metadata is consistently visible across all listings
 * (search results, playlists, channel uploads, etc.).
 */
export function enrichVideoWithHistory(
  video: VideoSummary | PlaylistVideo,
  history: readonly HistoryEntry[] | undefined | null
): VideoSummary {
  const base: VideoSummary = {
    videoId: video.videoId,
    title: video.title,
    author: video.author,
    authorId: video.authorId ?? null,
    authorAvatar: video.authorAvatar ?? null,
    duration: video.duration ?? null,
    thumbnail: video.thumbnail,
    viewCount: video.viewCount ?? null,
    published: video.published ?? null,
    publishTimestamp: video.publishTimestamp ?? null,
    isPremiere: video.isPremiere,
    isStreamed: video.isStreamed,
    isLive: Boolean(video.isLive)
  }

  if (!history || history.length === 0) return base
  const hist = history.find((h) => h.videoId === video.videoId)
  if (!hist) return base

  const histIsPrem = Boolean(hist.isPremiere || /premiere/i.test(hist.published ?? ''))
  const histIsStream = Boolean(hist.isStreamed || /streamed/i.test(hist.published ?? ''))

  // If history has a stream/premiere-specific published string, prioritize it over a plain date
  const useHistPublished = Boolean(
    hist.published && (histIsPrem || histIsStream || !video.published)
  )

  return {
    ...base,
    viewCount: base.viewCount ?? hist.viewCount ?? null,
    published: useHistPublished
      ? (hist.published ?? base.published)
      : (base.published ?? hist.published ?? null),
    publishTimestamp: base.publishTimestamp ?? hist.publishTimestamp ?? null,
    isPremiere: Boolean(base.isPremiere || histIsPrem),
    isStreamed: Boolean(base.isStreamed || histIsStream),
    isLive: Boolean(base.isLive || hist.isLive),
    authorAvatar: base.authorAvatar ?? hist.authorAvatar ?? null,
    authorId: base.authorId ?? hist.authorId ?? null
  }
}
