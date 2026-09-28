import { useCallback, useEffect, useRef, useState } from 'react'
import { VideoCard } from '../components/VideoCard'
import { PlaylistCard } from '../components/ResultCards'
import { BookmarkChannelDialog } from '../components/BookmarkChannelDialog'
import { Icon, MusicBadge } from '../components/Icons'
import { Menu, MenuItem } from '../components/Menu'
import { EmptyState, Loader } from '../components/EmptyState'
import { useApp } from '../state/AppContext'
import { useCopyLink, useOpenExternal, channelUrl } from '../lib/copyLink'
import { useAsync } from '../lib/useAsync'
import { navigate } from '../lib/router'
import type {
  AboutInfo,
  ChannelInfo,
  ChannelSort,
  ChannelVideosPage,
  PlaylistSummary,
  VideoSummary
} from '../../../shared/types'

const KNOWN_TABS = ['videos', 'releases', 'playlists', 'about']

const SORTS: { id: ChannelSort; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'popular', label: 'Most popular' },
  { id: 'oldest', label: 'Oldest' }
]

interface VideosState {
  items: VideoSummary[]
  continuation: string | null
  loading: boolean
}

interface PlaylistState {
  items: PlaylistSummary[]
  continuation: string | null
  loading: boolean
}

const EMPTY_LIST: PlaylistState = { items: [], continuation: null, loading: false }

