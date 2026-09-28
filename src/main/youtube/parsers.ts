import type {
  Chapter,
  Thumb
} from '../../shared/types'
import type {
  LockupViewNode,
  TextLike,
  ThumbLike
} from './types'

// ---------------------------------------------------------------------------
// Text / number helpers
// ---------------------------------------------------------------------------

export function text(value: TextLike | string | null | undefined): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (value.text) return value.text
  if (Array.isArray(value.runs)) return value.runs.map((r) => r.text ?? '').join('')
  if (typeof value.toString === 'function') {
    const out = value.toString()
    if (out && out !== '[object Object]') return out
  }
  return ''
}

export function parseCount(value: TextLike | string | null | undefined): number | null {
  const raw = text(value)
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = Number.parseInt(digits, 10)
  return Number.isFinite(n) ? n : null
}

const COMPACT_COUNT_REGEX = /(\d[\d,]*(?:\.\d+)?)\s*([KMB])?\b/i

/** Parses compact counts like "8.1M", "1.8B views", "960". */
export function parseCompactCount(raw: string | null | undefined): number | null {
  if (!raw) return null
  const m = COMPACT_COUNT_REGEX.exec(raw)
  if (!m) return parseCount(raw)
  const n = Number.parseFloat(m[1].replace(/[,\s]/g, ''))
  if (!Number.isFinite(n)) return parseCount(raw)
  const suffix = m[2]?.toUpperCase()
  const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1
  return Math.round(n * mult)
}

