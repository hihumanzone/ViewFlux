import { memo } from 'react'
import { VideoOptions } from './VideoOptions'
import { navigate } from '../lib/router'
import { formatCount, formatDuration } from '../lib/format'
import { useChannelAvatar } from '../lib/useChannelAvatar'
import { useBrokenImage } from '../lib/useBrokenImage'
import { activationProps } from '../lib/keyboard'
import { useApp } from '../state/AppContext'
import type { VideoSummary } from '../../../shared/types'

export const VideoCard = memo(function VideoCard({
  video,
  progress
}: {
  video: VideoSummary
  /** 0-1 playback progress for history cards. If omitted, looked up from watch history. */
  progress?: number
}): React.JSX.Element {
  const { getHistoryProgress } = useApp()
  // Music results carry the channel id but no picture, so resolve it lazily.
  const avatar = useChannelAvatar(video.authorId ?? null, video.authorAvatar)
  const { broken: avatarBroken, onError: onAvatarError } = useBrokenImage(avatar)
  const open = (): void => navigate(`#/watch/${video.videoId}`)

  const effectiveProgress =
    progress != null && progress > 0
      ? progress
      : getHistoryProgress(video.videoId, video.duration)

  return (
    <article
      className="video-card"
      // The whole tile is the click target, but a bare onClick on a non-
      // interactive element is unreachable by keyboard. The role plus key
      // handling makes the grid tab-navigable without nesting a button inside
      // the author button below.
      onClick={open}
      {...activationProps(open)}
    >
      <div className="video-card__thumb-wrap">
        <img className="video-card__thumb" src={video.thumbnail} alt="" loading="lazy" />
        <div
          className={
            effectiveProgress > 0
              ? 'video-card__badges video-card__badges--raised'
              : 'video-card__badges'
          }
        >
          {video.isLive ? (
            <span className="badge badge--live">Live</span>
          ) : (
            video.duration != null &&
            video.duration > 0 && <span className="badge">{formatDuration(video.duration)}</span>
          )}
        </div>
        {effectiveProgress > 0 && (
          <div
            className="video-card__progress"
            title={`Watched ${Math.round(effectiveProgress * 100)}%`}
          >
            <i style={{ width: `${Math.min(100, effectiveProgress * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="video-card__body">
        <div className="video-card__text">
          <div className="video-card__title-row">
            <h3 className="video-card__title">{video.title}</h3>
            <VideoOptions video={video} className="video-card__menu" />
          </div>
          <div className="video-card__meta">
            {video.author && (
              <button
                type="button"
                className="video-card__author"
                onClick={(event) => {
                  event.stopPropagation()
                  if (video.authorId) {
                    navigate(`#/channel/${video.authorId}`)
                  } else if (video.author) {
                    navigate(`#/search?q=${encodeURIComponent(video.author)}&f=channels`)
                  }
                }}
              >
                {avatar && !avatarBroken ? (
                  <img
                    className="video-card__author-avatar"
                    src={avatar}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={onAvatarError}
                  />
                ) : (
                  <span className="video-card__author-avatar video-card__author-avatar--fallback">
                    {video.author.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="video-card__author-name">{video.author}</span>
              </button>
            )}
            {video.viewCount != null && <span>{formatCount(video.viewCount)} views</span>}
            {video.published && <span>{video.published}</span>}
          </div>
        </div>
      </div>
    </article>
  )
})
