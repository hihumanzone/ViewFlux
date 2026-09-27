import type shaka from 'shaka-player'
import type {
  CaptionTrack,
  Chapter,
  Settings,
  SponsorSegment
} from '../../../../shared/types'

export type { CaptionTrack, Chapter, Settings, SponsorSegment }

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

export interface PlayerProps {
  videoId: string
  manifestUrl: string
  poster?: string
  captions: CaptionTrack[]
  chapters?: Chapter[]
  startPosition: number
  autoplay: boolean
  segments: SponsorSegment[]
  autoSkip: boolean
  sponsorBlockEnabled: boolean
  alwaysShowCaptions: boolean
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
  onTimeUpdate: (position: number, duration: number) => void
  onEnded: () => void
  onSkipped: (segment: SponsorSegment) => void
  /** Optional OS media-session metadata; omit to hide the Windows "now playing" card. */
  mediaSession?: MediaSessionMeta | null
}

export type VariantTrack = ReturnType<shaka.Player['getVariantTracks']>[number]
export type TextTrack = ReturnType<shaka.Player['getTextTracks']>[number]
export type AudioTrack = ReturnType<shaka.Player['getAudioTracks']>[number]

export type MenuKind = 'quality' | 'captions' | 'audio' | 'settings'

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
