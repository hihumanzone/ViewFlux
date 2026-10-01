import { memo, useState } from 'react'
import { Icon, MusicBadge } from './Icons'
import { Menu, MenuItem } from './Menu'
import { ChannelLine } from './ChannelLine'
import { BookmarkChannelDialog } from './BookmarkChannelDialog'
import { OverflowButton } from './OverflowButton'
import { useApp } from '../state/AppContext'
import { navigate } from '../lib/router'
import { channelUrl, playlistUrl, useCopyLink } from '../lib/copyLink'
import { useChannelAvatar } from '../lib/useChannelAvatar'
import { useBrokenImage } from '../lib/useBrokenImage'
import { activationProps } from '../lib/keyboard'
import type { ChannelSummary, PlaylistSummary } from '../../../shared/types'

/** Compact channel card used in search results. */
export const ChannelCard = memo(function ChannelCard({ channel }: { channel: ChannelSummary }): React.JSX.Element {
  const { isChannelSaved } = useApp()
  const avatar = useChannelAvatar(channel.id, channel.avatar)
  const { broken: avatarBroken, onError: onAvatarError } = useBrokenImage(avatar)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [bookmarkOpen, setBookmarkOpen] = useState(false)
  const copyLink = useCopyLink()
  const open = (): void => navigate(`#/channel/${channel.id}`)
  // The dialog doubles as the editor once the channel is bookmarked, so the
  // menu label has to track the same state the channel page does.
  const isSaved = isChannelSaved(channel.id)

  return (
    <article className="channel-card" onClick={open} {...activationProps(open)}>
      <div className="channel-card__avatar-wrap">
        {avatar && !avatarBroken ? (
          <img
            className="channel-card__avatar"
            src={avatar}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={onAvatarError}
          />
        ) : (
          <div className="channel-card__avatar channel-card__avatar--fallback">
            {channel.name.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <div className="channel-card__body">
        <h3 className="channel-card__name">
          <span className="channel-card__name-text">{channel.name}</span>
          {channel.isMusic && <MusicBadge />}
        </h3>
        <div className="channel-card__meta">
          {channel.handle && <span>{channel.handle}</span>}
          {channel.subscribers && <span>{channel.subscribers}</span>}
          {channel.videoCount && <span>{channel.videoCount}</span>}
        </div>
        {channel.description && (
          <p className="channel-card__description">{channel.description}</p>
        )}
        <div className="channel-card__actions">
          <button
            type="button"
            className="btn btn--tonal btn--sm channel-card__open"
            onClick={(event) => {
              event.stopPropagation()
              open()
            }}
          >
            View channel
          </button>
          {/* The overflow trigger sits immediately beside the primary action —
              the same spot the channel page uses — instead of floating in the
              card's top-right corner. */}
          <OverflowButton
            label={`${channel.name} options`}
            className="channel-card__menu"
            onToggle={(trigger) => setMenuAnchor((anchor) => (anchor ? null : trigger))}
          />
        </div>
      </div>
      <Menu
        anchor={menuAnchor}
        open={menuAnchor != null}
        onClose={() => setMenuAnchor(null)}
        align="end"
      >
        <MenuItem
          icon={isSaved ? 'bookmarkFilled' : 'bookmark'}
          label={isSaved ? 'Edit bookmark' : 'Bookmark channel'}
          onSelect={() => {
            setMenuAnchor(null)
            setBookmarkOpen(true)
          }}
        />
        <MenuItem
          icon="link"
          label="Copy link"
          onSelect={() => {
            setMenuAnchor(null)
            copyLink(channelUrl(channel.id))
          }}
        />
      </Menu>
      {bookmarkOpen && (
        <BookmarkChannelDialog
          channelId={channel.id}
          title={channel.name}
          handle={channel.handle}
          avatar={avatar}
          onClose={() => setBookmarkOpen(false)}
        />
      )}
    </article>
  )
})

/** YouTube playlist card used in search results and channel playlists. */
export const PlaylistCard = memo(function PlaylistCard({
  playlist,
  onSave,
  onRemove,
  saved
}: {
  playlist: PlaylistSummary
  /** Called when the user picks "Save to playlists". */
  onSave?: (playlist: PlaylistSummary) => void
  /** Called when the user picks "Remove from playlists". */
  onRemove?: (playlist: PlaylistSummary) => void
  /** Already stored in the user's playlists, so the menu offers removal. */
  saved?: boolean
}): React.JSX.Element {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const copyLink = useCopyLink()
  const open = (): void => navigate(`#/ytpl/${playlist.id}`)
  // Prefer removal once it is saved, so the menu never lies about the state.
  const canRemove = Boolean(saved && onRemove)
  // A music release is still a YouTube playlist under the hood, so it reuses
  // this card and the existing playlist route — only its labels differ.
  const countLabel =
    playlist.countText ??
    (playlist.count != null
      ? `${playlist.count} ${playlist.isAlbum ? 'songs' : 'videos'}`
      : '')

  return (
    <article
      className={`pl-card${playlist.isAlbum ? ' pl-card--album' : ''}`}
      onClick={open}
      {...activationProps(open)}
    >
      <div className="pl-card__thumb-wrap">
        {playlist.thumbnail ? (
          <img className="pl-card__thumb" src={playlist.thumbnail} alt="" loading="lazy" />
        ) : (
          <div className="pl-card__thumb pl-card__thumb--fallback">
            <Icon name={playlist.isAlbum ? 'album' : 'playlist'} size={26} />
          </div>
        )}
        <span className="pl-card__type">
          <Icon name={playlist.isAlbum ? 'album' : 'playlist'} size={14} />
          {playlist.isAlbum ? 'Album' : 'Playlist'}
        </span>
        <div className="pl-card__overlay">
          <Icon name={playlist.isAlbum ? 'album' : 'playlist'} size={18} />
          <span>{countLabel}</span>
        </div>
      </div>
      <div className="pl-card__body">
        <div className="pl-card__title-row">
          <h3 className="pl-card__title">{playlist.title}</h3>
          <OverflowButton
            label={`${playlist.title} options`}
            className="pl-card__menu"
            onToggle={(trigger) => setMenuAnchor((anchor) => (anchor ? null : trigger))}
          />
        </div>
        <div className="pl-card__meta">
          {playlist.author ? (
            <ChannelLine
              className="pl-card__author"
              name={playlist.author}
              channelId={playlist.authorId ?? null}
              avatar={playlist.authorAvatar ?? null}
            />
          ) : (
            <span>{playlist.isAlbum ? 'Music release' : 'YouTube playlist'}</span>
          )}
          {playlist.year && (
            <>
              <span className="pl-card__meta-sep" aria-hidden="true">•</span>
              <span className="pl-card__year">{playlist.year}</span>
            </>
          )}
        </div>
      </div>
      <Menu
        anchor={menuAnchor}
        open={menuAnchor != null}
        onClose={() => setMenuAnchor(null)}
        align="end"
      >
        <MenuItem
          icon="queue"
          label={playlist.isAlbum ? 'Open album' : 'Open playlist'}
          onSelect={() => {
            setMenuAnchor(null)
            open()
          }}
        />
        <MenuItem
          icon="link"
          label="Copy link"
          onSelect={() => {
            setMenuAnchor(null)
            copyLink(playlistUrl(playlist.id))
          }}
        />
        {canRemove ? (
          <MenuItem
            icon="delete"
            label="Remove from playlists"
            danger
            onSelect={() => {
              setMenuAnchor(null)
              onRemove?.(playlist)
            }}
          />
        ) : (
          onSave && (
            <MenuItem
              icon="bookmark"
              label="Save to playlists"
              onSelect={() => {
                setMenuAnchor(null)
                onSave(playlist)
              }}
            />
          )
        )}
      </Menu>
    </article>
  )
})
