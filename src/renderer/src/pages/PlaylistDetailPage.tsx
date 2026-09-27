import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icons'
import { ChannelLine } from '../components/ChannelLine'
import { EmptyState, Loader } from '../components/EmptyState'
import { ListRow } from '../components/ListRow'
import { Menu, MenuItem } from '../components/Menu'
import { VideoOptions } from '../components/VideoOptions'
import { navigate } from '../lib/router'
import { formatCount } from '../lib/format'
import { toPlaylistVideo } from '../lib/map'
import { useCopyLink, playlistUrl } from '../lib/copyLink'
import { useRemotePlaylist } from '../lib/useRemotePlaylist'
import { useApp } from '../state/AppContext'
import type { Playlist, VideoSummary } from '../../../shared/types'

/** Views · age stats shown under the channel line of a playlist row. */
function RowStats({
  viewCount,
  published
}: {
  viewCount: number | null
  published: string | null
}): React.JSX.Element | null {
  const stats = [
    viewCount != null ? `${formatCount(viewCount)} views` : null,
    published
  ].filter(Boolean)
  if (stats.length === 0) return null
  return <div className="list-row__stats">{stats.join(' · ')}</div>
}

export function PlaylistDetailPage({ id }: { id: string }): React.JSX.Element {
  const { playlists } = useApp()
  const [playlist, setPlaylist] = useState<Playlist | null | undefined>(undefined)

  useEffect(() => {
    setPlaylist(playlists.find((p) => p.id === id) ?? null)
  }, [playlists, id])

  if (playlist === undefined) {
    return (
      <div className="page">
        <Loader />
      </div>
    )
  }

  if (playlist === null) {
    return (
      <div className="page">
        <EmptyState
          icon="bookmark"
          title="Playlist not found"
          action={
            <button className="btn btn--tonal" onClick={() => navigate('#/playlists')}>
              Back to playlists
            </button>
          }
        />
      </div>
    )
  }

  if (playlist.kind === 'youtube' && playlist.youtubeId) {
    return <SavedYouTubePlaylist playlist={playlist} />
  }

  return <LocalPlaylist playlist={playlist} />
}

