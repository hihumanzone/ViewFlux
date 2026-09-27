import { useState } from 'react'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { useApp } from '../state/AppContext'
import type { Playlist, PlaylistVideo } from '../../../shared/types'

/**
 * Modal that lets the user add a video to one of their local playlists.
 * Toggling an existing entry removes it, so the same dialog doubles as a
 * quick "manage membership" view.
 */
export function AddToPlaylistDialog({
  video,
  onClose
}: {
  video: PlaylistVideo
  onClose: () => void
}): React.JSX.Element {
  const { playlists, refreshPlaylists, toast } = useApp()
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  // YouTube playlists are read-only references, so only local ones can be edited here.
  const localPlaylists = playlists.filter((p) => p.kind !== 'youtube')
  const savedElsewhere = playlists.length - localPlaylists.length

  const isMember = (playlist: Playlist): boolean =>
    playlist.videos.some((v) => v.videoId === video.videoId)

  const toggle = async (playlist: Playlist): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (isMember(playlist)) {
        await window.api.removeFromPlaylist(playlist.id, video.videoId)
      } else {
        await window.api.addToPlaylist(playlist.id, video)
        toast(`Added to “${playlist.name}”`)
      }
      await refreshPlaylists()
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      const created = await window.api.createPlaylist(name)
      await window.api.addToPlaylist(created.id, video)
      await refreshPlaylists()
      setNewName('')
      toast(`Added to “${created.name}”`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Add to playlist" onClose={onClose} initialFocus="auto">
      <p className="modal__message modal__message--tight">{video.title}</p>

      {localPlaylists.length > 0 && (
        <div className="modal__list">
          {localPlaylists.map((playlist) => {
            const member = isMember(playlist)
            return (
              <button
                key={playlist.id}
                type="button"
                className="modal__list-item"
                data-on={member || undefined}
                aria-pressed={member}
                onClick={() => void toggle(playlist)}
              >
                <span className="modal__list-item-name">{playlist.name}</span>
                <span className="modal__list-item-count">
                  {playlist.videos.length} {playlist.videos.length === 1 ? 'video' : 'videos'}
                </span>
                <span className="modal__check" data-on={member || undefined} aria-hidden="true">
                  {member && <Icon name="check" size={14} />}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {localPlaylists.length === 0 && (
        <p className="modal__hint">No local playlists yet — create one below.</p>
      )}

      {savedElsewhere > 0 && (
        <p className="modal__hint">
          {savedElsewhere} saved YouTube {savedElsewhere === 1 ? 'playlist is' : 'playlists are'}{' '}
          kept in sync and can’t be edited here.
        </p>
      )}

      <div className="modal__field">
        <input
          className="input"
          aria-label="New playlist name"
          placeholder="New playlist name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
          }}
        />
      </div>

      <div className="modal__actions">
        <button className="btn btn--text" onClick={onClose}>
          Done
        </button>
        <button
          type="button"
          className="btn btn--filled"
          disabled={!newName.trim() || busy}
          onClick={() => void create()}
        >
          <Icon name="add" size={18} />
          Create &amp; add
        </button>
      </div>
    </Dialog>
  )
}
