import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icons'
import { InlineSearch } from '../components/InlineSearch'
import { SelectField, type SelectOption } from '../components/SelectField'
import { VideoCard } from '../components/VideoCard'
import { BookmarkChannelDialog } from '../components/BookmarkChannelDialog'
import { EmptyState } from '../components/EmptyState'
import { navigate } from '../lib/router'
import { useApp } from '../state/AppContext'
import { activationProps } from '../lib/keyboard'
import type { VideoSummary, SavedChannel } from '../../../shared/types'

const RECENCY_OPTIONS: { id: number; label: string }[] = [
  { id: 1, label: 'Past 24 hours' },
  { id: 2, label: 'Past 48 hours' },
  { id: 7, label: 'Past week' },
  { id: 14, label: 'Past 2 weeks' },
  { id: 30, label: 'Past month' },
  { id: 90, label: 'Past 3 months' },
  { id: 0, label: 'All recent' },
]

type SavedTab = 'feed' | 'channels'

const TABS: SavedTab[] = ['feed', 'channels']

export function SavedChannelsPage({ initialTab }: { initialTab?: string | null }): React.JSX.Element {
  const {
    savedChannels,
    channelFolders,
    createChannelFolder,
    renameChannelFolder,
    deleteChannelFolder,
    confirm,
    toast,
  } = useApp()

  // Tab lives in the URL so it survives a reload and Back steps out of it,
  // matching how channel tabs behave. Anything unrecognised falls back to feed.
  const [activeTab, setActiveTab] = useState<SavedTab>(
    TABS.includes(initialTab as SavedTab) ? (initialTab as SavedTab) : 'feed'
  )
  useEffect(() => {
    setActiveTab(TABS.includes(initialTab as SavedTab) ? (initialTab as SavedTab) : 'feed')
  }, [initialTab])
  const selectTab = useCallback((next: SavedTab) => {
    setActiveTab(next)
    navigate(`#/channels?tab=${next}`)
  }, [])

  // Feed state
  const [selectedFolderId, setSelectedFolderId] = useState<string | 'all'>('all')
  const [selectedLabel, setSelectedLabel] = useState<string | 'all'>('all')
  const [recencyDays, setRecencyDays] = useState<number>(7)
  const [feedVideos, setFeedVideos] = useState<VideoSummary[]>([])
  const [feedLoading, setFeedLoading] = useState(false)
  /** Channels fetched so far / total, driven by the `channels:feed-progress` event. */
  const [feedProgress, setFeedProgress] = useState<{
    done: number
    total: number
  } | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)

  // Channels management state
  const [channelSearchQuery, setChannelSearchQuery] = useState('')
  const [selectedChannelsFolder, setSelectedChannelsFolder] = useState<string | 'all'>('all')
  const [editingChannel, setEditingChannel] = useState<SavedChannel | null>(null)
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editFolderName, setEditFolderName] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)

  // Collect all unique labels
  const allLabels = useMemo(() => {
    const set = new Set<string>()
    for (const ch of savedChannels) {
      for (const l of ch.labels) set.add(l)
    }
    return Array.from(set).sort()
  }, [savedChannels])

  // Dropdown options for the feed filters
  const folderOptions = useMemo<SelectOption<string>[]>(
    () => [
      {
        value: 'all',
        label: `All Folders (${savedChannels.length})`,
        icon: 'folder',
      },
      ...channelFolders.map((f) => {
        const count = savedChannels.filter((c) => c.folderId === f.id).length
        return {
          value: f.id,
          label: `${f.name} (${count})`,
          icon: 'folder' as const,
        }
      }),
    ],
    [channelFolders, savedChannels],
  )

  const labelOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: 'all', label: 'All Labels', icon: 'label' },
      ...allLabels.map((l) => ({
        value: l,
        label: `#${l}`,
        icon: 'label' as const,
      })),
    ],
    [allLabels],
  )

  const recencyOptions = useMemo<SelectOption<number>[]>(
    () =>
      // A calendar reads as "uploaded within this date range"; the old stopwatch
      // looked like an elapsed-time measurement.
      RECENCY_OPTIONS.map((opt) => ({
        value: opt.id,
        label: opt.label,
        icon: 'calendar' as const,
      })),
    [],
  )

  // Filter channels according to scope for feed
  const feedChannelIds = useMemo(() => {
    let list = savedChannels
    if (selectedFolderId !== 'all') {
      list = list.filter((c) => c.folderId === selectedFolderId)
    }
    if (selectedLabel !== 'all') {
      list = list.filter((c) => c.labels.includes(selectedLabel))
    }
    return list.map((c) => c.channelId)
  }, [savedChannels, selectedFolderId, selectedLabel])

  // Fetch feed on demand
  const loadFeed = useCallback(async () => {
    if (feedChannelIds.length === 0) {
      setFeedVideos([])
      setFeedLoading(false)
      setFeedProgress(null)
      return
    }
    setFeedLoading(true)
    setFeedError(null)
    // Each fetch gets its own id. The main process tags every progress event
    // with it, so a stale bar from an earlier request can never land on top of
    // the current one (switching folders mid-fetch would otherwise do that).
    const requestId = `feed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const unsubscribe = window.api.onFeedProgress(requestId, (done, total) => {
      setFeedProgress({ done, total })
    })
    try {
      const videos = await window.api.getSavedChannelsFeed(
        feedChannelIds,
        recencyDays > 0 ? recencyDays : undefined,
        requestId,
      )
      setFeedVideos(videos)
      setLastFetchedAt(Date.now())
    } catch (err: unknown) {
      setFeedError(err instanceof Error ? err.message : String(err))
    } finally {
      unsubscribe()
      setFeedProgress(null)
      setFeedLoading(false)
    }
  }, [feedChannelIds, recencyDays])

  useEffect(() => {
    if (activeTab === 'feed') {
      void loadFeed()
    }
  }, [activeTab, loadFeed])

  // Channels tab filtering
  const filteredChannels = useMemo(() => {
    let list = savedChannels
    if (selectedChannelsFolder !== 'all') {
      list = list.filter((c) => c.folderId === selectedChannelsFolder)
    }
    const q = channelSearchQuery.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          (c.handle && c.handle.toLowerCase().includes(q)) ||
          c.labels.some((l) => l.toLowerCase().includes(q)),
      )
    }
    return list
  }, [savedChannels, selectedChannelsFolder, channelSearchQuery])

  const handleCreateFolder = async (): Promise<void> => {
    const name = newFolderName.trim()
    if (!name) return
    await createChannelFolder(name)
    setNewFolderName('')
    setCreatingFolder(false)
    toast(`Created folder “${name}”`)
  }

  const handleRenameFolder = async (id: string): Promise<void> => {
    const name = editFolderName.trim()
    if (!name) return
    await renameChannelFolder(id, name)
    setEditingFolderId(null)
    setEditFolderName('')
    toast(`Renamed folder to “${name}”`)
  }

  const handleDeleteFolder = async (id: string, name: string): Promise<void> => {
    const ok = await confirm(
      `Delete folder “${name}”? Channels in this folder will not be deleted.`,
      {
        confirmLabel: 'Delete folder',
        danger: true,
      },
    )
    if (!ok) return
    await deleteChannelFolder(id)
    if (selectedFolderId === id) setSelectedFolderId('all')
    if (selectedChannelsFolder === id) setSelectedChannelsFolder('all')
    toast(`Folder “${name}” deleted`)
  }

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Saved Channels</h1>
          <p className="page__subtitle">
            Organize bookmarks in folders and browse on-demand recent uploads.
          </p>
        </div>
      </div>

      {/* Primary tabs */}
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'feed'}
          className={`tab${activeTab === 'feed' ? ' tab--active' : ''}`}
          onClick={() => selectTab('feed')}
        >
          <Icon name="history" size={18} />
          Recent Videos Feed
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'channels'}
          className={`tab${activeTab === 'channels' ? ' tab--active' : ''}`}
          onClick={() => selectTab('channels')}
        >
          <Icon name="folder" size={18} />
          Channels & Folders ({savedChannels.length})
        </button>
      </div>

      {/* FEED TAB */}
      {activeTab === 'feed' && (
        <div key="tab-feed" className="animate-fade-up">
          {/*
            Controls Bar. The bar hugs its content (`width: fit-content`) and the
            filters sit next to Refresh — the old flex spacer pinned the button to
            the far edge and left a big empty gap across the card.
          */}
          <div className="filter-bar">
            {/* Folder filter */}
            <div className="filter-bar__field">
              <span className="filter-bar__label">Folder</span>
              <SelectField
                value={selectedFolderId}
                options={folderOptions}
                onSelect={setSelectedFolderId}
                ariaLabel="Filter by folder"
                align="start"
                size="sm"
              />
            </div>

            {/* Label filter */}
            {allLabels.length > 0 && (
              <div className="filter-bar__field">
                <span className="filter-bar__label">Label</span>
                <SelectField
                  value={selectedLabel}
                  options={labelOptions}
                  onSelect={setSelectedLabel}
                  ariaLabel="Filter by label"
                  align="start"
                  size="sm"
                />
              </div>
            )}

            {/* Recency filter */}
            <div className="filter-bar__field">
              <span className="filter-bar__label">Uploaded</span>
              <SelectField
                value={recencyDays}
                options={recencyOptions}
                onSelect={setRecencyDays}
                ariaLabel="Filter by upload date"
                align="start"
                size="sm"
              />
            </div>

            {/* Refresh button */}
            <button
              type="button"
              className="btn btn--tonal btn--sm filter-bar__end"
              disabled={feedLoading || feedChannelIds.length === 0}
              onClick={() => void loadFeed()}
              title="Refresh recent videos feed"
            >
              <Icon name="refresh" size={16} />
              {feedLoading ? 'Fetching...' : 'Refresh'}
            </button>
          </div>

          {/* Feed Content */}
          {savedChannels.length === 0 ? (
            <EmptyState
              iconSize={32}
              icon="bookmark"
              title="No saved channels yet"
              message="Bookmark channels to create your customized, distraction-free video feed."
              action={
                <button
                  type="button"
                  className="btn btn--filled empty__action"
                  onClick={() => navigate('#/search')}
                >
                  Explore Channels
                </button>
              }
            />
          ) : feedChannelIds.length === 0 ? (
            <EmptyState
              iconSize={32}
              icon="folder"
              title="No channels in this view"
              message="No saved channels match the selected folder or label filter."
            />
          ) : feedLoading ? (
            <div className="feed-progress">
              {/* Determinate: the main process reports how many channels have
                  come back so far, so the bar reflects real work done. */}
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={feedProgress?.total ?? feedChannelIds.length}
                aria-valuenow={feedProgress?.done ?? 0}
                aria-label="Fetching recent videos"
              >
                <span
                  className="progress__bar"
                  style={{
                    width: `${
                      feedProgress && feedProgress.total > 0
                        ? Math.round((feedProgress.done / feedProgress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <div className="feed-progress__label">
                {feedProgress
                  ? `Fetched ${feedProgress.done} of ${feedProgress.total} channels`
                  : `Starting fetch across ${feedChannelIds.length} channels…`}
              </div>
            </div>
          ) : feedError ? (
            <div className="notice notice--error">
              <Icon name="close" size={18} />
              <span>Failed to fetch recent videos: {feedError}</span>
              <button className="btn btn--sm btn--text" onClick={() => void loadFeed()}>
                Retry
              </button>
            </div>
          ) : feedVideos.length === 0 ? (
            <EmptyState
              iconSize={32}
              icon="history"
              title="No videos found"
              message='None of the selected channels published videos in the selected time range. Try choosing a longer time frame like "Past month" or "All recent".'
            />
          ) : (
            <div key={`feed-${lastFetchedAt ?? 'init'}-${selectedFolderId}-${selectedLabel}`} className="animate-fade-up">
              <div className="feed-summary">
                Showing {feedVideos.length} recent uploads from {feedChannelIds.length} channels
                {lastFetchedAt ? ` · Updated ${new Date(lastFetchedAt).toLocaleTimeString()}` : ''}
              </div>
              <div className="video-grid">
                {feedVideos.map((video) => (
                  <VideoCard key={video.videoId} video={video} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* CHANNELS & FOLDERS TAB */}
      {activeTab === 'channels' && (
        <div key="tab-channels" className="stack animate-fade-up">
          {/* Folders. The heading and the cards share one row, so the label sits
              directly beside the strip instead of claiming a line of its own, and
              there is no full-width bordered shell to end in dead space. */}
          <div className="folder-section">
            <h2 className="section-head__title">
              <Icon name="folder" size={16} />
              Folders
            </h2>

            <div className="folder-row">
              <button
                type="button"
                className={`folder-card${selectedChannelsFolder === 'all' ? ' folder-card--active' : ''}`}
                aria-pressed={selectedChannelsFolder === 'all'}
                onClick={() => setSelectedChannelsFolder('all')}
              >
                <Icon name="queue" size={14} />
                <span className="folder-card__label">All Channels ({savedChannels.length})</span>
              </button>
              {channelFolders.map((f) => {
                const count = savedChannels.filter((c) => c.folderId === f.id).length
                const isSelected = selectedChannelsFolder === f.id
                return (
                  <div
                    className={`folder-card${isSelected ? ' folder-card--active' : ''}`}
                    key={f.id}
                  >
                    {editingFolderId === f.id ? (
                      <div className="folder-card__edit">
                        <input
                          type="text"
                          className="input input--sm"
                          autoFocus
                          value={editFolderName}
                          onChange={(e) => setEditFolderName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRenameFolder(f.id)
                            if (e.key === 'Escape') setEditingFolderId(null)
                          }}
                        />
                        <button
                          className="icon-btn icon-btn--sm"
                          title="Save name"
                          onClick={() => void handleRenameFolder(f.id)}
                        >
                          <Icon name="check" size={14} />
                        </button>
                        <button
                          className="icon-btn icon-btn--sm"
                          title="Cancel rename"
                          onClick={() => setEditingFolderId(null)}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="folder-card__select"
                          aria-pressed={isSelected}
                          onClick={() => setSelectedChannelsFolder(f.id)}
                        >
                          <Icon name="folder" size={14} />
                          {f.name} ({count})
                        </button>
                        {/* Actions live inside the card they belong to, laid out in
                          the flow, so they are never stranded in the row's gaps. */}
                        <span className="folder-card__actions">
                          <button
                            type="button"
                            className="icon-btn icon-btn--sm folder-card__action"
                            title="Rename folder"
                            aria-label={`Rename folder ${f.name}`}
                            onClick={() => {
                              setEditingFolderId(f.id)
                              setEditFolderName(f.name)
                            }}
                          >
                            <Icon name="edit" size={13} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn icon-btn--sm folder-card__action folder-card__action--danger"
                            title="Delete folder"
                            aria-label={`Delete folder ${f.name}`}
                            onClick={() => void handleDeleteFolder(f.id, f.name)}
                          >
                            <Icon name="delete" size={13} />
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                )
              })}

              {/* The create action trails the cards instead of sitting across an
                empty heading row, so the row never trails off into dead space. */}
              {!creatingFolder ? (
                <button
                  type="button"
                  className="btn btn--tonal btn--sm"
                  onClick={() => setCreatingFolder(true)}
                >
                  <Icon name="add" size={14} /> New Folder
                </button>
              ) : (
                <div className="folder-card__edit">
                  <input
                    type="text"
                    className="input input--sm"
                    placeholder="Folder name..."
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleCreateFolder()
                      if (e.key === 'Escape') setCreatingFolder(false)
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--filled btn--sm"
                    onClick={() => void handleCreateFolder()}
                    disabled={!newFolderName.trim()}
                  >
                    Create
                  </button>
                  <button
                    type="button"
                    className="btn btn--text btn--sm"
                    onClick={() => {
                      setCreatingFolder(false)
                      setNewFolderName('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Search bar inside channels tab */}
          <div className="toolbar-row">
            <InlineSearch
              value={channelSearchQuery}
              onChange={setChannelSearchQuery}
              placeholder="Search saved channels or labels..."
              ariaLabel="Search saved channels"
            />
            <div className="toolbar-row__count">
              {filteredChannels.length} {filteredChannels.length === 1 ? 'channel' : 'channels'}
            </div>
          </div>

          {/* Channels Grid / List */}
          {savedChannels.length === 0 ? (
            <EmptyState
              iconSize={32}
              icon="bookmark"
              title="No saved channels yet"
              message='When you visit a channel, click the "Bookmark channel" button to save and organize it here.'
            />
          ) : filteredChannels.length === 0 ? (
            <EmptyState
              iconSize={32}
              icon="search"
              title="No matching channels"
              message="No bookmarked channels match your search."
            />
          ) : (
            <div className="saved-grid">
              {filteredChannels.map((channel) => {
                const folder = channelFolders.find((f) => f.id === channel.folderId)
                return (
                  <div
                    className="saved-channel"
                    key={channel.channelId}
                    title={`Open ${channel.title}`}
                    onClick={() => navigate(`#/channel/${channel.channelId}`)}
                    {...activationProps(() => navigate(`#/channel/${channel.channelId}`))}
                  >
                    <div className="saved-channel__avatar" aria-hidden="true">
                      {channel.avatar ? (
                        <img src={channel.avatar} alt="" />
                      ) : (
                        <span className="saved-channel__initial">
                          {channel.title.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </div>

                    <div className="saved-channel__body">
                      <div className="saved-channel__name">
                        {channel.title}
                      </div>
                      {channel.handle && (
                        <div className="saved-channel__handle">{channel.handle}</div>
                      )}

                      <div className="saved-channel__tags">
                        {folder && (
                          <span className="tag tag--folder">
                            <Icon name="folder" size={12} />
                            {folder.name}
                          </span>
                        )}
                        {channel.labels.map((l) => (
                          <span className="tag tag--label" key={l}>
                            <Icon name="label" size={12} />
                            {l}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="saved-channel__actions">
                      <button
                        type="button"
                        className="icon-btn icon-btn--sm"
                        title="Edit bookmark folder and labels"
                        aria-label={`Edit bookmark for ${channel.title}`}
                        onClick={(e) => {
                          // The card itself opens the channel, so keep this
                          // action from bubbling into a navigation.
                          e.stopPropagation()
                          setEditingChannel(channel)
                        }}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Bookmark edit dialog */}
      {editingChannel && (
        <BookmarkChannelDialog
          channelId={editingChannel.channelId}
          title={editingChannel.title}
          handle={editingChannel.handle}
          avatar={editingChannel.avatar}
          onClose={() => setEditingChannel(null)}
        />
      )}
    </div>
  )
}