/** Bookmarks stored on this device: full reordering and removal. */
function LocalPlaylist({ playlist }: { playlist: Playlist }): React.JSX.Element {
  const { refreshPlaylists, confirm, toast } = useApp()
  const [current, setCurrent] = useState(playlist)

  useEffect(() => {
    setCurrent(playlist)
  }, [playlist])

  const playAll = (): void => {
    const first = current.videos[0]
    if (first) navigate(`#/watch/${first.videoId}?list=${current.id}`)
  }

  const removeItem = async (videoId: string): Promise<void> => {
    setCurrent(await window.api.removeFromPlaylist(current.id, videoId))
    await refreshPlaylists()
  }

  const move = async (from: number, to: number): Promise<void> => {
    if (to < 0 || to >= current.videos.length) return
    setCurrent(await window.api.movePlaylistItem(current.id, from, to))
    await refreshPlaylists()
  }

  const removePlaylist = async (): Promise<void> => {
    const ok = await confirm(`Delete the playlist “${current.name}”?`, {
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    await window.api.deletePlaylist(current.id)
    await refreshPlaylists()
    toast('Playlist deleted')
    navigate('#/playlists')
  }

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">{current.name}</h1>
          <p className="page__subtitle">
            {current.videos.length} {current.videos.length === 1 ? 'video' : 'videos'} · local
            playlist
          </p>
        </div>
        <div className="page__actions">
          <button
            className="btn btn--filled"
            disabled={current.videos.length === 0}
            onClick={playAll}
          >
            <Icon name="play_arrow" size={18} />
            Play all
          </button>
          <button
            className="icon-btn"
            aria-label="Delete playlist"
            onClick={() => void removePlaylist()}
          >
            <Icon name="delete" size={20} />
          </button>
        </div>
      </div>

      {current.videos.length === 0 ? (
        <EmptyState
          icon="bookmark"
          title="This playlist is empty"
          message="Use the save option on any video to add it here."
        />
      ) : (
        <ul className="list">
          {current.videos.map((video, index) => (
            <ListRow
              key={`${video.videoId}-${index}`}
              to={`#/watch/${video.videoId}?list=${current.id}`}
              thumbnail={video.thumbnail}
              title={video.title}
              duration={video.duration}
              actions={
                <>
                  <VideoOptions video={video} label="Video options" />
                  <button
                    className="icon-btn icon-btn--sm"
                    aria-label={`Move “${video.title}” up`}
                    disabled={index === 0}
                    onClick={() => void move(index, index - 1)}
                  >
                    <Icon name="up" size={18} />
                  </button>
                  <button
                    className="icon-btn icon-btn--sm"
                    aria-label={`Move “${video.title}” down`}
                    disabled={index === current.videos.length - 1}
                    onClick={() => void move(index, index + 1)}
                  >
                    <Icon name="down" size={18} />
                  </button>
                  <button
                    className="icon-btn icon-btn--sm"
                    aria-label={`Remove “${video.title}” from this playlist`}
                    onClick={() => void removeItem(video.videoId)}
                  >
                    <Icon name="close" size={18} />
                  </button>
                </>
              }
            >
              <ChannelLine
                name={video.author}
                channelId={video.authorId ?? null}
                avatar={video.authorAvatar ?? null}
              />
              <RowStats
                viewCount={video.viewCount ?? null}
                published={video.published ?? null}
              />
            </ListRow>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * A saved reference to a real YouTube playlist. Contents are always fetched
 * live from YouTube, so the list never goes stale; only the reference itself
 * is stored locally (YouTube itself cannot be edited without signing in).
 */
function SavedYouTubePlaylist({ playlist }: { playlist: Playlist }): React.JSX.Element {
  const { refreshPlaylists, confirm, toast, touchYoutubePlaylist } = useApp()
  const copyLink = useCopyLink()
  const { playlist: remote, items, loading, loadingMore, error, loadMore, reload } =
    useRemotePlaylist(playlist.youtubeId ?? null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [busy, setBusy] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { rootMargin: '600px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMore])

  const playAll = (): void => {
    const first = items[0]
    if (first) navigate(`#/watch/${first.videoId}?list=yt:${playlist.youtubeId}`)
  }

  const sync = (): void => {
    setMenuAnchor(null)
    reload()
    if (remote) {
      touchYoutubePlaylist({
        ...playlist,
        name: remote.title,
        countText: remote.countText,
        thumbnail: remote.thumbnail
      })
    }
    toast('Synced with YouTube')
  }

  const saveCopy = async (): Promise<void> => {
    setMenuAnchor(null)
    if (items.length === 0 || busy) return
    setBusy(true)
    try {
      const created = await window.api.createPlaylist(`${playlist.name} (copy)`)
      for (const video of items) {
        await window.api.addToPlaylist(created.id, toPlaylistVideo(video))
      }
      await refreshPlaylists()
      toast(`Saved ${items.length} videos as “${created.name}”`)
    } finally {
      setBusy(false)
    }
  }

  const removeReference = async (): Promise<void> => {
    setMenuAnchor(null)
    const ok = await confirm(
      `Remove “${playlist.name}” from your playlists? The playlist stays on YouTube.`,
      { confirmLabel: 'Remove', danger: true }
    )
    if (!ok) return
    await window.api.deletePlaylist(playlist.id)
    await refreshPlaylists()
    navigate('#/playlists')
  }

  const metaParts = [
    remote?.author ?? playlist.author,
    remote?.countText ?? playlist.countText,
    remote?.lastUpdated,
    'Synced with YouTube'
  ].filter(Boolean)

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">{remote?.title ?? playlist.name}</h1>
          <p className="page__subtitle">{metaParts.join(' · ')}</p>
        </div>
        <div className="page__actions">
          <button className="btn btn--filled" disabled={items.length === 0} onClick={playAll}>
            <Icon name="play_arrow" size={18} />
            Play all
          </button>
          <button className="icon-btn" aria-label="Playlist options" aria-haspopup="menu" onClick={(e) => setMenuAnchor(e.currentTarget)}>
            <Icon name="more" size={20} />
          </button>
        </div>
      </div>

      <Menu anchor={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)} align="end">
        {playlist.youtubeId && (
          <MenuItem
            icon="link"
            label="Copy link"
            hint="YouTube"
            onSelect={() => {
              setMenuAnchor(null)
              copyLink(playlistUrl(playlist.youtubeId!))
            }}
          />
        )}
        <MenuItem icon="refresh" label="Sync now" onSelect={sync} />
        <MenuItem
          icon="bookmark"
          label="Save a local copy"
          hint={items.length > 0 ? `${items.length}` : undefined}
          onSelect={() => void saveCopy()}
        />
        <MenuItem
          icon="delete"
          label="Remove from playlists"
          danger
          onSelect={() => void removeReference()}
        />
      </Menu>

      {error && (
        <EmptyState icon="close" title="Could not reach YouTube" message={error} />
      )}

      {!error && loading && <Loader label="Loading playlist from YouTube…" />}

      {!error && !loading && items.length === 0 && (
        <EmptyState icon="playlist" title="This playlist is empty" />
      )}

      {items.length > 0 && (
        <ul className="list">
          {items.map((video: VideoSummary, index: number) => (
            <ListRow
              key={`${video.videoId}-${index}`}
              to={`#/watch/${video.videoId}?list=yt:${playlist.youtubeId}`}
              thumbnail={video.thumbnail}
              title={video.title}
              duration={video.duration}
              actions={<VideoOptions video={video} label="Video options" />}
            >
              <ChannelLine
                name={video.author}
                channelId={video.authorId}
                avatar={video.authorAvatar}
              />
              <RowStats viewCount={video.viewCount} published={video.published} />
            </ListRow>
          ))}
        </ul>
      )}

      {items.length > 0 && <div ref={sentinelRef} />}
      {loadingMore && <Loader label="Loading more…" />}
    </div>
  )
}
