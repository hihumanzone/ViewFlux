import { useEffect, useRef, useState } from 'react'
import { VideoCard } from '../components/VideoCard'
import { EmptyState, Loader } from '../components/EmptyState'
import { Icon } from '../components/Icons'
import { navigate } from '../lib/router'
import { useRemotePlaylist } from '../lib/useRemotePlaylist'
import { useCopyLink, playlistUrl } from '../lib/copyLink'
import { toPlaylistVideo } from '../lib/map'
import { useApp } from '../state/AppContext'

/** A public YouTube playlist opened straight from search, without saving it. */
export function RemotePlaylistPage({ playlistId }: { playlistId: string }): React.JSX.Element {
  const { playlist, items, loading, loadingMore, error, loadMore } = useRemotePlaylist(playlistId)
  const { saveYoutubePlaylist, isYoutubePlaylistSaved, removeYoutubePlaylist, refreshPlaylists, toast } =
    useApp()
  const copyLink = useCopyLink()
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)

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

  const save = async (): Promise<void> => {
    if (!playlist || saving) return
    setSaving(true)
    try {
      await saveYoutubePlaylist({
        youtubeId: playlist.id,
        name: playlist.title,
        author: playlist.author,
        countText: playlist.countText,
        thumbnail: playlist.thumbnail
      })
    } finally {
      setSaving(false)
    }
  }

  /** The header button is a toggle, so the saved state is visible in the UI. */
  const remove = async (): Promise<void> => {
    if (!playlist || saving) return
    setSaving(true)
    try {
      await removeYoutubePlaylist(playlist.id)
      await refreshPlaylists()
    } finally {
      setSaving(false)
    }
  }

  /**
   * Freeze the fetched videos into a local playlist on this device, so the
   * contents stay available if the YouTube playlist is later deleted.
   */
  const saveAsLocalCopy = async (): Promise<void> => {
    if (!playlist || copying || items.length === 0) return
    setCopying(true)
    try {
      const local = await window.api.createPlaylist(`${playlist.title} (copy)`)
      for (const video of items) {
        await window.api.addToPlaylist(local.id, toPlaylistVideo(video))
      }
      await refreshPlaylists()
      toast(`Saved “${playlist.title}” as a local copy`)
    } finally {
      setCopying(false)
    }
  }

  if (error) {
    return (
      <div className="page">
        <EmptyState icon="close" title="Could not load playlist" message={error} />
      </div>
    )
  }

  if (loading || !playlist) {
    return (
      <div className="page">
        <Loader label="Loading playlist…" />
      </div>
    )
  }

  const playAll = (): void => {
    const first = items[0]
    if (first) navigate(`#/watch/${first.videoId}?list=yt:${playlist.id}`)
  }

  const metaParts = [
    playlist.author,
    playlist.countText,
    playlist.views,
    playlist.lastUpdated
  ].filter(Boolean)

  return (
    <div className="page">
      <header className="ytpl-header">
        {playlist.thumbnail ? (
          <img className="ytpl-header__thumb" src={playlist.thumbnail} alt="" />
        ) : (
          <div className="ytpl-header__thumb ytpl-header__thumb--fallback">
            <Icon name="playlist" size={30} />
          </div>
        )}
        <div className="ytpl-header__body">
          <h1 className="ytpl-header__title">{playlist.title}</h1>
          <p className="ytpl-header__meta">{metaParts.join(' · ')}</p>
          {playlist.description && <p className="ytpl-header__desc">{playlist.description}</p>}
          <div className="ytpl-header__actions">
            <button className="btn btn--filled" disabled={items.length === 0} onClick={playAll}>
              <Icon name="play_arrow" size={18} />
              Play all
            </button>
            {isYoutubePlaylistSaved(playlist.id) ? (
              <button
                className="btn btn--tonal"
                disabled={saving}
                onClick={() => void remove()}
              >
                <Icon name="bookmarkFilled" size={18} />
                Remove from playlist
              </button>
            ) : (
              <button className="btn btn--tonal" disabled={saving} onClick={() => void save()}>
                <Icon name="bookmark" size={18} />
                Save to playlist
              </button>
            )}
            <button
              className="btn btn--text"
              onClick={() => copyLink(playlistUrl(playlist.id))}
            >
              <Icon name="link" size={18} />
              Copy link
            </button>
            <button
              className="btn btn--text"
              disabled={copying || items.length === 0}
              onClick={() => void saveAsLocalCopy()}
            >
              <Icon name="download" size={18} />
              Save as local copy
            </button>
          </div>
        </div>
      </header>

      {items.length === 0 ? (
        <EmptyState icon="playlist" title="This playlist is empty" />
      ) : (
        <>
          <div className="video-grid">
            {items.map((video, index) => (
              <VideoCard key={`${video.videoId}-${index}`} video={video} />
            ))}
          </div>
          <div ref={sentinelRef} />
          {loadingMore && <Loader label="Loading more…" />}
        </>
      )}
    </div>
  )
}
