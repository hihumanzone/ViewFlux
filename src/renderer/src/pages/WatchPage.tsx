import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Player, type PlayerHandle } from '../components/Player'
import { AddToPlaylistDialog } from '../components/AddToPlaylistDialog'
import { EmptyState, Loader } from '../components/EmptyState'
import { Icon } from '../components/Icons'
import { navigate } from '../lib/router'
import { useApp } from '../state/AppContext'
import { formatCount, formatTime } from '../lib/format'
import { toPlaylistVideo } from '../lib/map'
import { useCopyLink, videoUrl } from '../lib/copyLink'
import { scrollPageToTop } from '../lib/scroll'
import { useAsync } from '../lib/useAsync'
import { useBrokenImage } from '../lib/useBrokenImage'
import { readStoredWithLegacy, writeStored } from '../lib/storage'
import { sponsorCategoryLabel, type RydResult, type Settings, type SponsorSegment, type VideoDetails } from '../../../shared/types'

interface QueueItem {
  videoId: string
  title: string
  author: string
  thumbnail: string
  duration: number | null
}

const REMOTE_PREFIX = 'yt:'
// Shared empty array so the SponsorBlock default does not change identity on
// every render, which would re-run the segments effect for no reason.
const NO_SEGMENTS: SponsorSegment[] = []

function renderDescriptionWithTimestamps(
  descText: string,
  onSeek: (seconds: number) => void
): React.ReactNode[] {
  if (!descText) return []
  const timestampRegex = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = timestampRegex.exec(descText)) !== null) {
    if (match.index > lastIndex) {
      parts.push(descText.substring(lastIndex, match.index))
    }
    const hours = match[1] ? parseInt(match[1], 10) : 0
    const mins = parseInt(match[2], 10)
    const secs = parseInt(match[3], 10)
    const seconds = hours * 3600 + mins * 60 + secs
    const rawTime = match[0]

    parts.push(
      <button
        key={match.index}
        type="button"
        className="watch__description-timestamp"
        onClick={(e) => {
          e.stopPropagation()
          onSeek(seconds)
          scrollPageToTop()
        }}
        title={`Jump to ${rawTime}`}
      >
        {rawTime}
      </button>
    )
    lastIndex = timestampRegex.lastIndex
  }

  if (lastIndex < descText.length) {
    parts.push(descText.substring(lastIndex))
  }

  return parts
}

