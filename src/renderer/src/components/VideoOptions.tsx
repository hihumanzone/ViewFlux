import { useState } from 'react'
import { Menu, MenuItem } from './Menu'
import { OverflowButton } from './OverflowButton'
import { AddToPlaylistDialog } from './AddToPlaylistDialog'
import { useCopyLink, videoUrl } from '../lib/copyLink'
import { toPlaylistVideo } from '../lib/map'
import type { PlaylistVideo } from '../../../shared/types'

/**
 * The video fields {@link AddToPlaylistDialog} needs. Loosely typed so any
 * listing shape works — `VideoSummary`, `HistoryEntry` and `PlaylistVideo`
 * are all accepted as-is, no per-call-site conversion required.
 */
type VideoLike = Pick<PlaylistVideo, 'videoId' | 'title' | 'author' | 'thumbnail'> &
  Partial<Omit<PlaylistVideo, 'videoId' | 'title' | 'author' | 'thumbnail'>>

/**
 * Three-dots overflow menu for a single video. Owns its own anchor and dialog
 * state so every card and row in the app can simply render `<VideoOptions />`
 * and get the same "Save to playlist" affordance.
 */
export function VideoOptions({
  video,
  className,
  label = 'Video options'
}: {
  video: VideoLike
  /** Extra classes so callers can position the trigger (e.g. a card corner). */
  className?: string
  label?: string
}): React.JSX.Element {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [addVideo, setAddVideo] = useState<PlaylistVideo | null>(null)
  const copyLink = useCopyLink()

  // The dialog needs a full `PlaylistVideo`; `toPlaylistVideo` is the same
  // conversion every other save path uses.
  const open = (): void => setAddVideo(toPlaylistVideo(video))

  return (
    <>
      <OverflowButton
        label={label}
        className={['video-options', className].filter(Boolean).join(' ')}
        onToggle={(trigger) => setMenuAnchor((anchor) => (anchor ? null : trigger))}
      />

      <Menu anchor={menuAnchor} open={menuAnchor != null} onClose={() => setMenuAnchor(null)} align="end">
        <MenuItem
          icon="bookmark"
          label="Save to playlist"
          onSelect={() => {
            setMenuAnchor(null)
            open()
          }}
        />
        <MenuItem
          icon="link"
          label="Copy link"
          onSelect={() => {
            setMenuAnchor(null)
            copyLink(videoUrl(video.videoId))
          }}
        />
      </Menu>

      {addVideo && <AddToPlaylistDialog video={addVideo} onClose={() => setAddVideo(null)} />}
    </>
  )
}
