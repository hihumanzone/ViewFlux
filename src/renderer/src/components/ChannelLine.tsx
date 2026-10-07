import { memo } from 'react'
import { navigate } from '../lib/router'
import { useChannelAvatar } from '../lib/useChannelAvatar'
import { useBrokenImage } from '../lib/useBrokenImage'
import { safeText } from '../lib/format'
import { ArtistLinks } from './ArtistLinks'
import type { ArtistRef } from '../../../shared/types'

export interface ChannelLineProps {
  name: string
  /** Channel id when known. Without it the name falls back to a channel search. */
  channelId: string | null
  avatar: string | null
  /** Structured artist refs when multiple artists or music specific IDs are known. */
  artists?: ArtistRef[]
  /** Extra classes on the wrapper so other layouts can reuse the row. */
  className?: string
}

/**
 * Channel row shared by video lists and playlist cards: a round avatar
 * plus clickable channel/artist name(s). Clicks stop at this row so whatever surrounds
 * it can still open the video or playlist.
 */
export const ChannelLine = memo(function ChannelLine({
  name,
  channelId,
  avatar,
  artists,
  className
}: ChannelLineProps): React.JSX.Element | null {
  const displayName = safeText(name)
  // Playlist and music results carry the channel id but no picture at all, so
  // the picture is resolved lazily from the channel page.
  const resolved = useChannelAvatar(channelId, avatar)
  // A dead URL must not stick: a later, better picture should still be used.
  const { broken, onError } = useBrokenImage(resolved)
  if (!displayName) return null

  const openChannel = (event: React.MouseEvent): void => {
    event.stopPropagation()
    navigate(
      channelId
        ? `#/channel/${channelId}`
        : `#/search?q=${encodeURIComponent(displayName)}&f=channels`
    )
  }

  const hasMultipleArtists = Boolean(artists && artists.length > 1)

  const avatarNode =
    resolved && !broken ? (
      <img
        className="list-row__channel-avatar"
        src={resolved}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={onError}
      />
    ) : (
      <span className="list-row__channel-avatar list-row__channel-avatar--fallback" aria-hidden>
        {displayName.charAt(0).toUpperCase()}
      </span>
    )

  if (!hasMultipleArtists) {
    return (
      <div className={['list-row__channel', className].filter(Boolean).join(' ')}>
        <button
          type="button"
          className="list-row__channel-btn"
          title={channelId ? `Open ${displayName}` : `Search for ${displayName}`}
          onClick={openChannel}
        >
          {avatarNode}
          <span className="list-row__channel-name">{displayName}</span>
        </button>
      </div>
    )
  }

  return (
    <div className={['list-row__channel', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="list-row__channel-avatar-btn"
        title={channelId ? `Open ${displayName}` : `Search for ${displayName}`}
        onClick={openChannel}
      >
        {avatarNode}
      </button>
      <ArtistLinks
        artists={artists}
        author={displayName}
        authorId={channelId}
        className="list-row__channel-name"
      />
    </div>
  )
})
