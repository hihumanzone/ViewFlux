/**
 * Formats a duration in seconds as `m:ss`, or `h:mm:ss` once it passes an hour.
 *
 * There is exactly one implementation: the player's scrub bar, thumbnail
 * badges, playlist rows and the settings sliders all render the same clock, and
 * a third hand-rolled copy drifting out of sync with the rest is a bug waiting
 * to happen.
 */
function formatTimecode(seconds: number): string {
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

const isUsable = (seconds: number | null | undefined): seconds is number =>
  seconds != null && Number.isFinite(seconds) && seconds > 0

/** Duration badge text. Empty string when there is no usable duration. */
export function formatDuration(seconds: number | null | undefined): string {
  return isUsable(seconds) ? formatTimecode(seconds) : ''
}

/** Elapsed/remaining time. `0:00` for unknown or negative input. */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '0:00'
  return formatTimecode(seconds)
}

/** Compact count with a K/M/B suffix, e.g. `1.2M`. */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ''
  const negative = value < 0
  const abs = Math.abs(value)
  if (abs < 1000) return String(value)
  const units = [
    { limit: 1e9, suffix: 'B' },
    { limit: 1e6, suffix: 'M' },
    { limit: 1e3, suffix: 'K' }
  ]
  for (const { limit, suffix } of units) {
    if (abs >= limit) {
      const scaled = abs / limit
      const str = scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)
      return `${negative ? '-' : ''}${str.replace(/\.0$/, '')}${suffix}`
    }
  }
  return String(value)
}

export function formatViews(value: number | null | undefined): string {
  const formatted = formatCount(value)
  return formatted ? `${formatted} views` : ''
}

/** "3 days ago"-style label. Future timestamps read as "just now". */
export function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60000) return 'just now'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.floor(months / 12)
  return `${years} year${years === 1 ? '' : 's'} ago`
}

/** `1,234` — used where an exact figure reads better than `1.2K`. */
export function formatExact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ''
  return value.toLocaleString()
}

/** Formats card upload age, turning absolute stream/premiere dates into relative times. */
export function formatVideoPublished(video: {
  published?: string | null
  publishTimestamp?: number | null
  isPremiere?: boolean
  isStreamed?: boolean
  isLive?: boolean
}): string | null {
  if (video.isLive) return 'Live'

  let relTime: string | null = null
  if (video.publishTimestamp && !Number.isNaN(video.publishTimestamp)) {
    relTime = formatRelative(video.publishTimestamp)
  }

  const raw = video.published?.trim() || ''

  if (!relTime && raw) {
    const dateMatch = raw.match(
      /(?:streamed(?: live)?|premiered)?\s*(?:on\s+)?([A-Za-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/i
    )
    if (dateMatch) {
      const parsed = Date.parse(dateMatch[1])
      if (!Number.isNaN(parsed)) {
        relTime = formatRelative(parsed)
      }
    }
  }

  const isStreamed = Boolean(video.isStreamed || /streamed/i.test(raw))
  const isPrem = Boolean(video.isPremiere || /premiere/i.test(raw))

  if (relTime) {
    if (isPrem) return `Premiered ${relTime}`
    if (isStreamed) return `Streamed ${relTime}`
    return relTime
  }

  if (raw) {
    if (isPrem && !/premiered/i.test(raw)) {
      return `Premiered ${raw}`
    }
    if (isStreamed && !/streamed/i.test(raw)) {
      return `Streamed ${raw}`
    }
    if (/^streamed live\b/i.test(raw)) {
      return raw.replace(/^streamed live\s*(?:on\s*)?/i, 'Streamed ')
    }
    return raw
  }

  return null
}



