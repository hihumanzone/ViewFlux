import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { useBrokenImage } from '../lib/useBrokenImage'
import { navigate } from '../lib/router'
import { activationProps } from '../lib/keyboard'
import { useApp } from '../state/AppContext'
import type { SavedChannel } from '../../../shared/types'

interface RandomChannelDialogProps {
  onClose: () => void
  initialFolder?: string
  initialLabel?: string
  initialFavoritesOnly?: boolean
}

interface ScopeItem {
  id: string
  label: string
  count: number
  icon: 'folder' | 'label'
}

function ChannelResultCard({
  channel,
  folderName,
  onOpen
}: {
  channel: SavedChannel
  folderName?: string
  onOpen: () => void
}): React.JSX.Element {
  const { broken: avatarBroken, onError: onAvatarError } = useBrokenImage(channel.avatar)

  return (
    <div
      className="saved-channel random-channel__card animate-scale-in"
      title={`Open ${channel.title}`}
      aria-label={`Open channel ${channel.title}`}
      onClick={onOpen}
      {...activationProps(onOpen)}
    >
      <div className="saved-channel__avatar" aria-hidden="true">
        {channel.avatar && !avatarBroken ? (
          <img src={channel.avatar} alt="" onError={onAvatarError} />
        ) : (
          <span className="saved-channel__initial">
            {channel.title.slice(0, 1).toUpperCase()}
          </span>
        )}
      </div>

      <div className="saved-channel__body">
        <div className="saved-channel__name">{channel.title}</div>
        {channel.handle && <div className="saved-channel__handle">{channel.handle}</div>}

        <div className="saved-channel__tags">
          {channel.isFavorite && (
            <span className="tag tag--favorite" title="Favorite channel">
              <Icon name="starFilled" size={12} />
              Favorite
            </span>
          )}
          {folderName && (
            <span className="tag tag--folder">
              <Icon name="folder" size={12} />
              {folderName}
            </span>
          )}
          {(channel.labels ?? []).map((label) => (
            <span className="tag tag--label" key={label}>
              <Icon name="label" size={12} />
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="random-channel__open-hint" aria-hidden="true">
        <Icon name="chevronRight" size={20} />
      </div>
    </div>
  )
}

function ScopeCheckboxChip({
  label,
  count,
  isTicked,
  onClick
}: {
  label: string
  count: number
  isTicked: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`inline-scope-chip${isTicked ? ' inline-scope-chip--ticked' : ''}`}
      onClick={onClick}
      role="checkbox"
      aria-checked={isTicked}
      title={isTicked ? `Included: ${label} (click to exclude)` : `Excluded: ${label} (click to include)`}
    >
      <span className={`checkbox${isTicked ? ' checkbox--on' : ''}`} aria-hidden="true">
        {isTicked && <Icon name="check" size={13} />}
      </span>
      <span className="inline-scope-chip__text">{label}</span>
      <span className="inline-scope-chip__count">({count})</span>
    </button>
  )
}

export function RandomChannelDialog({
  onClose,
  initialFolder = 'all',
  initialLabel = 'all',
  initialFavoritesOnly = false
}: RandomChannelDialogProps): React.JSX.Element {
  const { savedChannels, channelFolders } = useApp()

  // Collect all unique labels
  const allLabels = useMemo(() => {
    const set = new Set<string>()
    for (const channel of savedChannels) {
      for (const label of channel.labels ?? []) set.add(label)
    }
    return Array.from(set).sort()
  }, [savedChannels])

  // Count uncategorized channels
  const uncategorizedCount = useMemo(() => {
    return savedChannels.filter((c) => !c.folderId).length
  }, [savedChannels])

  // Count unlabeled channels
  const unlabeledCount = useMemo(() => {
    return savedChannels.filter((c) => !c.labels || c.labels.length === 0).length
  }, [savedChannels])

  // Folder scope items
  const folderItems = useMemo<ScopeItem[]>(() => {
    const items: ScopeItem[] = channelFolders.map((folder) => {
      const count = savedChannels.filter((c) => c.folderId === folder.id).length
      return {
        id: folder.id,
        label: folder.name,
        count,
        icon: 'folder' as const
      }
    })

    if (uncategorizedCount > 0) {
      items.push({
        id: '__uncategorized__',
        label: 'Uncategorized (No folder)',
        count: uncategorizedCount,
        icon: 'folder' as const
      })
    }

    return items
  }, [channelFolders, savedChannels, uncategorizedCount])

  // Label scope items
  const labelItems = useMemo<ScopeItem[]>(() => {
    const items: ScopeItem[] = allLabels.map((label) => {
      const count = savedChannels.filter((c) => (c.labels ?? []).includes(label)).length
      return {
        id: label,
        label: `#${label}`,
        count,
        icon: 'label' as const
      }
    })

    if (unlabeledCount > 0) {
      items.push({
        id: '__unlabeled__',
        label: 'No labels assigned',
        count: unlabeledCount,
        icon: 'label' as const
      })
    }

    return items
  }, [allLabels, savedChannels, unlabeledCount])

  // Default state: ALL folders are selected by default
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(() => {
    if (initialFolder && initialFolder !== 'all') {
      return new Set([initialFolder])
    }
    const ids = channelFolders.map((f) => f.id)
    if (savedChannels.some((c) => !c.folderId)) {
      ids.push('__uncategorized__')
    }
    return new Set(ids)
  })

  // Default state: ALL labels are selected by default
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(() => {
    if (initialLabel && initialLabel !== 'all') {
      return new Set([initialLabel])
    }
    const labelSet = new Set<string>()
    for (const channel of savedChannels) {
      for (const l of channel.labels ?? []) labelSet.add(l)
    }
    if (savedChannels.some((c) => !c.labels || c.labels.length === 0)) {
      labelSet.add('__unlabeled__')
    }
    return labelSet
  })

  const [favoritesOnly, setFavoritesOnly] = useState<boolean>(initialFavoritesOnly)
  const [rollKey, setRollKey] = useState(0)

  // Random channel picker
  const pickRandom = useCallback(
    (list: SavedChannel[], currentId?: string | null): SavedChannel | null => {
      if (list.length === 0) return null
      if (list.length === 1) return list[0]

      const candidates = currentId ? list.filter((c) => c.channelId !== currentId) : list
      const pool = candidates.length > 0 ? candidates : list
      const idx = Math.floor(Math.random() * pool.length)
      return pool[idx]
    },
    []
  )

  // Matching channels evaluation:
  // Channel must match folder filter, label filter, and favorites filter
  const matchingChannels = useMemo(() => {
    return savedChannels.filter((channel) => {
      // 1. Favorites check
      if (favoritesOnly && !channel.isFavorite) {
        return false
      }

      // 2. Folder check:
      // Channel's folder key must be in selectedFolderIds
      const folderKey = channel.folderId || '__uncategorized__'
      if (!selectedFolderIds.has(folderKey)) {
        return false
      }

      // 3. Label check:
      // Channel must have at least one label in selectedLabels (or '__unlabeled__' if no labels)
      const chLabels = channel.labels ?? []
      if (chLabels.length === 0) {
        if (!selectedLabels.has('__unlabeled__')) {
          return false
        }
      } else {
        if (!chLabels.some((l) => selectedLabels.has(l))) {
          return false
        }
      }

      return true
    })
  }, [savedChannels, favoritesOnly, selectedFolderIds, selectedLabels])

  // Current picked channel
  const [pickedChannel, setPickedChannel] = useState<SavedChannel | null>(() => {
    return pickRandom(matchingChannels)
  })

  // Ensure pickedChannel is refreshed if it falls out of matchingChannels
  useEffect(() => {
    if (matchingChannels.length === 0) {
      if (pickedChannel !== null) setPickedChannel(null)
      return
    }
    if (!pickedChannel || !matchingChannels.some((c) => c.channelId === pickedChannel.channelId)) {
      setPickedChannel(pickRandom(matchingChannels))
      setRollKey((k) => k + 1)
    }
  }, [matchingChannels, pickedChannel, pickRandom])

  // Folder click handler: toggles tick state
  const handleFolderClick = (id: string): void => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // Folder "All" button: marks all folders as ticked
  const handleSelectAllFolders = (): void => {
    setSelectedFolderIds(new Set(folderItems.map((f) => f.id)))
  }

  // Folder "Clear" button: deselects all folders (all excluded)
  const handleClearFolders = (): void => {
    setSelectedFolderIds(new Set())
  }

  // Label click handler: toggles tick state
  const handleLabelClick = (id: string): void => {
    setSelectedLabels((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // Label "All" button: marks all labels as ticked
  const handleSelectAllLabels = (): void => {
    setSelectedLabels(new Set(labelItems.map((l) => l.id)))
  }

  // Label "Clear" button: deselects all labels (all excluded)
  const handleClearLabels = (): void => {
    setSelectedLabels(new Set())
  }

  // Global reset scope button: restores all folders and labels ticked, and favorites off
  const handleResetFilters = (): void => {
    setSelectedFolderIds(new Set(folderItems.map((f) => f.id)))
    setSelectedLabels(new Set(labelItems.map((l) => l.id)))
    setFavoritesOnly(false)
  }

  const handleReroll = (): void => {
    setPickedChannel(pickRandom(matchingChannels, pickedChannel?.channelId))
    setRollKey((k) => k + 1)
  }

  const handleOpenChannel = (channelId: string): void => {
    onClose()
    navigate(`#/channel/${channelId}`)
  }

  // Active filters check: only true if user has modified anything from the default "all" state
  const isAllFoldersSelected = folderItems.length > 0 && selectedFolderIds.size === folderItems.length
  const isAllLabelsSelected = labelItems.length === 0 || selectedLabels.size === labelItems.length
  const hasActiveFilters = !isAllFoldersSelected || !isAllLabelsSelected || favoritesOnly

  const matchedFolder = channelFolders.find((f) => f.id === pickedChannel?.folderId)

  return (
    <Dialog
      title="Random Channel"
      onClose={onClose}
      className="random-channel-dialog random-channel-dialog--simplified"
    >
      <p className="modal__message">
        Discover a random channel from your saved bookmarks. Filter your scope below by ticking the folders and categories to include.
      </p>

      {/* Scope Settings: All folders & categories selected by default */}
      <div className="inline-scope-card">
        {/* Scope Top Control Bar */}
        <div className="inline-scope-bar">
          <div className="inline-scope-bar__title-group">
            <span className="inline-scope-bar__title">Scope Settings</span>
            <span className="inline-scope-count-badge">
              {matchingChannels.length} {matchingChannels.length === 1 ? 'channel' : 'channels'} eligible
            </span>
          </div>

          <div className="inline-scope-bar__actions">
            <button
              type="button"
              role="checkbox"
              aria-checked={favoritesOnly}
              className={`inline-scope-fav-btn${favoritesOnly ? ' inline-scope-fav-btn--active' : ''}`}
              onClick={() => setFavoritesOnly((prev) => !prev)}
              title="Only pick channels marked as favorite"
            >
              <Icon name="starFilled" size={14} className="inline-scope-star-icon" />
              <span>Favorites only</span>
            </button>

            {hasActiveFilters && (
              <button
                type="button"
                className="inline-scope-reset-btn"
                onClick={handleResetFilters}
                title="Reset all filters back to default"
              >
                <Icon name="refresh" size={13} />
                <span>Reset scope</span>
              </button>
            )}
          </div>
        </div>

        {/* Folders Group */}
        <div className="inline-scope-group">
          <div className="inline-scope-group__header">
            <div className="inline-scope-group__label">
              <Icon name="folder" size={14} />
              <span>Folders</span>
              <span className="inline-scope-group__hint">
                {selectedFolderIds.size === folderItems.length
                  ? '(All folders included)'
                  : selectedFolderIds.size === 0
                    ? '(All folders excluded)'
                    : `(${selectedFolderIds.size} of ${folderItems.length} included)`}
              </span>
            </div>
            <div className="inline-scope-group__actions">
              <button
                type="button"
                className={`inline-scope-btn-sm${
                  selectedFolderIds.size === folderItems.length
                    ? ' inline-scope-btn-sm--active'
                    : ''
                }`}
                onClick={handleSelectAllFolders}
                title="Mark all folders as ticked"
              >
                All
              </button>
              <button
                type="button"
                className={`inline-scope-btn-sm${
                  selectedFolderIds.size === 0
                    ? ' inline-scope-btn-sm--active'
                    : ''
                }`}
                onClick={handleClearFolders}
                title="Deselect all folders"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="inline-scope-chips">
            {folderItems.map((item) => {
              const isTicked = selectedFolderIds.has(item.id)
              return (
                <ScopeCheckboxChip
                  key={item.id}
                  label={item.label}
                  count={item.count}
                  isTicked={isTicked}
                  onClick={() => handleFolderClick(item.id)}
                />
              )
            })}
          </div>
        </div>

        {/* Labels / Categories Group */}
        <div className="inline-scope-group">
          <div className="inline-scope-group__header">
            <div className="inline-scope-group__label">
              <Icon name="label" size={14} />
              <span>Labels / Categories</span>
              <span className="inline-scope-group__hint">
                {selectedLabels.size === labelItems.length
                  ? '(All labels included)'
                  : selectedLabels.size === 0
                    ? '(All labels excluded)'
                    : `(${selectedLabels.size} of ${labelItems.length} included)`}
              </span>
            </div>
            <div className="inline-scope-group__actions">
              <button
                type="button"
                className={`inline-scope-btn-sm${
                  selectedLabels.size === labelItems.length
                    ? ' inline-scope-btn-sm--active'
                    : ''
                }`}
                onClick={handleSelectAllLabels}
                disabled={labelItems.length === 0}
                title="Mark all labels as ticked"
              >
                All
              </button>
              <button
                type="button"
                className={`inline-scope-btn-sm${
                  selectedLabels.size === 0
                    ? ' inline-scope-btn-sm--active'
                    : ''
                }`}
                onClick={handleClearLabels}
                disabled={labelItems.length === 0}
                title="Deselect all labels"
              >
                Clear
              </button>
            </div>
          </div>

          {labelItems.length === 0 ? (
            <div className="inline-scope-empty">No labels or categories assigned to your saved channels yet.</div>
          ) : (
            <div className="inline-scope-chips">
              {labelItems.map((item) => {
                const isTicked = selectedLabels.has(item.id)
                return (
                  <ScopeCheckboxChip
                    key={item.id}
                    label={item.label}
                    count={item.count}
                    isTicked={isTicked}
                    onClick={() => handleLabelClick(item.id)}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Result Card area */}
      <div className="random-channel__result-area">
        {pickedChannel ? (
          <ChannelResultCard
            key={`${pickedChannel.channelId}-${rollKey}`}
            channel={pickedChannel}
            folderName={matchedFolder?.name}
            onOpen={() => handleOpenChannel(pickedChannel.channelId)}
          />
        ) : (
          <div className="random-channel__empty">
            <Icon name="search" size={26} />
            <p>No saved channels match the selected scope criteria.</p>
          </div>
        )}
      </div>

      {/* Dialog action buttons */}
      <div className="modal__actions random-channel__actions">
        {matchingChannels.length > 0 ? (
          <button
            type="button"
            className="btn btn--tonal"
            onClick={handleReroll}
            title="Pick another random channel from this scope"
          >
            <Icon name="shuffle" size={16} />
            Pick another
          </button>
        ) : (
          <div />
        )}

        <div className="random-channel__actions-end">
          <button type="button" className="btn btn--text" onClick={onClose}>
            Close
          </button>
          {pickedChannel && (
            <button
              type="button"
              className="btn btn--filled"
              onClick={() => handleOpenChannel(pickedChannel.channelId)}
            >
              <Icon name="play_arrow" size={16} />
              Open Channel
            </button>
          )}
        </div>
      </div>
    </Dialog>
  )
}
