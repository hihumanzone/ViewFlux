import type shaka from 'shaka-player'
import type {
  CaptionTrack,
  Chapter,
  Settings,
  SponsorSegment
} from '../../../../shared/types'
import type { SubtitleStyle } from '../../../../shared/subtitles'

export type { CaptionTrack, Chapter, Settings, SponsorSegment, SubtitleStyle }

export interface PlayerHandle {
  seekTo: (time: number) => void
  unskip: (segment: SponsorSegment) => void
  play: () => void
  pause: () => void
  seekBy: (delta: number) => void
  /** Jump to the next chapter. */
  nextChapter: () => void
  /** Jump to the start of the current (or the previous) chapter. */
  previousChapter: () => void
}

/** Metadata surfaced to the OS media session (Windows SMTC flyout). */
export interface MediaSessionMeta {
  title: string
  artist: string
  album?: string
  artwork?: string | null
  /** Skips chapter navigation for the media keys and uses the queue instead. */
  onNextTrack?: () => void
  onPreviousTrack?: () => void
}

export interface PlaylistNavigation {
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
}

export interface PlayerProps {
  videoId: string
  manifestUrl: string
  /**
   * Hint from the main process (`basic_info.is_live`). It selects the Shaka
   * configuration *before* the manifest is parsed, because the manifest-level
   * live settings (presentation delay, `hls.sequenceMode`, `disableText`) are
   * only read during parsing and cannot be changed afterwards. Shaka's own
   * `player.isLive()` stays authoritative once the manifest is loaded.
   */
  isLive: boolean
  poster?: string
  captions: CaptionTrack[]
  chapters?: Chapter[]
  startPosition: number
  autoplay: boolean
  segments: SponsorSegment[]
  autoSkip: boolean
  sponsorBlockEnabled: boolean
  alwaysShowCaptions: boolean
  /** Caption size, colour and background. */
  subtitleStyle: SubtitleStyle
  initialVolume: number
  initialSpeed: number
  preferredQuality: Settings['preferredQuality']
  preservePitch: boolean
  skipSilence: boolean
  /**
   * Language of the video's original audio track (main-process resolved from
   * the player response's `audioIsDefault`/`is_original` markers — the same
   * sources NewPipe uses). Used to pick the original dub by default.
   */
  defaultAudioLanguage: string | null
  onPitchChange: (value: boolean) => void
  onSkipSilenceChange: (value: boolean) => void
  onSubtitleStyleChange: (style: SubtitleStyle) => void
  onTimeUpdate: (position: number, duration: number) => void
  onEnded: () => void
  onSkipped: (segment: SponsorSegment) => void
  onSpeedChange?: (speed: number) => void
  onVolumeChange?: (volume: number) => void
  onCaptionsToggle?: (visible: boolean) => void
  onFullscreenChange?: (isFullscreen: boolean) => void
  /** Optional OS media-session metadata; omit to hide the Windows "now playing" card. */
  mediaSession?: MediaSessionMeta | null
  /** Optional playlist forward/back navigation controls when video is part of a playlist */
  playlistNavigation?: PlaylistNavigation | null
}

/**
 * The seekable (DVR) window of a live stream, in presentation time. Both ends
 * move: `start` advances as the window slides, `end` is the live edge minus the
 * presentation delay Shaka keeps us behind.
 */
export interface LiveWindow {
  start: number
  end: number
}

export type VariantTrack = ReturnType<shaka.Player['getVariantTracks']>[number]
export type TextTrack = ReturnType<shaka.Player['getTextTracks']>[number]
export type AudioTrack = ReturnType<shaka.Player['getAudioTracks']>[number]

export type MenuKind = 'quality' | 'captions' | 'audio' | 'settings' | 'more'

export interface OsdState {
  id: number
  icon?: string
  text: string
}

/* ---- Keyboard shortcut targeting helpers ----------------------------------- */

const SPACE_KEYS = new Set([' ', 'Spacebar', 'Space'])
export const isSpaceKey = (event: KeyboardEvent): boolean =>
  SPACE_KEYS.has(event.key) || event.code === 'Space'

const TYPING_TAGS = new Set(['TEXTAREA', 'SELECT'])
const ACTIVATABLE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY'])

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit'
])

/** True only for fields the user is actually typing into. */
export const isTypingTarget = (el: Element): boolean => {
  if (TYPING_TAGS.has(el.tagName)) return true
  if ((el as HTMLElement).isContentEditable) return true
  if (el.tagName !== 'INPUT') return false
  const type = (el as HTMLInputElement).type?.toLowerCase() ?? 'text'
  return !NON_TEXT_INPUT_TYPES.has(type)
}

/** Controls that the browser itself activates with Space. */
export const isActivatable = (el: Element): boolean =>
  ACTIVATABLE_TAGS.has(el.tagName) || el.getAttribute('role') === 'button'

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))
export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))
export const clampVolume = (n: number): number => clamp(n, 0, 3)

export function audioCode(track: AudioTrack): string {
  return (track.language ?? '').trim() || 'und'
}

/** Canonical form of a language code, so codes from different sources line up. */
export const normLang = (s: string | null | undefined): string =>
  (s ?? '').trim().toLowerCase()

/** `en-US`, `en_us` and `en.GB` all collapse to `en` for a relaxed comparison. */
const primeLang = (s: string): string => s.split('-')[0].split('_')[0].split('.')[0]

/**
 * Whether two codes name the same language, tolerating case and region subtags.
 *
 * Track selection must compare on this rather than `===`. The menu's codes come
 * from the manifest (`en-US`, `pt-BR`) while the language actually playing is
 * read back from the player (`en-us`), so a strict compare renders a checkmark
 * on nothing at all even though the correct track is playing. Two empty codes
 * are treated as equal; an empty code never matches a real one.
 */
export const sameLanguage = (
  a: string | null | undefined,
  b: string | null | undefined
): boolean => {
  const x = normLang(a)
  const y = normLang(b)
  if (x === y) return true
  if (x === '' || y === '') return false
  return primeLang(x) === primeLang(y)
}