/** Parses "47:42" / "1:02:03" style duration text into seconds. */
export function parseDurationText(raw: string | null | undefined): number | null {
  if (!raw || !raw.includes(':')) return null
  const parts = raw.trim().split(':').map((p) => Number.parseInt(p, 10))
  if (parts.some((p) => !Number.isFinite(p))) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

const AGO_REGEX = /(\d+)\s*(years?|yrs?|y|months?|mo|weeks?|w|days?|d|hours?|h|minutes?|min|m|seconds?|s)\b/i

const AGO_DAYS_MULTIPLIER: Record<string, number> = {
  y: 365, yr: 365, yrs: 365, year: 365, years: 365,
  mo: 30, month: 30, months: 30,
  w: 7, week: 7, weeks: 7,
  d: 1, day: 1, days: 1,
  h: 1 / 24, hour: 1 / 24, hours: 1 / 24,
  m: 1 / 1440, min: 1 / 1440, minute: 1 / 1440, minutes: 1 / 1440,
  s: 1 / 86400, sec: 1 / 86400, second: 1 / 86400, seconds: 1 / 86400
}

/** Parses relative dates ("5d ago", "2mo ago", "13 years ago") into days. */
export function parseAgoDays(raw: string | null | undefined): number | null {
  if (!raw) return null
  const m = AGO_REGEX.exec(raw)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  const unit = m[2].toLowerCase()
  return n * (AGO_DAYS_MULTIPLIER[unit] ?? 1)
}

/** Some thumbnails come protocol-relative ("//yt3.ggpht.com/…"); make them absolute. */
export function absUrl(url: string | null | undefined): string {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  return url
}

export function pickThumbnail(thumbs: ThumbLike[] | undefined, targetWidth = 480): string {
  if (!thumbs || thumbs.length === 0) return ''
  let best = thumbs[0]
  let minDiff = Math.abs((best.width || 0) - targetWidth)
  for (let i = 1; i < thumbs.length; i++) {
    const t = thumbs[i]
    const diff = Math.abs((t.width || 0) - targetWidth)
    if (diff < minDiff) {
      minDiff = diff
      best = t
    }
  }
  return absUrl(best?.url)
}

export function normalizeThumbs(thumbs: { url: string; width: number; height: number }[] | undefined): Thumb[] {
  if (!thumbs) return []
  return thumbs.map((t) => ({ url: t.url, width: t.width, height: t.height }))
}

/** Collects badge texts from thumbnail overlays (duration, video counts…). */
export function badgeTexts(overlays: unknown[] | undefined): string[] {
  const out: string[] = []
  for (const overlay of overlays ?? []) {
    const badges = (overlay as { badges?: unknown[] })?.badges
    if (Array.isArray(badges)) {
      for (const badge of badges) {
        // Badges can be plain strings or { text } objects depending on view.
        const t = typeof badge === 'string' ? badge : text((badge as { text?: TextLike })?.text)
        if (t) out.push(t)
      }
    }
  }
  return out
}

/** LockupView overlays can sit on the image view itself or on the collection's primary thumbnail. */
export function lockupBadges(node: LockupViewNode): string[] {
  const image = node.content_image
  return [...badgeTexts(image?.overlays), ...badgeTexts(image?.primary_thumbnail?.overlays)]
}

/** Flattens LockupView metadata rows into plain text rows. */
export function lockupRows(node: LockupViewNode): string[][] {
  const rows = node.metadata?.metadata?.metadata_rows ?? []
  return rows.map((row) =>
    (row.metadata_parts ?? []).map((part) => text(part?.text)).filter(Boolean)
  )
}

/**
 * Digs the owning channel's id and picture out of a LockupView node. The
 * avatar is exposed on the metadata image and the browse id either on that
 * image's tap endpoint or on one of the metadata text parts, so all three are
 * probed before giving up.
 */
export function lockupAuthor(node: LockupViewNode): { authorId: string | null; authorAvatar: string | null } {
  const metaImg = node.metadata?.image
  const avatarImages =
    metaImg?.avatar?.image ??
    metaImg?.avatar?.sources ??
    metaImg?.decoratedAvatarViewModel?.avatar?.image ??
    metaImg?.decoratedAvatarViewModel?.avatar?.sources
  const authorAvatar =
    Array.isArray(avatarImages) && avatarImages.length > 0
      ? pickThumbnail(avatarImages, 240) || absUrl(avatarImages[0]?.url) || null
      : null

  const directId =
    metaImg?.renderer_context?.command_context?.on_tap?.payload?.browseId ??
    metaImg?.avatar?.endpoint?.payload?.browseId ??
    metaImg?.endpoint?.payload?.browseId ??
    metaImg?.on_tap_endpoint?.payload?.browseId

  let authorId: string | null = typeof directId === 'string' && directId ? directId : null
  if (!authorId) {
    const rows = node.metadata?.metadata?.metadata_rows ?? []
    for (const row of rows) {
      for (const part of row.metadata_parts ?? []) {
        const ep =
          part.endpoint?.payload?.browseId ??
          part.endpoint?.browseEndpoint?.browseId ??
          part.endpoint?.browseId ??
          part.text?.endpoint?.payload?.browseId
        if (typeof ep === 'string' && ep) {
          authorId = ep
          break
        }
      }
      if (authorId) break
    }
  }

  return { authorId, authorAvatar }
}

/** Classifies loose channel-related texts into handle / subscribers / video count. */
export function classifyChannelTexts(candidates: (string | null | undefined)[]): {
  handle: string | null
  subscribers: string | null
  videoCount: string | null
} {
  let handle: string | null = null
  let subscribers: string | null = null
  let videoCount: string | null = null
  for (const candidate of candidates) {
    const t = text(candidate)
    if (!t) continue
    if (!handle && t.startsWith('@')) handle = t
    else if (!subscribers && /subscriber/i.test(t)) subscribers = t
    else if (!videoCount && /\bvideos?\b/i.test(t)) videoCount = t
  }
  return { handle, subscribers, videoCount }
}

// ---------------------------------------------------------------------------
// Chapter parsing helpers
// ---------------------------------------------------------------------------

export function parseTimestampToSeconds(str: string): number {
  if (!str) return 0
  const parts = str.trim().split(':').map((p) => parseInt(p, 10))
  if (parts.some((p) => isNaN(p))) return 0
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  } else if (parts.length === 1) {
    return parts[0]
  }
  return 0
}

export function parseDescriptionChapters(desc: string, duration: number): Chapter[] {
  if (!desc) return []
  const lines = desc.split(/\r?\n/)
  const found: { title: string; start: number }[] = []

  const p1 = /^(?:\[|\()?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\]|\))?\s*[-–—:]?\s*(.+)$/
  const p2 = /^(.+?)\s*[-–—:]?\s*(?:\[|\()?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\]|\))?$/

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const m1 = line.match(p1)
    if (m1) {
      const hours = m1[1] ? parseInt(m1[1], 10) : 0
      const mins = parseInt(m1[2], 10)
      const secs = parseInt(m1[3], 10)
      const sec = (isNaN(hours) ? 0 : hours) * 3600 + (isNaN(mins) ? 0 : mins) * 60 + (isNaN(secs) ? 0 : secs)
      const title = m1[4].trim()
      if (title) found.push({ title, start: sec })
      continue
    }
    const m2 = line.match(p2)
    if (m2) {
      const hours = m2[2] ? parseInt(m2[2], 10) : 0
      const mins = parseInt(m2[3], 10)
      const secs = parseInt(m2[4], 10)
      const sec = (isNaN(hours) ? 0 : hours) * 3600 + (isNaN(mins) ? 0 : mins) * 60 + (isNaN(secs) ? 0 : secs)
      const title = m2[1].trim()
      if (title) found.push({ title, start: sec })
    }
  }

  if (found.length < 2) return []
  if (found[0].start > 5) return []
  for (let i = 1; i < found.length; i++) {
    if (found[i].start <= found[i - 1].start) return []
    if (duration > 0 && found[i].start >= duration) return []
  }

  const list: Chapter[] = found.map((item) => ({
    title: item.title,
    start: item.start,
    end: 0,
    thumbnail: null
  }))
  return finalizeChapters(list, duration)
}

