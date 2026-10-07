import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icons'
import { ChannelLine } from '../components/ChannelLine'
import { InlineSearch } from '../components/InlineSearch'
import { EmptyState } from '../components/EmptyState'
import { ListRow } from '../components/ListRow'
import { VideoCard } from '../components/VideoCard'
import { VideoOptions } from '../components/VideoOptions'
import { MasonryGrid } from '../components/MasonryGrid'
import { ViewModeToggle } from '../components/ViewModeToggle'
import { useViewMode } from '../lib/useViewMode'
import { formatCount, formatDuration, formatRelative, formatVideoPublished } from '../lib/format'
import { navigate } from '../lib/router'
import { useApp } from '../state/AppContext'

export function HistoryPage(): React.JSX.Element {
  const { history, settings, refreshHistory, confirm, toast } = useApp()
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useViewMode('history')

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  const remove = async (videoId: string): Promise<void> => {
    await window.api.removeHistory(videoId)
    await refreshHistory()
  }

  const clear = async (): Promise<void> => {
    const ok = await confirm('Clear your entire watch history?', {
      confirmLabel: 'Clear all',
      danger: true
    })
    if (!ok) return
    await window.api.clearHistory()
    await refreshHistory()
    toast('Watch history cleared')
  }

  const mostRecentInProgress = useMemo(() => {
    return history.find(
      (h) => h.position > 10 && h.duration != null && h.position < h.duration - 15
    )
  }, [history])

  const filteredHistory = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return history
    return history.filter(
      (entry) =>
        entry.title.toLowerCase().includes(q) ||
        entry.author.toLowerCase().includes(q)
    )
  }, [history, searchQuery])

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">History</h1>
          <p className="page__subtitle">
            Videos you have watched, with progress bars and resume positions.
            {history.length > 0 && ` (${history.length} stored · limit ${settings.maxWatchHistory || 500})`}
          </p>
        </div>
        {history.length > 0 && (
          <div className="page__actions page__actions--grow">
            <InlineSearch
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search history by title or channel..."
              ariaLabel="Search watch history"
            />
            <ViewModeToggle value={viewMode} onChange={setViewMode} />
            <button className="btn btn--tonal" onClick={() => void clear()}>
              <Icon name="delete" size={18} />
              Clear all
            </button>
          </div>
        )}
      </div>

      {!searchQuery && mostRecentInProgress && (
        <div
          className="resume-banner"
          onClick={() => navigate(`#/watch/${mostRecentInProgress.videoId}`)}
          title={`Resume ${mostRecentInProgress.title}`}
        >
          <img className="resume-banner__thumb" src={mostRecentInProgress.thumbnail} alt="" />
          <div className="resume-banner__body">
            <span className="resume-banner__tag">
              <Icon name="history" size={14} /> Resume watching
            </span>
            <span className="resume-banner__title">{mostRecentInProgress.title}</span>
            <span className="resume-banner__meta">
              {mostRecentInProgress.author} · {formatDuration(mostRecentInProgress.position)} of {formatDuration(mostRecentInProgress.duration)}
            </span>
          </div>
          <button type="button" className="btn btn--filled btn--sm resume-banner__btn">
            <Icon name="play" size={16} />
            Resume
          </button>
        </div>
      )}

      {!settings.saveWatchHistory && (
        <div className="notice">
          <Icon name="info" size={18} />
          <span>
            Recording is off — new videos aren’t being added. Turn “Save watch history” back on in
            Settings.
          </span>
        </div>
      )}

      {history.length === 0 ? (
        <EmptyState
          icon="history"
          title="No watch history"
          message="Videos you watch will appear here automatically."
        />
      ) : filteredHistory.length === 0 ? (
        <EmptyState
          icon="search"
          title="No matching videos"
          message={`No watch history entries match “${searchQuery}”.`}
          action={
            <button className="btn btn--tonal empty__action" onClick={() => setSearchQuery('')}>
              Clear search
            </button>
          }
        />
      ) : (
        <div>
          {searchQuery && (
            <div className="list__note">
              Showing {filteredHistory.length} of {history.length} watched videos
            </div>
          )}
          {viewMode === 'grid' ? (
            <MasonryGrid key={searchQuery ? 'filtered-grid' : 'all-grid'} className="animate-fade-up">
              {filteredHistory.map((entry) => {
                const hasDuration = entry.duration != null && entry.duration > 0
                const pct = hasDuration && entry.position > 0 ? entry.position / entry.duration! : undefined
                return (
                  <VideoCard
                    key={entry.videoId}
                    video={{
                      videoId: entry.videoId,
                      title: entry.title,
                      author: entry.author,
                      thumbnail: entry.thumbnail,
                      duration: entry.duration,
                      authorId: entry.authorId ?? null,
                      authorAvatar: entry.authorAvatar ?? null,
                      viewCount: entry.viewCount ?? null,
                      published: entry.published ?? null,
                      publishTimestamp: entry.publishTimestamp ?? null,
                      isPremiere: entry.isPremiere,
                      isStreamed: entry.isStreamed,
                      isLive: Boolean(entry.isLive)
                    }}
                    progress={pct}
                  />
                )
              })}
            </MasonryGrid>
          ) : (
            <ul key={searchQuery ? 'filtered' : 'all'} className="list animate-fade-up">
              {filteredHistory.map((entry, index) => {
                const hasDuration = entry.duration != null && entry.duration > 0
                const pct = hasDuration
                  ? Math.min(100, Math.max(0, (entry.position / entry.duration!) * 100))
                  : 0
                const hasProgress = hasDuration && entry.position > 0 && pct > 0

                return (
                  <ListRow
                    key={`${entry.videoId}-${index}`}
                    to={`#/watch/${entry.videoId}`}
                    videoId={entry.videoId}
                    thumbnail={entry.thumbnail}
                    title={entry.title}
                    duration={entry.duration}
                    isPremiere={entry.isPremiere}
                    isLive={Boolean(entry.isLive)}
                    hasProgress={hasProgress}
                    thumbnailOverlay={
                      hasProgress ? (
                        <div
                          className="video-card__progress"
                          title={`Watched ${Math.round(pct)}% · Resumes at ${formatDuration(entry.position)}`}
                        >
                          <i style={{ width: `${pct}%` }} />
                        </div>
                      ) : null
                    }
                    actions={
                      <>
                        <VideoOptions video={entry} label="Video options" />
                        <button
                          className="icon-btn icon-btn--sm"
                          aria-label={`Remove "${entry.title}" from history`}
                          onClick={() => void remove(entry.videoId)}
                        >
                          <Icon name="close" size={18} />
                        </button>
                      </>
                    }
                  >
                    <ChannelLine
                      name={entry.author}
                      channelId={entry.authorId ?? null}
                      avatar={entry.authorAvatar ?? null}
                    />
                    <div className="list-row__meta">
                      {entry.viewCount != null && <span>{formatCount(entry.viewCount)} views</span>}
                      {formatVideoPublished(entry) && <span>{formatVideoPublished(entry)}</span>}
                      <span>Watched {formatRelative(entry.watchedAt)}</span>
                      {entry.position > 0 && hasDuration && (
                        <span
                          className="list-row__resume-pill"
                          title={`Playback resumes at ${formatDuration(entry.position)}`}
                        >
                          <Icon name="history" size={13} />
                          Resume at {formatDuration(entry.position)} ({Math.round(pct)}%)
                        </span>
                      )}
                    </div>
                  </ListRow>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
