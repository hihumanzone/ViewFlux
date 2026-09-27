import { useState } from 'react'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { SelectField } from './SelectField'
import { useBrokenImage } from '../lib/useBrokenImage'
import { useApp } from '../state/AppContext'

interface BookmarkChannelDialogProps {
  channelId: string
  title: string
  handle?: string | null
  avatar?: string | null
  onClose: () => void
}

export function BookmarkChannelDialog({
  channelId,
  title,
  handle,
  avatar,
  onClose
}: BookmarkChannelDialogProps): React.JSX.Element {
  const {
    savedChannels,
    channelFolders,
    saveChannel,
    removeSavedChannel,
    createChannelFolder,
    toast
  } = useApp()

  const existing = savedChannels.find((c) => c.channelId === channelId)
  const { broken: avatarBroken, onError: onAvatarError } = useBrokenImage(avatar)

  const [folderId, setFolderId] = useState<string | null>(existing?.folderId ?? null)
  const [labels, setLabels] = useState<string[]>(existing?.labels ?? [])
  const [newLabelText, setNewLabelText] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [busy, setBusy] = useState(false)

  const addLabel = (): void => {
    const trimmed = newLabelText.trim().replace(/^#/, '')
    if (trimmed && !labels.includes(trimmed)) {
      setLabels([...labels, trimmed])
      setNewLabelText('')
    }
  }

  const removeLabel = (label: string): void => {
    setLabels(labels.filter((l) => l !== label))
  }

  const handleSave = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      let finalFolderId = folderId
      if (creatingFolder && newFolderName.trim()) {
        const created = await createChannelFolder(newFolderName.trim())
        finalFolderId = created.id
      }

      await saveChannel({
        channelId,
        title,
        handle: handle ?? null,
        avatar: avatar ?? null,
        savedAt: existing?.savedAt ?? Date.now(),
        folderId: finalFolderId,
        labels
      })

      toast(existing ? `Updated bookmark for “${title}”` : `Bookmarked “${title}”`)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await removeSavedChannel(channelId)
      toast(`Removed “${title}” from bookmarks`)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      className="modal--wide"
      title={existing ? 'Edit Bookmark' : 'Bookmark Channel'}
      onClose={onClose}
    >
      <div className="dialog__header">
        {avatar && !avatarBroken ? (
          <img
            className="dialog__avatar"
            src={avatar}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={onAvatarError}
          />
        ) : (
          <div className="dialog__avatar dialog__avatar--fallback" aria-hidden="true">
            {title.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="dialog__header-body">
          <div className="dialog__subtitle">{title} {handle ? `(${handle})` : ''}</div>
        </div>
      </div>

      <p className="dialog__intro">
        Bookmarking lets you easily organize and browse channels without subscription
        tracking or notifications.
      </p>

      {/* Folder assignment */}
      <div className="dialog__field">
        <span className="dialog__label">Folder</span>
        {!creatingFolder ? (
          <div className="dialog__row">
            <SelectField
              value={folderId ?? ''}
              options={[
                { value: '', label: 'No folder (Uncategorized)', icon: 'folder' },
                ...channelFolders.map((f) => ({ value: f.id, label: f.name, icon: 'folder' as const }))
              ]}
              onSelect={(value) => setFolderId(value || null)}
              ariaLabel="Bookmark folder"
              className="dialog-select"
            />
            <button
              type="button"
              className="btn btn--tonal btn--sm"
              onClick={() => setCreatingFolder(true)}
              title="Create a new folder"
            >
              <Icon name="add" size={16} /> New
            </button>
          </div>
        ) : (
          <div className="dialog__row">
            <input
              type="text"
              className="input dialog__input"
              placeholder="Folder name..."
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                // The Dialog also listens for Escape, so stop it from closing
                // the whole dialog when it is only meant to cancel the new
                // folder field.
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleSave()
                }
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setCreatingFolder(false)
                }
              }}
            />
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

      {/* Labels / Categories */}
      <div className="dialog__field">
        <span className="dialog__label" id="bookmark-labels-label">
          Labels / Categories
        </span>
        <div className="dialog__chips" role="list" aria-labelledby="bookmark-labels-label">
          {labels.length === 0 ? (
            <span className="dialog__chips--empty">No labels assigned.</span>
          ) : (
            labels.map((l) => (
              <span className="dialog__chip" key={l} role="listitem">
                #{l}
                <button
                  type="button"
                  className="dialog__chip-remove"
                  aria-label={`Remove label ${l}`}
                  onClick={() => removeLabel(l)}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))
          )}
        </div>
        <div className="dialog__row">
          <input
            type="text"
            className="input dialog__input"
            placeholder="Add label (e.g. Tech, Music, Tutorials)..."
            value={newLabelText}
            onChange={(e) => setNewLabelText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addLabel()
              }
            }}
          />
          <button
            type="button"
            className="btn btn--tonal btn--sm"
            disabled={!newLabelText.trim()}
            onClick={addLabel}
          >
            Add
          </button>
        </div>
      </div>

      <div className="modal__actions modal__actions--split">
        {existing ? (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => void handleRemove()}
            disabled={busy}
          >
            <Icon name="delete" size={16} /> Remove
          </button>
        ) : (
          <div />
        )}
        <div className="modal__actions-group">
          <button type="button" className="btn btn--text" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--filled"
            onClick={() => void handleSave()}
            disabled={busy}
          >
            {existing ? 'Save Changes' : 'Bookmark'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
