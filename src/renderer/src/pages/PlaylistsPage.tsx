import { useEffect, useState } from 'react'
import { Icon } from '../components/Icons'
import { Dialog } from '../components/Dialog'
import { EmptyState } from '../components/EmptyState'
import { Menu, MenuItem } from '../components/Menu'
import { OverflowButton } from '../components/OverflowButton'
import { navigate } from '../lib/router'
import { useCopyLink, playlistUrl } from '../lib/copyLink'
import { activationProps } from '../lib/keyboard'
import { useApp } from '../state/AppContext'
import type { Playlist } from '../../../shared/types'

const isYouTube = (playlist: Playlist): boolean => playlist.kind === 'youtube'

export function PlaylistsPage(): React.JSX.Element {
  const { playlists, refreshPlaylists, confirm, toast } = useApp()
  const copyLink = useCopyLink()
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'rename'; playlist: Playlist } | null>(
    null
  )
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ playlist: Playlist; anchor: HTMLElement } | null>(null)

  useEffect(() => {
    if (dialog) setName(dialog.mode === 'rename' ? dialog.playlist.name : '')
  }, [dialog])

  const submit = async (): Promise<void> => {
    const value = name.trim()
    if (!value || busy || !dialog) return
    setBusy(true)
    try {
      if (dialog.mode === 'create') {
        await window.api.createPlaylist(value)
        toast(`Created “${value}”`)
      } else {
        await window.api.renamePlaylist(dialog.playlist.id, value)
      }
      await refreshPlaylists()
      setDialog(null)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (playlist: Playlist): Promise<void> => {
    setMenu(null)
    const youtube = isYouTube(playlist)
    const ok = await confirm(
      youtube
        ? `Remove “${playlist.name}” from your playlists? The playlist stays on YouTube.`
        : `Delete the playlist “${playlist.name}”?`,
      { confirmLabel: youtube ? 'Remove' : 'Delete', danger: true }
    )
    if (!ok) return
    await window.api.deletePlaylist(playlist.id)
    await refreshPlaylists()
    toast(youtube ? 'Removed from playlists' : 'Playlist deleted')
  }

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Playlists</h1>
          <p className="page__subtitle">
            Local bookmarks on this device, plus YouTube playlists that stay in sync.
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--filled" onClick={() => setDialog({ mode: 'create' })}>
            <Icon name="add" size={18} />
            New playlist
          </button>
        </div>
      </div>

      {playlists.length === 0 ? (
        <EmptyState
          icon="bookmark"
          title="No playlists yet"
          message="Create a playlist, then use the save option on any video — or save a YouTube playlist from its page."
        />
      ) : (
        <div className="playlist-grid">
          {playlists.map((playlist) => {
            const youtube = isYouTube(playlist)
            const active = menu?.playlist.id === playlist.id
            // YouTube playlists carry a thumbnail of their own; local ones show their first video.
            const thumb = youtube ? playlist.thumbnail : (playlist.videos[0]?.thumbnail ?? null)
            return (
              <div
                key={playlist.id}
                className={`playlist-card${youtube ? ' playlist-card--youtube' : ''}`}
                onClick={() => navigate(`#/playlist/${playlist.id}`)}
                {...activationProps(() => navigate(`#/playlist/${playlist.id}`))}
              >
                <div className="playlist-card__media">
                  {thumb ? (
                    <img className="playlist-card__thumb" src={thumb} alt="" loading="lazy" />
                  ) : (
                    <div className="playlist-card__icon">
                      <Icon name={youtube ? 'playlist' : 'bookmarkFilled'} size={44} />
                    </div>
                  )}

                  <span className={`playlist-card__kind${youtube ? '' : ' playlist-card__kind--local'}`}>
                    {youtube ? 'YouTube' : 'Local'}
                  </span>
                </div>

                <div className="playlist-card__body">
                  {/* The overflow trigger shares the title row but the title takes
                      all the slack, so the menu lands on the card's right edge —
                      the same spot playlist search results use. */}
                  <div className="playlist-card__title-row">
                    <div className="playlist-card__name">{playlist.name}</div>
                    <OverflowButton
                      className="playlist-card__menu"
                      label={`${playlist.name} options`}
                      icon="more"
                      onToggle={(trigger) =>
                        setMenu(active ? null : { playlist, anchor: trigger })
                      }
                    />
                  </div>
                  <div className="playlist-card__count">
                    <Icon name={youtube ? 'play' : 'bookmarkFilled'} size={13} />
                    {youtube
                      ? (playlist.countText ?? 'YouTube playlist')
                      : `${playlist.videos.length} ${playlist.videos.length === 1 ? 'video' : 'videos'}`}
                  </div>
                </div>

                <Menu
                  anchor={active ? menu.anchor : null}
                  open={active}
                  onClose={() => setMenu(null)}
                  align="end"
                >
                  {youtube ? (
                    <>
                      <MenuItem
                        icon="link"
                        label="Copy link"
                        hint="YouTube"
                        onSelect={() => {
                          setMenu(null)
                          copyLink(playlistUrl(playlist.youtubeId ?? playlist.id))
                        }}
                      />
                      <MenuItem
                        icon="delete"
                        label="Remove from playlists"
                        danger
                        onSelect={() => void remove(playlist)}
                      />
                    </>
                  ) : (
                    <>
                      <MenuItem
                        icon="tune"
                        label="Rename"
                        onSelect={() => {
                          setMenu(null)
                          setDialog({ mode: 'rename', playlist })
                        }}
                      />
                      <MenuItem
                        icon="delete"
                        label="Delete"
                        danger
                        onSelect={() => void remove(playlist)}
                      />
                    </>
                  )}
                </Menu>
              </div>
            )
          })}
        </div>
      )}

      {dialog && (
        <Dialog
          title={dialog.mode === 'create' ? 'New playlist' : 'Rename playlist'}
          onClose={() => setDialog(null)}
          initialFocus="auto"
        >
          <div className="modal__field">
            <input
              className="input"
              autoFocus
              aria-label="Playlist name"
              placeholder="Playlist name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
            />
          </div>
          <div className="modal__actions">
            <button type="button" className="btn btn--text" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--filled"
              disabled={!name.trim() || busy}
              onClick={() => void submit()}
            >
              {dialog.mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
