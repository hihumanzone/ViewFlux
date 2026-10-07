import { memo } from 'react'
import { navigate } from '../lib/router'
import { safeText } from '../lib/format'
import type { ArtistRef } from '../../../shared/types'

interface ArtistLinksProps {
  artists?: ArtistRef[]
  author?: string | null
  authorId?: string | null
  className?: string
}

interface ParsedArtist {
  name: string
  id?: string | null
  isMore?: boolean
}

/** Parses author string or artists array into individual clickable artist tokens. */
function parseArtists(
  artists?: ArtistRef[],
  author?: string | null,
  authorId?: string | null
): ParsedArtist[] {
  if (Array.isArray(artists) && artists.length > 0) {
    const parsed: ParsedArtist[] = []
    for (const a of artists) {
      const name = safeText(a.name)
      if (!name) continue
      const lower = name.toLowerCase().trim()
      if (lower === 'and more' || lower === 'more') {
        parsed.push({ name: 'and more', isMore: true })
      } else {
        parsed.push({ name, id: a.id ?? null })
      }
    }
    if (parsed.length > 0) return parsed
  }

  const raw = safeText(author)
  if (!raw) return []

  // Check if string ends with ", and more" / " and more" / ", more"
  const moreRegex = /^(.*?)(?:,\s*and|\s+and|,)\s+more\s*$/i
  const match = raw.match(moreRegex)
  const baseText = match ? match[1].trim() : raw
  const hasMore = Boolean(match)

  // Split by comma or ampersand
  const rawParts = baseText.split(/[,&]/).map((s) => s.trim()).filter(Boolean)
  if (rawParts.length === 0) {
    return hasMore ? [{ name: 'and more', isMore: true }] : [{ name: raw, id: authorId ?? null }]
  }

  const parsed: ParsedArtist[] = rawParts.map((name, idx) => ({
    name,
    // If only one artist was split and an authorId was provided, attach it
    id: rawParts.length === 1 ? (authorId ?? null) : (idx === 0 && authorId ? authorId : null)
  }))

  if (hasMore) {
    parsed.push({ name: 'and more', isMore: true })
  }

  return parsed
}

/**
 * Clickable artist names for music search results and tracks.
 * Handles single artists, multiple artists (comma-separated or runs),
 * and "Artist 1, Artist 2, and more" gracefully with individual links.
 */
export const ArtistLinks = memo(function ArtistLinks({
  artists,
  author,
  authorId,
  className
}: ArtistLinksProps): React.JSX.Element | null {
  const items = parseArtists(artists, author, authorId)
  if (items.length === 0) return null

  return (
    <span className={['artist-links', className].filter(Boolean).join(' ')}>
      {items.map((item, index) => {
        if (item.isMore) {
          return (
            <span key={index} className="artist-links__more">
              {index > 0 ? ', and more' : 'and more'}
            </span>
          )
        }

        const showSeparator = index > 0

        return (
          <span key={index} className="artist-links__item">
            {showSeparator && <span className="artist-links__sep">, </span>}
            <button
              type="button"
              className="artist-link"
              title={item.id ? `Open ${item.name}` : `Search for ${item.name}`}
              onClick={(e) => {
                e.stopPropagation()
                if (item.id) {
                  navigate(`#/channel/${item.id}`)
                } else {
                  navigate(`#/search?q=${encodeURIComponent(item.name)}&f=channels`)
                }
              }}
            >
              {item.name}
            </button>
          </span>
        )
      })}
    </span>
  )
})
