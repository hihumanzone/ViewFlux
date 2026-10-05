import { useCallback, useMemo, useState } from 'react'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { SelectField, type SelectOption } from './SelectField'
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

export function RandomChannelDialog({
  onClose,
  initialFolder = 'all',
  initialLabel = 'all',
  initialFavoritesOnly = false
}: RandomChannelDialogProps): React.JSX.Element {
  const { savedChannels, channelFolders } = useApp()

  const [selectedFolder, setSelectedFolder] = useState<string>(initialFolder)
  const [selectedLabel, setSelectedLabel] = useState<string>(initialLabel)
  const [favoritesOnly, setFavoritesOnly] = useState<boolean>(initialFavoritesOnly)
  const [rollKey, setRollKey] = useState(0)

  // Collect all unique labels
  const allLabels = useMemo(() => {
    const set = new Set<string>()
    for (const channel of savedChannels) {
      for (const label of channel.labels ?? []) set.add(label)
    }
    return Array.from(set).sort()
  }, [savedChannels])

  // Folder dropdown options
  const folderOptions = useMemo<SelectOption<string>[]>(
    () => [
      {
        value: 'all',
        label: `All folders (${savedChannels.length})`,
        icon: 'folder'
      },
      ...channelFolders.map((folder) => {
        const count = savedChannels.filter((c) => c.folderId === folder.id).length
        return {
          value: folder.id,
          label: `${folder.name} (${count})`,
          icon: 'folder' as const
        }
      })
    ],
    [channelFolders, savedChannels]
  )

  // Label dropdown options
  const labelOptions = useMemo<SelectOption<string>[]>(
    () => [
      {
        value: 'all',
        label: `All labels (${allLabels.length > 0 ? savedChannels.length : 'none'})`,
        icon: 'label'
      },
      ...allLabels.map((label) => {
        const count = savedChannels.filter((c) => (c.labels ?? []).includes(label)).length
        return {
          value: label,
          label: `#${label} (${count})`,
          icon: 'label' as const
        }
      })
    ],
    [allLabels, savedChannels]
  )

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

  const filterChannels = useCallback(
    (folder: string, label: string, favOnly: boolean): SavedChannel[] => {
      return savedChannels.filter((c) => {
        if (folder !== 'all' && c.folderId !== folder) return false
        if (label !== 'all' && !(c.labels ?? []).includes(label)) return false
        if (favOnly && !c.isFavorite) return false
        return true
      })
    },
    [savedChannels]
  )

  const matchingChannels = useMemo(
    () => filterChannels(selectedFolder, selectedLabel, favoritesOnly),
    [filterChannels, selectedFolder, selectedLabel, favoritesOnly]
  )

  const [pickedChannel, setPickedChannel] = useState<SavedChannel | null>(() => {
    const initialList = savedChannels.filter((c) => {
      if (initialFolder !== 'all' && c.folderId !== initialFolder) return false
      if (initialLabel !== 'all' && !(c.labels ?? []).includes(initialLabel)) return false
      if (initialFavoritesOnly && !c.isFavorite) return false
      return true
    })
    return pickRandom(initialList)
  })

  const handleFolderChange = (nextFolder: string): void => {
    setSelectedFolder(nextFolder)
    const nextList = filterChannels(nextFolder, selectedLabel, favoritesOnly)
    setPickedChannel(pickRandom(nextList))
    setRollKey((k) => k + 1)
  }

  const handleLabelChange = (nextLabel: string): void => {
    setSelectedLabel(nextLabel)
    const nextList = filterChannels(selectedFolder, nextLabel, favoritesOnly)
    setPickedChannel(pickRandom(nextList))
    setRollKey((k) => k + 1)
  }

  const handleFavoritesToggle = (): void => {
    const nextFav = !favoritesOnly
    setFavoritesOnly(nextFav)
    const nextList = filterChannels(selectedFolder, selectedLabel, nextFav)
    setPickedChannel(pickRandom(nextList))
    setRollKey((k) => k + 1)
  }

  const handleReroll = (): void => {
    setPickedChannel(pickRandom(matchingChannels, pickedChannel?.channelId))
    setRollKey((k) => k + 1)
  }

  const handleOpenChannel = (channelId: string): void => {
    onClose()
    navigate(`#/channel/${channelId}`)
  }

  const matchedFolder = channelFolders.find((f) => f.id === pickedChannel?.folderId)

  return (
    <Dialog
      title="Random Channel"
      onClose={onClose}
      className="random-channel-dialog"
    >
      <p className="modal__message">
        Choose your scope criteria and discover a random channel from your saved bookmarks.
      </p>

      {/* Scope selection section */}
      <div className="random-scope-section">
        <div className="random-scope-grid">
          <div className="random-scope-field">
            <span className="random-scope-label">Folder</span>
            <SelectField
              value={selectedFolder}
              options={folderOptions}
              onSelect={handleFolderChange}
              align="start"
              size="md"
              ariaLabel="Filter by folder"
              className="dialog-select"
            />
          </div>

          <div className="random-scope-field">
            <span className="random-scope-label">Label</span>
            <SelectField
              value={selectedLabel}
              options={labelOptions}
              onSelect={handleLabelChange}
              align="start"
              size="md"
              ariaLabel="Filter by label"
              className="dialog-select"
            />
          </div>
        </div>

        <div className="random-scope-toggle-row">
          <button
            type="button"
            role="checkbox"
            aria-checked={favoritesOnly}
            className="random-scope-checkbox-btn"
            onClick={handleFavoritesToggle}
          >
            <span
              className={`checkbox${favoritesOnly ? ' checkbox--on' : ''}`}
              aria-hidden="true"
            >
              {favoritesOnly && <Icon name="check" size={16} />}
            </span>
            <span className="random-scope-checkbox-text">
              <Icon name="starFilled" size={15} className="random-scope-star-icon" />
              Favorites only
            </span>
          </button>

          <span className="random-scope-count-badge">
            {matchingChannels.length} {matchingChannels.length === 1 ? 'channel' : 'channels'} available
          </span>
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
            <p>No saved channels match the selected criteria.</p>
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
