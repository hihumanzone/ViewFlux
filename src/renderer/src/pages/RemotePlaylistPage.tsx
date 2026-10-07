import { useEffect, useRef, useState } from 'react'
import { VideoCard } from '../components/VideoCard'
import { MasonryGrid } from '../components/MasonryGrid'
import { EmptyState, Loader } from '../components/EmptyState'
import { Icon } from '../components/Icons'
import { ListRow } from '../components/ListRow'
import { ChannelLine } from '../components/ChannelLine'
import { VideoOptions } from '../components/VideoOptions'
import { ViewModeToggle } from '../components/ViewModeToggle'
import { useViewMode } from '../lib/useViewMode'
import { formatCount, formatVideoPublished } from '../lib/format'
import { navigate } from '../lib/router'
import { useRemotePlaylist } from '../lib/useRemotePlaylist'
import { useCopyLink, playlistUrl } from '../lib/copyLink'
import { toPlaylistVideo } from '../lib/map'
import { enrichVideoWithHistory } from '../lib/enrich'
import { useApp } from '../state/AppContext'

/** A public YouTube playlist opened straight from search, without saving it. */
export function RemotePlaylistPage({ playlistId }: { playlistId: string }): React.JSX.Element {
  const { playlist, items, loading, loadingMore, error, loadMore } = useRemotePlaylist(playlistId)
  const {
    saveYoutubePlaylist,
    isYoutubePlaylistSaved,
    removeYoutubePlaylist,
    refreshPlaylists,
    toast,
    historyMap
  } = useApp()
  const copyLink = useCopyLink()
  const [viewMode, setViewMode] = useViewMode('remote-playlist')
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
        await window.api.addToPlaylist(local.id, toPlaylistVideo(enrichVideoWithHistory(video, historyMap)))
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
          {playlist.author && (
            <div className="ytpl-header__author">
              <ChannelLine
                name={playlist.author}
                channelId={playlist.authorId ?? null}
                avatar={playlist.authorAvatar ?? null}
              />
            </div>
          )}
          {metaParts.length > 0 && <p className="ytpl-header__meta">{metaParts.join(' · ')}</p>}
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
            <ViewModeToggle value={viewMode} onChange={setViewMode} className="ytpl-header__view-mode" />
          </div>
        </div>
      </header>

      {items.length === 0 ? (
        <EmptyState icon="playlist" title="This playlist is empty" />
      ) : viewMode === 'grid' ? (
        <>
          <MasonryGrid key={playlist.id} className="animate-fade-up">
            {items.map((video, index) => {
              const enrichedVideo = enrichVideoWithHistory(video, historyMap)
              return (
                <VideoCard
                  key={`${video.videoId}-${index}`}
                  video={enrichedVideo}
                  to={`#/watch/${video.videoId}?list=yt:${playlist.id}`}
                />
              )
            })}
          </MasonryGrid>
          <div ref={sentinelRef} />
          {loadingMore && <Loader label="Loading more…" />}
        </>
      ) : (
        <>
          <ul key={playlist.id} className="list animate-fade-up">
            {items.map((video, index) => {
              const enrichedVideo = enrichVideoWithHistory(video, historyMap)
              return (
                <ListRow
                  key={`${video.videoId}-${index}`}
                  to={`#/watch/${video.videoId}?list=yt:${playlist.id}`}
                  videoId={video.videoId}
                  thumbnail={enrichedVideo.thumbnail}
                  title={enrichedVideo.title}
                  duration={enrichedVideo.duration}
                  isPremiere={enrichedVideo.isPremiere}
                  isLive={enrichedVideo.isLive}
                  actions={<VideoOptions video={enrichedVideo} label="Video options" />}
                >
                  <ChannelLine
                    name={enrichedVideo.author}
                    channelId={enrichedVideo.authorId}
                    avatar={enrichedVideo.authorAvatar}
                    artists={enrichedVideo.artists}
                  />
                  <div className="list-row__stats">
                    {[
                      enrichedVideo.viewCount != null ? `${formatCount(enrichedVideo.viewCount)} views` : null,
                      formatVideoPublished(enrichedVideo)
                    ].filter(Boolean).join(' · ')}
                  </div>
                </ListRow>
              )
            })}
          </ul>
          <div ref={sentinelRef} />
          {loadingMore && <Loader label="Loading more…" />}
        </>
      )}
    </div>
  )
}
