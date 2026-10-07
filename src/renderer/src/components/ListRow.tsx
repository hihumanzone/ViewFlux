import { memo, useMemo, type ReactNode } from 'react'
import { formatDuration, safeText } from '../lib/format'
import { navigate, routeLinkProps } from '../lib/router'
import { useApp } from '../state/AppContext'

export interface ListRowProps {
  /** Hash route the row opens, e.g. `#/watch/<id>` or `#/watch/<id>?list=<id>`. */
  to: string
  thumbnail: string
  title: string
  /** Video id when known. If omitted, it is inferred from `to`. */
  videoId?: string
  /** Rendered under the title — channel line, stats, resume pill. */
  children?: ReactNode
  duration?: number | null
  /** Live broadcast badge. */
  isLive?: boolean
  /** Upcoming or past premiere badge. */
  isPremiere?: boolean
  /**
   * Nudges the duration badge clear of a progress bar drawn along the bottom
   * edge of the thumbnail.
   */
  hasProgress?: boolean
  /** Drawn over the thumbnail above the duration badge, e.g. a watch-progress bar. */
  thumbnailOverlay?: ReactNode
  /** Whether to render a 1:1 square thumbnail (used for music tracks / albums). */
  thumbSquare?: boolean
  /** Trailing controls: overflow menus, reorder and remove buttons. */
  actions?: ReactNode
}

/**
 * A single row in a vertical video list (watch history, local playlists,
 * synced YouTube playlists).
 *
 * The whole row is clickable through a stretched link on the title rather
 * than a `onClick` on a `<div>`, so it is a single tab stop with real link
 * semantics, and keyboard users get the same target as mouse users. Nested
 * controls (the channel button, the trailing actions) are lifted above the
 * stretched link by CSS so they stay clickable.
 */
export const ListRow = memo(function ListRow({
  to,
  thumbnail,
  title,
  videoId,
  children,
  duration = null,
  isLive,
  isPremiere,
  hasProgress,
  thumbnailOverlay,
  thumbSquare,
  actions
}: ListRowProps): React.JSX.Element {
  const { getHistoryEntry } = useApp()
  const hasDuration = duration != null && duration > 0

  const resolvedVideoId = useMemo(() => {
    if (videoId) return videoId
    const idx = to.indexOf('#/watch/')
    if (idx !== -1) {
      const rest = to.slice(idx + 8)
      const end = rest.search(/[?&#]/)
      return end === -1 ? rest : rest.slice(0, end)
    }
    return null
  }, [videoId, to])

  const historyProgress = useMemo(() => {
    if (thumbnailOverlay !== undefined || !resolvedVideoId) return null
    const match = getHistoryEntry(resolvedVideoId)
    if (!match || match.position <= 0) return null
    const dur = match.duration || duration
    if (!dur || dur <= 0) return null
    const pct = Math.min(100, Math.max(0, (match.position / dur) * 100))
    return {
      percent: pct,
      position: match.position
    }
  }, [thumbnailOverlay, resolvedVideoId, getHistoryEntry, duration])

  const effectiveHasProgress =
    hasProgress ?? (historyProgress != null && historyProgress.percent > 0)

  const effectiveOverlay =
    thumbnailOverlay ??
    (effectiveHasProgress && historyProgress ? (
      <div
        className="video-card__progress"
        title={`Watched ${Math.round(historyProgress.percent)}% · Resumes at ${formatDuration(historyProgress.position)}`}
      >
        <i style={{ width: `${historyProgress.percent}%` }} />
      </div>
    ) : null)

  const onRowClick = (event: React.MouseEvent<HTMLLIElement>): void => {
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, .menu, [role="menu"]')) return
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    navigate(to)
  }

  const isEndedPremiere =
    Boolean(isPremiere) && !isLive && duration != null && duration > 0

  return (
    <li
      className={`list-row${thumbSquare ? ' list-row--square-thumb' : ''}`}
      onClick={onRowClick}
    >
      <div className="list-row__thumb-wrap">
        <img className="list-row__thumb" src={thumbnail} alt="" loading="lazy" />
        {isEndedPremiere && (
          <div className="video-card__top-badge">
            <span className="badge badge--premiere">Premiere</span>
          </div>
        )}
        {effectiveOverlay}
        {isLive ? (
          <span className="badge badge--live">LIVE</span>
        ) : isPremiere && !isEndedPremiere ? (
          <span className="badge badge--premiere">PREMIERE</span>
        ) : hasDuration ? (
          <span
            className={
              effectiveHasProgress
                ? 'badge list-row__duration list-row__duration--raised'
                : 'badge list-row__duration'
            }
          >
            {formatDuration(duration)}
          </span>
        ) : null}
      </div>
      <div className="list-row__body">
        <a className="list-row__title" {...routeLinkProps(to)}>
          {safeText(title)}
        </a>
        {children}
      </div>
      {actions && <div className="list-row__actions">{actions}</div>}
    </li>
  )
})