export function ChannelPage({
  channelId,
  initialTab
}: {
  channelId: string
  initialTab: string | null
}): React.JSX.Element {
  const { savedChannels } = useApp()
  const [bookmarkModalOpen, setBookmarkModalOpen] = useState(false)
  const isSaved = savedChannels.some((c) => c.channelId === channelId)
  const [optionsAnchor, setOptionsAnchor] = useState<HTMLElement | null>(null)
  const copyLink = useCopyLink()
  const openExternal = useOpenExternal()

  // ---- Channel info ----------------------------------------------------------
  const { data: info = null, error, reload: reloadInfo } = useAsync<ChannelInfo>(
    () => window.api.getChannel(channelId),
    [channelId]
  )
  // InnerTube omits tabs a channel does not expose (no playlists, say); fall
  // back to the full set so the tab bar never renders empty.
  const normalizedTabs = (info?.tabs ?? [])
    .map((t) => t.toLowerCase())
    .filter((t) => KNOWN_TABS.includes(t))
  const tabs = normalizedTabs.length > 0 ? normalizedTabs : KNOWN_TABS
  // The tab lives in the URL (`?tab=`) so it survives a reload, can be linked
  // to, and Back/Alt+Left steps out of it like any other navigation. The route
  // is the source of truth; this only mirrors it for synchronous reads.
  const [tab, setTab] = useState<string>(initialTab ?? 'videos')
  useEffect(() => {
    setTab(initialTab ?? 'videos')
  }, [initialTab])
  const selectTab = useCallback(
    (next: string) => {
      setTab(next)
      navigate(`#/channel/${channelId}?tab=${next}`)
    },
    [channelId]
  )
  const [sort, setSort] = useState<ChannelSort>('newest')
  const [sortMenu, setSortMenu] = useState(false)
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [avatarAttempt, setAvatarAttempt] = useState(0)
  // A missing banner URL is handled by the fallback div, but a present-yet-
  // broken URL (deleted image, 403) would render as a corrupted-image icon —
  // swap to the gradient fallback instead.
  const [bannerFailed, setBannerFailed] = useState(false)

  const [videos, setVideos] = useState<VideosState>({
    items: [],
    continuation: null,
    loading: false
  })
  // Paginated, so it keeps its own continuation rather than going through
  // useAsync — the hook models "fetch once per input", this is "fetch then
  // append".
  const [playlists, setPlaylists] = useState<PlaylistState>(EMPTY_LIST)
  const [releases, setReleases] = useState<PlaylistState>(EMPTY_LIST)

  const sentinelRef = useRef<HTMLDivElement>(null)
  const videoReqRef = useRef(0)

  // ---- Videos (per sort) -------------------------------------------------------
  useEffect(() => {
    const id = ++videoReqRef.current
    setVideos((prev) => ({ ...prev, loading: true, items: [], continuation: null }))
    void window.api
      .getChannelVideos(channelId, sort)
      .then((page: ChannelVideosPage) => {
        if (videoReqRef.current !== id) return
        setVideos({
          items: page.items,
          continuation: page.continuation,
          loading: false
        })
      })
      .catch(() => {
        if (videoReqRef.current === id)
          setVideos({ items: [], continuation: null, loading: false })
      })
  }, [channelId, sort])

  const loadMoreVideos = useCallback(async () => {
    if (!videos.continuation || videos.loading) return
    setVideos((prev) => ({ ...prev, loading: true }))
    try {
      const page = await window.api.channelVideosMore(videos.continuation as string)
      setVideos((prev) => ({
        items: [...prev.items, ...page.items],
        continuation: page.continuation,
        loading: false
      }))
    } catch {
      setVideos((prev) => ({ ...prev, continuation: null, loading: false }))
    }
  }, [videos.continuation, videos.loading])

  // ---- Playlists / releases (lazy, cached) --------------------------------------
  useEffect(() => {
    if (tab !== 'playlists' || playlists.items.length > 0 || playlists.loading) return
    setPlaylists((prev) => ({ ...prev, loading: true }))
    void window.api
      .getChannelPlaylists(channelId)
      .then((page) =>
        setPlaylists({ items: page.items, continuation: page.continuation, loading: false })
      )
      .catch(() => setPlaylists(EMPTY_LIST))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, channelId])

  // Music channels list their albums on a "Releases" tab; only music channels
  // get the tab in the first place, so an empty response is a normal outcome.
  useEffect(() => {
    if (tab !== 'releases' || releases.items.length > 0 || releases.loading) return
    setReleases((prev) => ({ ...prev, loading: true }))
    void window.api
      .getChannelReleases(channelId)
      .then((page) =>
        setReleases({ items: page.items, continuation: page.continuation, loading: false })
      )
      .catch(() => setReleases(EMPTY_LIST))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, channelId])

  const loadMoreReleases = useCallback(async () => {
    if (!releases.continuation || releases.loading) return
    setReleases((prev) => ({ ...prev, loading: true }))
    try {
      const page = await window.api.channelReleasesMore(releases.continuation as string)
      setReleases((prev) => ({
        items: [...prev.items, ...page.items],
        continuation: page.continuation,
        loading: false
      }))
    } catch {
      setReleases((prev) => ({ ...prev, continuation: null, loading: false }))
    }
  }, [releases.continuation, releases.loading])

  // ---- About (lazy) ------------------------------------------------------------
  // Only requested when the tab is open. A failure renders as a channel with no
  // description, which is what a channel without one looks like anyway.
  const { data: about, error: aboutError } = useAsync<AboutInfo>(
    () => window.api.getChannelAbout(channelId),
    [channelId],
    { enabled: tab === 'about' }
  )

  // ---- Infinite scroll ---------------------------------------------------------
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        if (tab === 'videos') void loadMoreVideos()
        else if (tab === 'releases') void loadMoreReleases()
      },
      { rootMargin: '600px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [tab, loadMoreVideos, loadMoreReleases])

  if (error) {
    // Transient network failures are common here, so offer a retry rather than
    // making the user go back and re-enter the channel.
    return (
      <div className="page">
        <EmptyState
          icon="close"
          title="Could not load channel"
          message={error}
          action={
            <button type="button" className="btn btn--tonal" onClick={reloadInfo}>
              Try again
            </button>
          }
        />
      </div>
    )
  }

  return (
    <div className="channel">
      {/* ---- Banner + header ---- */}
      <header className="channel__hero">
        {info?.banner && !bannerFailed ? (
          <img
            className="channel__banner"
            src={info.banner}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setBannerFailed(true)}
          />
        ) : (
          <div className="channel__banner channel__banner--fallback" />
        )}
        <div className="channel__head">
          {info?.avatar && !avatarFailed ? (
            <img
              key={avatarAttempt}
              className="channel__avatar"
              src={
                avatarAttempt > 0
                  ? `${info.avatar}${info.avatar.includes('?') ? '&' : '?'}r=${avatarAttempt}`
                  : info.avatar
              }
              alt=""
              referrerPolicy="no-referrer"
              onError={() => {
                // CDNs occasionally 403/hiccup; retry once before falling back.
                if (avatarAttempt < 1) setAvatarAttempt(avatarAttempt + 1)
                else setAvatarFailed(true)
              }}
            />
          ) : (
            <div className="channel__avatar channel__avatar--fallback">
              {info?.name.slice(0, 1).toUpperCase() ?? ''}
            </div>
          )}
          <div className="channel__head-text">
            <h1 className="channel__name">
              <span className="channel__name-text">{info?.name ?? '…'}</span>
              {info?.isMusic && <MusicBadge size={20} />}
            </h1>
            <div className="channel__meta">
              {info?.handle && <span>{info.handle}</span>}
              {info?.subscribers && <span>{info.subscribers}</span>}
              {info?.videoCount && <span>{info.videoCount}</span>}
            </div>
            {info?.description && <p className="channel__tagline">{info.description}</p>}
          </div>
          {info && (
            <div className="channel__head-actions">
              {/* Overflow trigger leads the action group, mirroring the layout
                  used on channel cards: overflow menu, then the primary action. */}
              <button
                type="button"
                className="icon-btn channel__options"
                aria-label="Channel options"
                aria-haspopup="menu"
                title="Channel options"
                onClick={(event) => {
                  // `currentTarget` is only readable while the event is being
                  // dispatched, so capture it before deferring the state update.
                  const trigger = event.currentTarget
                  setOptionsAnchor((anchor) => (anchor ? null : trigger))
                }}
              >
                <Icon name="more" size={18} />
              </button>
              <button
                type="button"
                className={`btn ${isSaved ? 'btn--filled' : 'btn--tonal'}`}
                onClick={() => setBookmarkModalOpen(true)}
                title={isSaved ? 'Edit channel bookmark' : 'Bookmark this channel'}
              >
                <Icon name={isSaved ? 'bookmarkFilled' : 'bookmark'} size={18} />
                <span>{isSaved ? 'Saved' : 'Bookmark channel'}</span>
              </button>
              <Menu
                anchor={optionsAnchor}
                open={optionsAnchor != null}
                onClose={() => setOptionsAnchor(null)}
                align="end"
              >
                <MenuItem
                  icon="link"
                  label="Copy link"
                  onSelect={() => {
                    setOptionsAnchor(null)
                    copyLink(channelUrl(channelId))
                  }}
                />
              </Menu>
            </div>
          )}
        </div>
      </header>

      {/* ---- Tabs ---- */}
      <div className="channel__tabs" role="tablist">
        {tabs.map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={`tab${tab === name ? ' tab--active' : ''}`}
            onClick={() => selectTab(name)}
          >
            {name.charAt(0).toUpperCase() + name.slice(1)}
          </button>
        ))}
        {tab === 'videos' && (
          <>
            <div className="channel__tabs-spacer" />
            <button
              className="chip channel__sort"
              onClick={(event) => {
                const element = event.currentTarget
                setSortMenu((prev) => {
                  setSortAnchor(prev ? null : element)
                  return !prev
                })
              }}
              aria-haspopup="menu"
              aria-expanded={sortMenu}
            >
              <Icon name="sort" size={16} />
              {SORTS.find((s) => s.id === sort)?.label}
            </button>
          </>
        )}
      </div>

      {/* ---- Videos tab ---- */}
      {tab === 'videos' && (
        <section className="channel__section">
          {videos.loading && videos.items.length === 0 && (
            <div className="loader">
              <div className="spinner" />
            </div>
          )}
          {!videos.loading && videos.items.length === 0 && (
            <div className="empty">
              <div className="empty__icon">
                <Icon name="play_arrow" size={30} />
              </div>
              <div className="empty__title">No videos</div>
            </div>
          )}
          {videos.items.length > 0 && (
            <div className="video-grid">
              {videos.items.map((video, index) => (
                <VideoCard
                  key={`${video.videoId}-${index}`}
                  video={video}
                />
              ))}
            </div>
          )}
          <div ref={sentinelRef} />
          {videos.loading && videos.items.length > 0 && (
            <div className="loader">
              <div className="spinner" />
            </div>
          )}
        </section>
      )}

      <Menu
        anchor={sortAnchor}
        open={sortMenu}
        onClose={() => {
          setSortMenu(false)
          setSortAnchor(null)
        }}
        align="end"
        title="Sort by"
        checkable
      >
        {SORTS.map((option) => (
          <MenuItem
            key={option.id}
            label={option.label}
            selected={sort === option.id}
            onSelect={() => {
              setSort(option.id)
              setSortMenu(false)
              setSortAnchor(null)
            }}
          />
        ))}
      </Menu>

      {/* ---- Releases tab ---- */}
      {tab === 'releases' && (
        <section className="channel__section">
          {releases.loading && releases.items.length === 0 && (
            <div className="loader">
              <div className="spinner" />
            </div>
          )}
          {!releases.loading && releases.items.length === 0 && (
            <div className="empty">
              <div className="empty__icon">
                <Icon name="album" size={30} />
              </div>
              <div className="empty__title">No releases</div>
            </div>
          )}
          {releases.items.length > 0 && (
            <div className="video-grid">
              {releases.items.map((album, index) => (
                <PlaylistCard key={`${album.id}-${index}`} playlist={album} />
              ))}
            </div>
          )}
          <div ref={sentinelRef} />
          {releases.loading && releases.items.length > 0 && (
            <div className="loader">
              <div className="spinner" />
            </div>
          )}
        </section>
      )}

      {/* ---- Playlists tab ---- */}
      {tab === 'playlists' && (
        <section className="channel__section">
          {playlists.loading && playlists.items.length === 0 && (
            <div className="loader">
              <div className="spinner" />
            </div>
          )}
          {!playlists.loading && playlists.items.length === 0 && (
            <div className="empty">
              <div className="empty__icon">
                <Icon name="playlist" size={30} />
              </div>
              <div className="empty__title">No public playlists</div>
            </div>
          )}
          {playlists.items.length > 0 && (
            <div className="video-grid">
              {playlists.items.map((playlist, index) => (
                <PlaylistCard key={`${playlist.id}-${index}`} playlist={playlist} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---- About tab ---- */}
      {tab === 'about' && (
        <section className="channel__section channel__section--about">
          {!about ? (
            aboutError ? (
              <EmptyState
                icon="close"
                title="Could not load channel details"
                message={aboutError}
              />
            ) : (
              <Loader label="Loading channel details…" />
            )
          ) : (
            <div className="about">
              {about.description && <p className="about__description">{about.description}</p>}
              <div className="about__stats">
                {about.subscriberCount && (
                  <div className="about__stat">
                    <Icon name="person" size={18} />
                    {about.subscriberCount}
                  </div>
                )}
                {about.viewCount && (
                  <div className="about__stat">
                    <Icon name="play_arrow" size={18} />
                    {about.viewCount}
                  </div>
                )}
                {about.videoCount && (
                  <div className="about__stat">
                    <Icon name="playlist" size={18} />
                    {about.videoCount}
                  </div>
                )}
                {about.joinedDate && (
                  <div className="about__stat">
                    <Icon name="timer" size={18} />
                    {about.joinedDate}
                  </div>
                )}
                {about.country && (
                  <div className="about__stat">
                    <Icon name="globe" size={18} />
                    {about.country}
                  </div>
                )}
              </div>
              {about.links.length > 0 && (
                <div className="about__links">
                  {about.links.map((link, index) => (
                    <button
                      key={`${link.title}-${link.url}-${index}`}
                      type="button"
                      className="chip"
                      onClick={() => {
                        if (typeof link.url === 'string' && link.url) openExternal(link.url)
                      }}
                      title={typeof link.url === 'string' ? link.url : ''}
                    >
                      <Icon name="link" size={14} />
                      {link.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {bookmarkModalOpen && info && (
        <BookmarkChannelDialog
          channelId={channelId}
          title={info.name}
          handle={info.handle}
          avatar={info.avatar}
          onClose={() => setBookmarkModalOpen(false)}
        />
      )}
    </div>
  )
}
