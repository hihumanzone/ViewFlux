import { memo } from 'react'
import { Icon } from './Icons'
import { VideoOptions } from './VideoOptions'
import { ArtistLinks } from './ArtistLinks'
import { navigate } from '../lib/router'
import { formatCount, formatDuration, formatVideoPublished, safeText } from '../lib/format'
import { useChannelAvatar } from '../lib/useChannelAvatar'
import { useBrokenImage } from '../lib/useBrokenImage'
import { activationProps } from '../lib/keyboard'
import { useApp } from '../state/AppContext'
import type { VideoSummary } from '../../../shared/types'

export const VideoCard = memo(function VideoCard({
  video,
  progress,
  to
}: {
  video: VideoSummary
  /** 0-1 playback progress for history cards. If omitted, looked up from watch history. */
  progress?: number
  /** Destination route or URL. If omitted, defaults to `#/watch/${video.videoId}` */
  to?: string
}): React.JSX.Element {
  const { getHistoryProgress } = useApp()
  // Music results carry the channel id but no picture, so resolve it lazily.
  const avatar = useChannelAvatar(video.authorId ?? null, video.authorAvatar)
  const { broken: avatarBroken, onError: onAvatarError } = useBrokenImage(avatar)
  const open = (): void => navigate(to ?? `#/watch/${video.videoId}`)

  const effectiveProgress =
    progress != null && progress > 0
      ? progress
      : getHistoryProgress(video.videoId, video.duration)

  const isEndedPremiere =
    Boolean(video.isPremiere) && !video.isLive && video.duration != null && video.duration > 0

  const isSquare =
    video.thumbAspect === 'square' ||
    (video.isMusicTrack && video.thumbAspect !== 'wide')

  const title = safeText(video.title)
  const author = safeText(video.author)
  const album = safeText(video.album)

  return (
    <article
      className={`video-card${video.isMusicTrack ? ' video-card--music' : ''}${isSquare ? ' video-card--thumb-square' : ''}`}
      onClick={open}
      {...activationProps(open)}
    >
      <div className="video-card__thumb-wrap">
        <img className="video-card__thumb" src={video.thumbnail} alt="" loading="lazy" />
        {isEndedPremiere && (
          <div className="video-card__top-badge">
            <span className="badge badge--premiere">Premiere</span>
          </div>
        )}
        <div
          className={
            effectiveProgress > 0
              ? 'video-card__badges video-card__badges--raised'
              : 'video-card__badges'
          }
        >
          {video.isLive ? (
            <span className="badge badge--live">Live</span>
          ) : isEndedPremiere ? (
            <span className="badge">{formatDuration(video.duration!)}</span>
          ) : video.isPremiere ? (
            <span className="badge badge--premiere">Premiere</span>
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
            <h3 className="video-card__title">{title}</h3>
            <VideoOptions video={video} className="video-card__menu" />
          </div>
          <div className="video-card__meta">
            {author && (
              <div className="video-card__author-row">
                {video.artists && video.artists.length > 1 ? (
                  <>
                    <button
                      type="button"
                      className="video-card__author-avatar-btn"
                      title={video.authorId ? `Open ${author}` : `Search for ${author}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (video.authorId) {
                          navigate(`#/channel/${video.authorId}`)
                        } else if (author) {
                          navigate(`#/search?q=${encodeURIComponent(author)}&f=channels`)
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
                      ) : video.isMusicTrack ? (
                        <span className="video-card__author-avatar video-card__author-avatar--fallback">
                          <Icon name="music_note" size={13} />
                        </span>
                      ) : (
                        <span className="video-card__author-avatar video-card__author-avatar--fallback">
                          {author.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </button>
                    <ArtistLinks
                      artists={video.artists}
                      author={author}
                      authorId={video.authorId}
                      className="video-card__author-name"
                    />
                  </>
                ) : (
                  <button
                    type="button"
                    className="video-card__author-btn"
                    title={video.authorId ? `Open ${author}` : `Search for ${author}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (video.authorId) {
                        navigate(`#/channel/${video.authorId}`)
                      } else if (author) {
                        navigate(`#/search?q=${encodeURIComponent(author)}&f=channels`)
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
                    ) : video.isMusicTrack ? (
                      <span className="video-card__author-avatar video-card__author-avatar--fallback">
                        <Icon name="music_note" size={13} />
                      </span>
                    ) : (
                      <span className="video-card__author-avatar video-card__author-avatar--fallback">
                        {author.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="video-card__author-name">{author}</span>
                  </button>
                )}
              </div>
            )}
            {album && <span className="video-card__album">{album}</span>}
            {video.viewCount != null && <span>{formatCount(video.viewCount)} views</span>}
            {!video.isMusicTrack && formatVideoPublished(video) && <span>{formatVideoPublished(video)}</span>}
          </div>
        </div>
      </div>
    </article>
  )
})