export function finalizeChapters(chapters: Chapter[], duration: number): Chapter[] {
  chapters.sort((a, b) => a.start - b.start)
  const unique: Chapter[] = []
  for (const ch of chapters) {
    if (unique.length === 0 || unique[unique.length - 1].start !== ch.start) {
      unique.push({ ...ch })
    }
  }
  if (unique.length > 0 && unique[0].start > 0) {
    unique.unshift({
      title: 'Intro',
      start: 0,
      end: unique[0].start,
      thumbnail: unique[0].thumbnail
    })
  }
  for (let i = 0; i < unique.length; i++) {
    if (i < unique.length - 1) {
      unique[i].end = unique[i + 1].start
    } else {
      unique[i].end = duration > unique[i].start ? duration : unique[i].start + 1
    }
  }
  return unique
}

/**
 * Extracts video chapters from official YouTube player bar markers,
 * macro markers engagement panels, or falls back to description timestamps.
 */
export function extractVideoChapters(
  info: unknown,
  duration: number,
  description: string
): Chapter[] {
  // 1. Official YouTube player bar markers (markers_map)
  try {
    const markers = (info as unknown as { player_overlays?: { decorated_player_bar?: { player_bar?: { markers_map?: { value?: { chapters?: { title?: TextLike; time_range_start_millis?: number; thumbnail?: ThumbLike[] }[] } }[] } } } })?.player_overlays?.decorated_player_bar?.player_bar?.markers_map
    if (Array.isArray(markers)) {
      for (const marker of markers) {
        const rawChapters = marker?.value?.chapters
        if (Array.isArray(rawChapters) && rawChapters.length > 0) {
          const list: Chapter[] = []
          for (let i = 0; i < rawChapters.length; i++) {
            const ch = rawChapters[i]
            const title = text(ch?.title) || `Chapter ${i + 1}`
            const start =
              typeof ch?.time_range_start_millis === 'number'
                ? Math.max(0, Math.floor(ch.time_range_start_millis / 1000))
                : 0
            const thumbnail = pickThumbnail(ch?.thumbnail, 640) || null
            list.push({ title, start, end: 0, thumbnail })
          }
          if (list.length > 0) {
            return finalizeChapters(list, duration)
          }
        }
      }
    }
  } catch {
    // Fall through to next source
  }

  // 2. Engagement panels (MacroMarkersList)
  try {
    const panels = (info as unknown as { page?: [{ [key: string]: unknown }, { engagement_panels?: { panel_identifier?: string; content?: { type?: string; contents?: { type?: string; title?: TextLike; time_description?: TextLike; thumbnail?: ThumbLike[] }[] } }[] }] })?.page?.[1]?.engagement_panels
    if (Array.isArray(panels)) {
      const macroPanel = panels.find(
        (p) =>
          p?.panel_identifier?.includes('macro-markers') ||
          p?.content?.type === 'MacroMarkersList'
      )
      const contents = macroPanel?.content?.contents
      if (Array.isArray(contents) && contents.length > 0) {
        const list: Chapter[] = []
        for (let i = 0; i < contents.length; i++) {
          const item = contents[i]
          if (item?.type !== 'MacroMarkersListItem') continue
          const title = text(item.title) || `Chapter ${i + 1}`
          const timeStr = text(item.time_description)
          const start = parseTimestampToSeconds(timeStr)
          const thumbnail = pickThumbnail(item.thumbnail, 640) || null
          list.push({ title, start, end: 0, thumbnail })
        }
        if (list.length > 0) {
          return finalizeChapters(list, duration)
        }
      }
    }
  } catch {
    // Fall through to next source
  }

  // 3. Fallback: Parse description timestamps
  try {
    const descChapters = parseDescriptionChapters(description, duration)
    if (descChapters.length > 0) {
      return descChapters
    }
  } catch {
    // Fall through
  }

  return []
}
