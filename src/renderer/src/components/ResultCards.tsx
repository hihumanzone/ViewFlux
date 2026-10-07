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

/** Safely stringifies any string, number, or InnerTube Text object to prevent React child crash. */
function safeString(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'object') {
    const v = value as any
    if (typeof v.text === 'string') return v.text
    if (v.text && typeof v.text === 'object') return safeString(v.text)
    if (Array.isArray(v.runs)) {
      return v.runs.map((r: any) => (typeof r === 'object' ? r?.text ?? '' : String(r))).join('')
    }
    if (typeof v.simpleText === 'string') return v.simpleText
    if (typeof v.toString === 'function') {
      const s = v.toString()
      if (typeof s === 'string' && s && s !== '[object Object]') return s
    }
  }
  return ''
}

/** Compact channel card used in search results. */
export const ChannelCard = memo(function ChannelCard({
  channel,
  viewMode = 'grid'
}: {
  channel: ChannelSummary
  viewMode?: 'grid' | 'list'
}): React.JSX.Element {
  const { isChannelSaved } = useApp()
  const avatar = useChannelAvatar(channel.id, channel.avatar)
  const { broken: avatarBroken, onError: onAvatarError } = useBrokenImage(avatar)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [bookmarkOpen, setBookmarkOpen] = useState(false)
  const copyLink = useCopyLink()
  const open = (): void => navigate(`#/channel/${channel.id}`)

  const channelName = safeString(channel.name) || 'Channel'
  const channelHandle = safeString(channel.handle)
  const channelSubscribers = safeString(channel.subscribers)
  const channelVideoCount = safeString(channel.videoCount)
  const channelDescription = safeString(channel.description)

  // The dialog doubles as the editor once the channel is bookmarked, so the
  // menu label has to track the same state the channel page does.
  const isSaved = isChannelSaved(channel.id)
  const isList = viewMode === 'list'

  const actions = (
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
      <OverflowButton
        label={`${channelName} options`}
        className="channel-card__menu"
        onToggle={(trigger) => setMenuAnchor((anchor) => (anchor ? null : trigger))}
      />
    </div>
  )

  return (
    <article
      className={`channel-card${isList ? ' channel-card--list' : ' channel-card--grid'}`}
      onClick={open}
      {...activationProps(open)}
    >
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
            {channelName.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <div className="channel-card__body">
        <h3 className="channel-card__name">
          <span className="channel-card__name-text">{channelName}</span>
          {channel.isMusic && <MusicBadge />}
        </h3>
        <div className="channel-card__meta">
          {channelHandle && <span>{channelHandle}</span>}
          {channelSubscribers && <span>{channelSubscribers}</span>}
          {channelVideoCount && <span>{channelVideoCount}</span>}
        </div>
        {channelDescription && (
          <p className="channel-card__description">{channelDescription}</p>
        )}
        {!isList && actions}
      </div>
      {isList && actions}
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
          title={channelName}
          handle={channelHandle || null}
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
  const title = safeString(playlist.title) || 'Playlist'
  const author = safeString(playlist.author)
  const year = safeString(playlist.year)
  const rawCount = safeString(playlist.countText)
  const isDuplicateAlbumCount =
    playlist.isAlbum &&
    (!rawCount ||
      /^(album|ep|single|release|playlist)$/i.test(rawCount.trim()) ||
      rawCount.trim().toLowerCase() === title.trim().toLowerCase())
  const countLabel =
    isDuplicateAlbumCount
      ? ''
      : (rawCount ||
        (playlist.count != null
          ? `${playlist.count} ${playlist.isAlbum ? 'songs' : 'videos'}`
          : ''))

  const isSquare = playlist.thumbAspect === 'square' || playlist.isAlbum

  return (
    <article
      className={`pl-card${playlist.isAlbum ? ' pl-card--album' : ''}${isSquare ? ' pl-card--thumb-square' : ''}`}
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
        {countLabel && (
          <span className="pl-card__count-badge">
            <Icon name={playlist.isAlbum ? 'album' : 'playlist'} size={13} />
            <span>{countLabel}</span>
          </span>
        )}
      </div>
      <div className="pl-card__body">
        <div className="pl-card__title-row">
          <h3 className="pl-card__title">{title}</h3>
          <OverflowButton
            label={`${title} options`}
            className="pl-card__menu"
            onToggle={(trigger) => setMenuAnchor((anchor) => (anchor ? null : trigger))}
          />
        </div>
        <div className="pl-card__meta">
          {author ? (
            <ChannelLine
              className="pl-card__author"
              name={author}
              channelId={playlist.authorId ?? null}
              avatar={playlist.authorAvatar ?? null}
              artists={playlist.artists}
            />
          ) : (
            <span>{playlist.isAlbum ? 'Music release' : 'YouTube playlist'}</span>
          )}
          {year && (
            <>
              <span className="pl-card__meta-sep" aria-hidden="true">•</span>
              <span className="pl-card__year">{year}</span>
            </>
          )}
          {countLabel && (
            <span className="pl-card__meta-count">
              <span className="pl-card__meta-sep" aria-hidden="true">•</span>
              <span>{countLabel}</span>
            </span>
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
