/**
 * Shared subtitle appearance model.
 *
 * Captions are rendered by shaka's `UITextDisplayer` into a `.shaka-text-container`
 * element inside the player root, so their look is driven entirely by the CSS
 * custom properties produced here.
 */

export type SubtitleBackground = 'none' | 'shadow' | 'solid'

export interface SubtitleStyle {
  /** Multiplier applied to the automatic (YouTube-like) baseline size. */
  size: number
  /** Cue text colour as a CSS colour. */
  color: string
  /** How the text is separated from the video. */
  background: SubtitleBackground
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  size: 1,
  color: '#ffffff',
  background: 'solid'
}

/**
 * Size range in percent of the automatic baseline — this is the scale the
 * slider works in, so the read-out shows `100%` rather than `1`.
 */
export const SUBTITLE_SIZE_PERCENT_MIN = 60
export const SUBTITLE_SIZE_PERCENT_MAX = 240
export const SUBTITLE_SIZE_PERCENT_STEP = 5

/** Same range as a multiplier, used for clamping persisted values. */
const SUBTITLE_SIZE_MIN = SUBTITLE_SIZE_PERCENT_MIN / 100
const SUBTITLE_SIZE_MAX = SUBTITLE_SIZE_PERCENT_MAX / 100

/** Fraction of the video height used as the 100% caption size. */
const BASE_SIZE_RATIO = 0.034
/** Never go below this, tiny videos would render unreadable captions. */
const MIN_FONT_SIZE = 12

export const SUBTITLE_COLORS: string[] = [
  '#ffffff',
  '#fde047',
  '#7ee787',
  '#79c0ff',
  '#ff7b72',
  '#ffa657',
  '#d2a8ff',
  '#111111'
]

export interface SubtitleBackgroundOption {
  id: SubtitleBackground
  label: string
}

export const SUBTITLE_BACKGROUNDS: SubtitleBackgroundOption[] = [
  { id: 'none', label: 'None' },
  { id: 'shadow', label: 'Shadow' },
  { id: 'solid', label: 'Box' }
]

/**
 * Resolve the caption font size in px. YouTube scales captions with the player,
 * so the baseline follows the stage height and only `style.size` is a constant.
 */
function subtitleFontSize(style: SubtitleStyle, stageHeight: number): number {
  const base = stageHeight > 0 ? stageHeight * BASE_SIZE_RATIO : 20
  return Math.max(MIN_FONT_SIZE, Math.round(base * style.size))
}

function backgroundLayer(background: SubtitleBackground): {
  box: string
  shadow: string
} {
  switch (background) {
    case 'solid':
      return { box: 'rgba(0, 0, 0, 0.78)', shadow: '0 1px 2px rgba(0, 0, 0, 0.9)' }
    case 'none':
      // Genuinely nothing: no box *and* no shadow, otherwise "None" still
      // leaves a halo around the text.
      return { box: 'transparent', shadow: 'none' }
    case 'shadow':
    default:
      return { box: 'transparent', shadow: '0 2px 4px rgba(0, 0, 0, 0.9)' }
  }
}

/** `1.35` -> `135`, for the percent-based slider. */
export function subtitleSizePercent(style: SubtitleStyle): number {
  return Math.round(style.size * 100)
}

/** `135` -> `1.35`, back into the stored multiplier. */
export function subtitleSizeFromPercent(percent: number): number {
  return Math.round(percent) / 100
}

/** CSS custom properties consumed by the caption + preview styles. */
export function subtitleCssVars(
  style: SubtitleStyle,
  stageHeight: number
): Record<string, string> {
  const layer = backgroundLayer(style.background)
  return {
    '--subtitle-font-size': `${subtitleFontSize(style, stageHeight)}px`,
    '--subtitle-color': style.color,
    '--subtitle-background': layer.box,
    '--subtitle-shadow': layer.shadow
  }
}

/** Defensive merge so persisted settings never produce a partial style. */
export function normalizeSubtitleStyle(value: unknown): SubtitleStyle {
  const raw = (value ?? {}) as Partial<SubtitleStyle>
  const step = SUBTITLE_SIZE_PERCENT_STEP / 100
  const hasSize = typeof raw.size === 'number' && Number.isFinite(raw.size)
  const clamped = Math.min(
    SUBTITLE_SIZE_MAX,
    Math.max(SUBTITLE_SIZE_MIN, raw.size ?? DEFAULT_SUBTITLE_STYLE.size)
  )
  // Snap to the slider's own grid (whole 5% steps) so the control is never
  // handed a size it cannot represent, and land on whole percents to keep
  // float noise such as `0.6500000000000001` out of the settings file.
  const size = hasSize
    ? (Math.round(clamped / step) * SUBTITLE_SIZE_PERCENT_STEP) / 100
    : DEFAULT_SUBTITLE_STYLE.size
  const color = typeof raw.color === 'string' && raw.color.trim() ? raw.color : DEFAULT_SUBTITLE_STYLE.color
  const background = SUBTITLE_BACKGROUNDS.some((option) => option.id === raw.background)
    ? (raw.background as SubtitleBackground)
    : DEFAULT_SUBTITLE_STYLE.background
  return { size, color, background }
}