export function WatchPage({
  videoId,
  listId
}: {
  videoId: string
  listId: string | null
}): React.JSX.Element {
  const { settings, playlists, refreshHistory, saveSettings, toast, getHistoryProgress } = useApp()
  const playerRef = useRef<PlayerHandle>(null)

  // Memoised so the SponsorBlock request only refires when a category is
  // actually toggled, not on every unrelated settings write.
  const enabledCategories = useMemo(
    () =>
      settings.sponsorBlockEnabled
        ? Object.entries(settings.sponsorCategories)
            .filter(([, on]) => on)
            .map(([id]) => id)
        : [],
    [settings.sponsorBlockEnabled, settings.sponsorCategories]
  )

  const { data: details = null, error, loading } = useAsync<VideoDetails>(
    () => window.api.getVideo(videoId),
    [videoId]
  )
  // A live broadcast's presentation timeline is a sliding DVR window, so the
  // segments SponsorBlock reports for it (if any) refer to positions that are
  // already gone. Skip the request entirely rather than render a skip overlay
  // that can never fire.
  const isLive = details?.isLive ?? false
  const { data: segments = NO_SEGMENTS } = useAsync<SponsorSegment[]>(
    () => window.api.getSponsorSegments(videoId, enabledCategories),
    [videoId, enabledCategories],
    { enabled: enabledCategories.length > 0 && !isLive, keepPreviousData: true }
  )
  const { data: ryd = null } = useAsync<RydResult | null>(
    () => window.api.getDislikes(videoId),
    [videoId],
    { enabled: settings.showDislikes, keepPreviousData: true }
  )
  const { data: resume = 0, loading: resumeLoading, setData: setResume } = useAsync<number>(
    async () => {
      const history = await window.api.getHistory()
      const entry = history.find((e) => e.videoId === videoId)
      if (!entry) return 0
      // If the video was completed (watched to within 5s of end or >=95% of duration), start from 0!
      const dur = entry.duration
      const isCompleted =
        (dur != null && dur > 0 && (entry.position >= dur - 5 || entry.position / dur >= 0.95)) ||
        entry.position <= 0.5
      return isCompleted ? 0 : entry.position
    },
    [videoId],
    // A history read that fails should not strand the player in "not ready";
    // falling back to 0 is what the screen would have shown anyway.
    { initialData: 0 }
  )
  const ready = !resumeLoading
  const [descOpen, setDescOpen] = useState(false)
  // Only offer Show more / Show less when the text actually overflows.
  const [expandable, setExpandable] = useState(false)
  const descRef = useRef<HTMLDivElement>(null)
  const [addVideo, setAddVideo] = useState<ReturnType<typeof toPlaylistVideo> | null>(null)
  // The playlist sidebar gets its own collapse toggle, remembered across videos.
  const [queueCollapsed, setQueueCollapsed] = useState(
    () => readStoredWithLegacy('viewflux.queue', 'libretube.queue') === 'collapsed'
  )
  const toggleQueue = (): void => {
    setQueueCollapsed((prev) => {
      const next = !prev
      writeStored('viewflux.queue', next ? 'collapsed' : 'expanded')
      return next
    })
  }

  // Re-check resume once metadata details load with authoritative duration
  useEffect(() => {
    const dur = details?.duration
    if (!dur || dur <= 0) return
    setResume((prev) => {
      const position = prev ?? 0
      if (position >= dur - 5 || position / dur >= 0.95) return 0
      return position
    })
  }, [details?.duration, setResume])

  // A fresh video starts with the description collapsed again.
  useEffect(() => {
    setDescOpen(false)
  }, [videoId])

  // ---- Is the description long enough to need Show more / Show less? ---------
  useEffect(() => {
    if (!details) return
    setDescOpen(false)
    let raf = 0
    let cancelled = false
    const measure = (): void => {
      const el = descRef.current
      if (!el || cancelled) return
      // Compare the full (unclamped) height against the 4-line clamp height.
      // This never depends on the clamp class being applied, so — unlike
      // measuring the clamped box — it cannot race with React's re-render.
      const cs = getComputedStyle(el)
      const fontSize = parseFloat(cs.fontSize) || 13.5
      let lineH = parseFloat(cs.lineHeight)
      if (!Number.isFinite(lineH)) lineH = fontSize * 1.6
      setExpandable(el.scrollHeight > lineH * 4 + 8)
    }
    const schedule = (): void => {
      // Double rAF lets layout (and usually webfonts) settle first.
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => measure())
      })
    }
    schedule()
    window.addEventListener('resize', schedule)
    // Font swaps change line wrapping; re-measure once they settle.
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(() => {
        if (!cancelled) measure()
      })
    }
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
    }
  }, [details])

  // ---- Channel avatar (video info does not carry one) -------------------------
  // `details.authorThumbnail` is the fast path; only fall back to a channel
  // lookup when it is missing, and never let a lookup failure surface as an
  // error — the row simply shows the initial-letter avatar.
  const needsAvatar = details !== null && !details.authorThumbnail ? details.authorId : null
  const { data: avatarLookup } = useAsync<{ avatar: string | null; failed: boolean }>(
    async () => {
      try {
        return { avatar: (await window.api.getChannel(needsAvatar as string)).avatar, failed: false }
      } catch {
        return { avatar: null, failed: true }
      }
    },
    [needsAvatar],
    { enabled: needsAvatar !== null }
  )
  const authorAvatar = details?.authorThumbnail ?? avatarLookup?.avatar ?? null
  // `avatarLookup.failed` covers a failed *lookup*; `useBrokenImage` covers an
  // avatar URL that resolved but would not decode.
  const { broken: avatarBroken, onError: onAvatarError } = useBrokenImage(authorAvatar)
  const avatarFailed = (needsAvatar !== null && avatarLookup?.failed === true) || avatarBroken

  // ---- Record history once metadata is known ---------------------------------
  useEffect(() => {
    if (!details || !ready || !settings.saveWatchHistory) return
    void (async () => {
      await window.api.addHistory({
        videoId: details.videoId,
        title: details.title,
        author: details.author,
        thumbnail: details.thumbnails[0]?.url ?? '',
        duration: details.duration || null,
        position: resume,
        watchedAt: Date.now(),
        // Channel details are what History rows use for the avatar and the
        // clickable channel name; re-recording once the avatar lands fills them
        // in (the store keeps any value already stored).
        authorId: details.authorId,
        authorAvatar
      })
      await refreshHistory()
    })()
  }, [details, ready, resume, authorAvatar, refreshHistory, settings.saveWatchHistory])

  // ---- Queue: local playlist or YouTube playlist ------------------------------
  // Two very different sources behind one `?list=` value: a `yt:` prefix means
  // a YouTube playlist that has to be fetched, anything else is a local
  // playlist already sitting in context state.
  const remoteListId = listId?.startsWith(REMOTE_PREFIX) ? listId.slice(REMOTE_PREFIX.length) : null
  const localListId = listId && remoteListId === null ? listId : null
  const localQueue = useMemo(() => {
    if (!localListId) return null
    const found = playlists.find((p) => p.id === localListId)
    return found ? { name: found.name, id: found.id, items: found.videos } : null
  }, [localListId, playlists])
  const { data: remoteQueue } = useAsync<{ name: string; items: QueueItem[] }>(
    async () => {
      const playlist = await window.api.getRemotePlaylist(remoteListId as string)
      return {
        name: playlist.title,
        items: playlist.items.map((v) => ({
          videoId: v.videoId,
          title: v.title,
          author: v.author,
          thumbnail: v.thumbnail,
          duration: v.duration
        }))
      }
    },
    [remoteListId],
    { enabled: remoteListId !== null }
  )
  // A YouTube queue that fails to load simply has no sidebar; the video itself
  // is still perfectly watchable, so this never surfaces as an error state.
  const queue =
    remoteListId !== null
      ? remoteQueue
        ? { name: remoteQueue.name, id: listId as string, items: remoteQueue.items }
        : null
      : localQueue

  const queueIndex = queue ? queue.items.findIndex((v) => v.videoId === videoId) : -1
  const activeQueueItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Keep the playing row inside the playlist pane. A bare `scrollIntoView`
    // would also scroll every scrollable ancestor — the main column included —
    // because a row in the right-hand pane sits outside its scrollport, so
    // changing videos would yank the description out of view.
    const item = activeQueueItemRef.current
    const list = item?.closest<HTMLElement>('.queue')
    if (!item || !list) return
    const itemRect = item.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    if (itemRect.top < listRect.top) {
      list.scrollBy({ top: itemRect.top - listRect.top - 8, behavior: 'smooth' })
    } else if (itemRect.bottom > listRect.bottom) {
      list.scrollBy({ top: itemRect.bottom - listRect.bottom + 8, behavior: 'smooth' })
    }
  }, [queueIndex])

  const onEnded = useCallback(() => {
    // When a video finishes, reset its saved history position to 0 so watching it again starts at beginning
    if (settings.saveWatchHistory) {
      void window.api.updateHistoryPosition(videoId, 0)
    }
    if (settings.autoplayPlaylists && queue && queueIndex >= 0) {
      const next = queue.items[queueIndex + 1]
      if (next) navigate(`#/watch/${next.videoId}?list=${queue.id}`)
    }
  }, [videoId, queue, queueIndex, settings.autoplayPlaylists, settings.saveWatchHistory])

  const onTimeUpdate = useCallback(
    (position: number, duration: number) => {
      if (!settings.saveWatchHistory) return
      // If watched near the end (within 5 seconds or >=95%), record 0 so it restarts next time
      const isCompleted = duration > 0 && (position >= duration - 5 || position / duration >= 0.95)
      void window.api.updateHistoryPosition(videoId, isCompleted ? 0 : position)
    },
    [videoId, settings.saveWatchHistory]
  )

  const onSkipped = useCallback(
    (segment: SponsorSegment) => {
      toast(`Skipped ${sponsorCategoryLabel(segment.category)}`, {
        actionLabel: 'Undo',
        onAction: () => playerRef.current?.unskip(segment)
      })
    },
    [toast]
  )

  // Windows media keys / SMTC "previous" & "next" follow the queue when the
  // video was opened from a playlist, and fall back to chapters otherwise.
  const onMediaPrevious = useCallback(() => {
    if (queue && queueIndex > 0) {
      const prev = queue.items[queueIndex - 1]
      if (prev) navigate(`#/watch/${prev.videoId}?list=${queue.id}`)
      return
    }
    playerRef.current?.previousChapter()
  }, [queue, queueIndex])

  const onMediaNext = useCallback(() => {
    if (queue && queueIndex >= 0 && queueIndex < queue.items.length - 1) {
      const next = queue.items[queueIndex + 1]
      if (next) navigate(`#/watch/${next.videoId}?list=${queue.id}`)
      return
    }
    playerRef.current?.nextChapter()
  }, [queue, queueIndex])

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      void saveSettings({ ...settings, ...patch })
    },
    [settings, saveSettings]
  )

  const copyLink = useCopyLink()

  // The playlist list is the only scroller in the pane, so a wheel that lands
  // on the pane's chrome — the header, the padding, the gaps between rows — has
  // no scrollable ancestor of its own and would do nothing. Hand those deltas
  // to the list so hovering anywhere in the pane scrolls it.
  const onQueueWheel = useCallback((event: React.WheelEvent<HTMLElement>) => {
    const list = event.currentTarget.querySelector<HTMLElement>('.queue')
    if (!list || event.deltaY === 0) return
    // Over the list itself the browser scrolls it natively — do not double up.
    if (event.target === list || list.contains(event.target as Node)) return
    const max = list.scrollHeight - list.clientHeight
    const next = Math.min(max, Math.max(0, list.scrollTop + event.deltaY))
    if (next === list.scrollTop) return
    list.scrollTop = next
  }, [])

  const playerMediaSession = useMemo(
    () =>
      details
        ? {
            title: details.title,
            artist: details.author,
            album: queue?.name,
            artwork: details.thumbnails[0]?.url,
            onNextTrack: onMediaNext,
            onPreviousTrack: onMediaPrevious
          }
        : undefined,
    [details, queue?.name, onMediaNext, onMediaPrevious]
  )

  if (loading) {
    return (
      <div className="page">
        <Loader label="Loading video…" />
      </div>
    )
  }

  if (error || !details) {
    return (
      <div className="page">
        <EmptyState
          icon="close"
          title="Could not load video"
          message={error ?? 'Unknown error'}
        />
      </div>
    )
  }

  const likes = ryd?.likes ?? details.likeCount
  const dislikes = ryd?.dislikes ?? null

  const hasChapters = Boolean(details?.chapters && details.chapters.length > 0)
  const showQueue = Boolean(queue && !queueCollapsed)
  const showSide = showQueue

  return (
    <div className={`watch${showSide ? '' : ' watch--solo'}`}>
      <div className="watch__main">
        <div className="watch__player">
          {details.playable && details.manifestUrl && ready ? (
            <Player
              key={videoId}
              ref={playerRef}
              videoId={videoId}
              manifestUrl={details.manifestUrl}
              isLive={details.isLive}
              poster={details.thumbnails[0]?.url}
              captions={details.captions}
              chapters={details.chapters}
              startPosition={details.isLive ? 0 : resume}
              autoplay
              segments={segments}
              autoSkip={settings.autoSkip}
              sponsorBlockEnabled={settings.sponsorBlockEnabled}
              alwaysShowCaptions={settings.alwaysShowCaptions}
              subtitleStyle={settings.subtitleStyle}
              initialVolume={settings.defaultVolume}
              initialSpeed={settings.preferredSpeed}
              preferredQuality={settings.preferredQuality}
              preservePitch={settings.preservePitch}
              skipSilence={settings.skipSilence}
              defaultAudioLanguage={details.defaultAudioLanguage ?? null}
              onPitchChange={(value) => updateSettings({ preservePitch: value })}
              onSkipSilenceChange={(value) => updateSettings({ skipSilence: value })}
              onSubtitleStyleChange={(subtitleStyle) => updateSettings({ subtitleStyle })}
              onTimeUpdate={onTimeUpdate}
              onEnded={onEnded}
              onSkipped={onSkipped}
              mediaSession={playerMediaSession}
            />
          ) : (
            <div className="player__error">
              <span className="player__error-icon">
                <Icon name={details.isLive ? 'close' : 'info'} size={26} />
              </span>
              <div>
                <p className="player__error-title">
                  {details.isLive ? 'Live stream is currently unavailable' : 'This video is unavailable'}
                </p>
                <p>{details.reason ?? 'It may be private, region-locked or age-restricted.'}</p>
              </div>
              <div className="player__error-actions">
                <button
                  type="button"
                  className="btn btn--tonal btn--sm"
                  onClick={() => navigate('#/')}
                >
                  <Icon name="back" size={16} />
                  Back to home
                </button>
                {details.authorId && (
                  <button
                    type="button"
                    className="btn btn--tonal btn--sm"
                    onClick={() => navigate(`#/channel/${details.authorId}`)}
                  >
                    <Icon name="person" size={16} />
                    Visit {details.author}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--text btn--sm"
                  onClick={() => window.history.back()}
                >
                  <Icon name="forward" size={16} />
                  Go back
                </button>
              </div>
            </div>
          )}
        </div>

        <h1 className="watch__title">{details.title}</h1>


        <div className="watch__bar">
          <div className="watch__channel-group">
            <button
              className="watch__channel"
              title={`Open ${details.author}'s channel`}
              onClick={() => {
                if (details.authorId) {
                  navigate(`#/channel/${details.authorId}`)
                } else if (details.author) {
                  navigate(`#/search?q=${encodeURIComponent(details.author)}&f=channels`)
                }
              }}
            >
              {authorAvatar && !avatarFailed ? (
                <img
                  className="watch__channel-avatar"
                  src={authorAvatar}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={onAvatarError}
                />
              ) : (
                <div className="watch__channel-avatar watch__channel-avatar--fallback">
                  {details.author.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="watch__channel-text">
                <div className="watch__channel-name">{details.author}</div>
                <div className="watch__channel-sub">
                  {details.authorId ? 'Creator' : 'Channel'}
                </div>
              </div>
            </button>
          </div>

          <div className="watch__actions">
            <span className="chip chip--split" title="Likes / Dislikes">
              <span className="chip__part">
                <Icon name="like" size={18} />
                {likes != null ? formatCount(likes) : 'Like'}
              </span>
              {settings.showDislikes && (
                <>
                  <span className="chip__divider" />
                  <span className="chip__part">
                    <Icon name="dislike" size={18} />
                    {dislikes != null ? formatCount(dislikes) : '—'}
                  </span>
                </>
              )}
            </span>
            <button
              className="chip"
              onClick={() =>
                setAddVideo(
                  toPlaylistVideo({
                    videoId: details.videoId,
                    title: details.title,
                    author: details.author,
                    authorId: details.authorId,
                    authorAvatar: details.authorThumbnail,
                    viewCount: details.viewCount,
                    published: details.publishDate,
                    thumbnail: details.thumbnails[0]?.url ?? '',
                    duration: details.duration || null
                  })
                )
              }
            >
              <Icon name="bookmark" size={18} />
              Save
            </button>
            <button
              className="chip"
              onClick={() => copyLink(videoUrl(details.videoId || videoId))}
            >
              <Icon name="link" size={18} />
              Copy link
            </button>
            {queue && (
              <button
                type="button"
                className="chip"
                onClick={toggleQueue}
                aria-label={queueCollapsed ? 'Expand playlist' : 'Collapse playlist'}
                title={queueCollapsed ? 'Expand playlist' : 'Collapse playlist'}
              >
                <Icon name="playlist" size={18} />
                {queueCollapsed ? 'Expand playlist' : 'Collapse playlist'}
              </button>
            )}
          </div>
        </div>

        {hasChapters && (
          <div className="watch__chapters">
            <div className="watch__chapters-header">
              <div className="watch__chapters-title">
                <Icon name="chapters" size={18} />
                <span>Chapters</span>
                <span className="watch__chapters-count">{details.chapters.length}</span>
              </div>
            </div>
            <div className="watch__chapters-carousel">
              {details.chapters.map((ch, idx) => (
                <button
                  key={`${ch.start}-${idx}`}
                  type="button"
                  className="watch__chapter-card"
                  onClick={() => {
                    playerRef.current?.seekTo(ch.start)
                    scrollPageToTop()
                  }}
                  title={`${ch.title} (${formatTime(ch.start)} - ${formatTime(ch.end)})`}
                >
                  <div className="watch__chapter-card-thumb-wrap">
                    {ch.thumbnail ? (
                      <img
                        src={ch.thumbnail}
                        alt=""
                        className="watch__chapter-card-thumb"
                        loading="lazy"
                      />
                    ) : (
                      <div className="watch__chapter-card-thumb-fallback">
                        <Icon name="play" size={16} />
                      </div>
                    )}
                    <span className="watch__chapter-card-time">{formatTime(ch.start)}</span>
                  </div>
                  <div className="watch__chapter-card-meta">
                    <span className="watch__chapter-card-name">{ch.title}</span>
                    <span className="watch__chapter-card-dur">{formatTime(ch.end - ch.start)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div
          className={[
            'watch__description',
            expandable && 'watch__description--expandable',
            descOpen && 'watch__description--open'
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="watch__description-text" ref={descRef}>
            <strong>
              {formatCount(details.viewCount)} views · {details.publishDate}
            </strong>
            {'\n'}
            {details.description
              ? renderDescriptionWithTimestamps(details.description, (sec) =>
                  playerRef.current?.seekTo(sec)
                )
              : 'No description.'}
          </span>
          {expandable && (
            <button
              type="button"
              className="watch__description-toggle"
              onClick={() => setDescOpen((prev) => !prev)}
            >
              {descOpen ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      </div>

      {showSide && queue && (
        <aside className="watch__side" onWheel={onQueueWheel}>
          <div className="watch__side-head">
            <h2 className="watch__side-title">
              {queue.name} · {queue.items.length}
            </h2>
            <button
              type="button"
              className={`icon-btn${settings.autoplayPlaylists ? ' icon-btn--active' : ''}`}
              title={settings.autoplayPlaylists ? 'Autoplay is on' : 'Autoplay is off'}
              aria-label={settings.autoplayPlaylists ? 'Autoplay is on' : 'Autoplay is off'}
              onClick={() => updateSettings({ autoplayPlaylists: !settings.autoplayPlaylists })}
            >
              <Icon name="autoplay" size={20} />
            </button>
          </div>

          <div className="queue">
            {queue.items.map((video, index) => {
              const isActive = index === queueIndex
              const progress = getHistoryProgress(video.videoId, video.duration)
              const histPct = progress > 0 ? Math.min(100, Math.max(0, progress * 100)) : 0
              return (
                <button
                  key={`${video.videoId}-${index}`}
                  ref={isActive ? activeQueueItemRef : undefined}
                  className={`queue__item${isActive ? ' queue__item--active' : ''}`}
                  onClick={() => navigate(`#/watch/${video.videoId}?list=${queue.id}`)}
                >
                  <div className="queue__thumb-wrap">
                    <img className="queue__thumb" src={video.thumbnail} alt="" loading="lazy" />
                    <span className="queue__index">{index + 1}</span>
                    {histPct > 0 && (
                      <div className="video-card__progress">
                        <i style={{ width: `${histPct}%` }} />
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="queue__title">{video.title}</div>
                    <div className="queue__meta">{video.author}</div>
                  </div>
                </button>
              )
            })}
          </div>
        </aside>
      )}

      {addVideo && <AddToPlaylistDialog video={addVideo} onClose={() => setAddVideo(null)} />}
    </div>
  )
}
