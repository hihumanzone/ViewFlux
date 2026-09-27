import { navigate } from '../lib/router'
import { useChannelAvatar } from '../lib/useChannelAvatar'
import { useBrokenImage } from '../lib/useBrokenImage'

interface ChannelLineProps {
  name: string
  /** Channel id when known. Without it the name falls back to a channel search. */
  channelId: string | null
  avatar: string | null
  /** Extra classes on the wrapper so other layouts can reuse the row. */
  className?: string
}

/**
 * Channel row shared by every video list that has one (History, playlist rows,
 * playlist cards): a round avatar with an initials fallback plus a clickable
 * channel name. Clicks stop at this row so whatever surrounds it can still
 * open the video or playlist.
 */
export function ChannelLine({
  name,
  channelId,
  avatar,
  className
}: ChannelLineProps): React.JSX.Element | null {
  // Playlist and music results carry the channel id but no picture at all, so
  // the picture is resolved lazily from the channel page.
  const resolved = useChannelAvatar(channelId, avatar)
  // A dead URL must not stick: a later, better picture should still be used.
  const { broken, onError } = useBrokenImage(resolved)
  if (!name) return null

  const openChannel = (event: React.MouseEvent): void => {
    event.stopPropagation()
    navigate(
      channelId
        ? `#/channel/${channelId}`
        : `#/search?q=${encodeURIComponent(name)}&f=channels`
    )
  }

  return (
    <div className={['list-row__channel', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="list-row__channel-btn"
        title={channelId ? `Open ${name}` : `Search for ${name}`}
        onClick={openChannel}
      >
        {resolved && !broken ? (
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
            {name.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="list-row__channel-name">{name}</span>
      </button>
    </div>
  )
}
