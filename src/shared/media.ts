/**
 * Media constants shared by the main process and the renderer.
 *
 * The itag rules in particular used to be written out three times — twice in
 * the proxy (HLS rewrite + request routing) and once in the player's request
 * filter. When YouTube changes the shape of a googlevideo URL the three copies
 * drift apart and the audio track silently stops loading, so the single
 * implementation lives here and is imported everywhere.
 */

/**
 * Audio-only itags YouTube serves for the primary audio rendition.
 * 139/140 are AAC in an MP4 container, 233/234 are Opus-only; all four are
 * muxed by us rather than by YouTube.
 */
export const AUDIO_ITAGS: readonly number[] = [233, 234, 139, 140]

const ITAG_ALTERNATION = AUDIO_ITAGS.join('|')
const AUDIO_ITAG_PATH = new RegExp(`/itag/(?:${ITAG_ALTERNATION})/`)
const AUDIO_ITAG_QUERY = new RegExp(`[?&]itag=(?:${ITAG_ALTERNATION})\\b`)

/**
 * True when `href` points at a YouTube audio rendition. Matches both the
 * `/itag/<n>/` path form and the `?itag=<n>` query form, which YouTube uses
 * interchangeably depending on which CDN and container it picked.
 */
export function isAudioItagUrl(href: string): boolean {
  return (
    href.includes('/sgoap/') ||
    AUDIO_ITAG_PATH.test(href) ||
    AUDIO_ITAG_QUERY.test(href)
  )
}

/** The audio itag encoded in `href`, or `null` when it is not an audio rendition. */
export function audioItagFromUrl(href: string): number | null {
  const match =
    AUDIO_ITAG_PATH.exec(href) ?? AUDIO_ITAG_QUERY.exec(href)
  if (!match) return null
  const value = Number.parseInt(match[0].replace(/\D+/g, ''), 10)
  return AUDIO_ITAGS.includes(value) ? value : null
}

/** Playback rates offered by the player and the settings page. */
export const PLAYBACK_SPEEDS: readonly number[] = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5
]

/** Adaptive quality ceilings, lowest first. `auto` follows the bandwidth. */
export const QUALITY_LABELS: Record<string, string> = {
  auto: 'Auto',
  '144p': '144p',
  '240p': '240p',
  '360p': '360p',
  '480p': '480p',
  '720p': '720p',
  '1080p': '1080p',
  '1440p': '1440p',
  '2160p': '2160p'
}

/** Human names for the audio language codes YouTube reports. */
const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  'en-gb': 'English (UK)',
  'en-us': 'English (US)',
  es: 'Spanish',
  'es-419': 'Spanish (Latin America)',
  fa: 'Persian',
  fi: 'Finnish',
  fr: 'French',
  he: 'Hebrew',
  hi: 'Hindi',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  ms: 'Malay',
  nl: 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  pt: 'Portuguese',
  'pt-br': 'Portuguese (Brazil)',
  ro: 'Romanian',
  ru: 'Russian',
  sv: 'Swedish',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  zh: 'Chinese',
  'zh-cn': 'Chinese (Simplified)',
  'zh-hans': 'Chinese (Simplified)',
  'zh-hant': 'Chinese (Traditional)',
  'zh-tw': 'Chinese (Traditional)'
}

/**
 * Best human label for an audio track's language code, falling back to the raw
 * code (or a supplied title) when the language is not one we have a name for.
 */
export function languageName(code: string | null | undefined, fallback?: string | null): string {
  if (!code) return fallback || 'Unknown'
  const key = code.toLowerCase()
  const named = LANGUAGE_NAMES[key] ?? LANGUAGE_NAMES[key.split('-')[0] ?? '']
  if (named) return named
  const readable = fallback ?? code
  // `en-GB` reads as "en-GB"; upper-casing the region makes it a real label.
  return readable.replace(/^([a-z]{2,3})-([a-z]{2})$/i, (_, lang: string, region: string) =>
    `${lang.toLowerCase()}-${region.toUpperCase()}`
  )
}
