import { useMemo, useState } from 'react'
import { Icon } from '../components/Icons'
import { ChannelLine } from '../components/ChannelLine'
import { InlineSearch } from '../components/InlineSearch'
import { EmptyState } from '../components/EmptyState'
import { ListRow } from '../components/ListRow'
import { VideoOptions } from '../components/VideoOptions'
import { formatDuration, formatRelative } from '../lib/format'
import { useApp } from '../state/AppContext'

export function HistoryPage(): React.JSX.Element {
  const { history, settings, refreshHistory, confirm, toast } = useApp()
  const [searchQuery, setSearchQuery] = useState('')

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
            <button className="btn btn--tonal" onClick={() => void clear()}>
              <Icon name="delete" size={18} />
              Clear all
            </button>
          </div>
        )}
      </div>

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
          <ul className="list">
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
        </div>
      )}
    </div>
  )
}
