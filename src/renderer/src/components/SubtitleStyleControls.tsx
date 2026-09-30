import { useMemo } from 'react'
import { SliderField } from './SliderField'
import {
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_COLORS,
  SUBTITLE_SIZE_PERCENT_MAX,
  SUBTITLE_SIZE_PERCENT_MIN,
  SUBTITLE_SIZE_PERCENT_STEP,
  subtitleCssVars,
  subtitleSizeFromPercent,
  subtitleSizePercent,
  type SubtitleStyle
} from '../../../shared/subtitles'

interface SubtitleStyleControlsProps {
  style: SubtitleStyle
  onChange: (next: SubtitleStyle) => void
  /** Fires once per interaction, so callers can persist without spamming saves. */
  onCommit?: (next: SubtitleStyle) => void
  /** Renders a live sample of the current style above the controls. */
  showPreview?: boolean
  /**
   * Height the preview pretends to have, so the sample scales the way real
   * captions do. Defaults to a typical laptop-sized stage.
   */
  previewHeight?: number
}

const PREVIEW_TEXT = 'Subtitles preview'

/**
 * Inside a player menu the panel's own arrow-key handler moves focus between
 * menu items, which would otherwise steal the keys from the size slider.
 */
const blockMenuArrows: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.stopPropagation()
}

/** Small uppercase label above a full-width control. */
function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="subtitle-style__field">
      <div className="subtitle-style__head">
        <span className="subtitle-style__label">{label}</span>
      </div>
      {children}
    </div>
  )
}

/**
 * Caption appearance controls, shared by the in-player captions menu and the
 * settings page so there is a single place that defines what is adjustable.
 * Each option is a label stacked over a full-width control — the same shape the
 * playback sheet uses for its speed row, so the block reads as part of the app
 * whether it sits in a settings section or a 240px popover.
 */
export function SubtitleStyleControls({
  style,
  onChange,
  onCommit,
  showPreview = true,
  previewHeight = 540
}: SubtitleStyleControlsProps): React.JSX.Element {
  // The slider works in percent of the automatic baseline, so the read-out
  // shows a meaningful `100%` instead of the raw `1` multiplier.
  const percent = subtitleSizePercent(style)
  const previewVars = useMemo(
    () => subtitleCssVars(style, previewHeight),
    [style, previewHeight]
  )
  const resize = (value: number): SubtitleStyle => ({ ...style, size: subtitleSizeFromPercent(value) })
  const pick = (next: SubtitleStyle): void => {
    onChange(next)
    onCommit?.(next)
  }

  return (
    <div className={`subtitle-style${showPreview ? ' subtitle-style--with-preview' : ''}`}>
      <div className="subtitle-style__controls">
        <Field label="Size">
          <div onKeyDown={blockMenuArrows}>
            <SliderField
              label="Subtitle size"
              value={percent}
              min={SUBTITLE_SIZE_PERCENT_MIN}
              max={SUBTITLE_SIZE_PERCENT_MAX}
              step={SUBTITLE_SIZE_PERCENT_STEP}
              suffix="%"
              onChange={(value) => onChange(resize(value))}
              onCommit={(value) => onCommit?.(resize(value))}
            />
          </div>
        </Field>

        <Field label="Text">
          <div className="subtitle-style__swatches" role="radiogroup" aria-label="Subtitle colour">
            {SUBTITLE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={style.color === color}
                aria-label={color}
                title={color}
                className={`subtitle-swatch${
                  style.color === color ? ' subtitle-swatch--active' : ''
                }`}
                style={{ background: color }}
                onClick={() => pick({ ...style, color })}
              />
            ))}
          </div>
        </Field>

        <Field label="Background">
          <div className="subtitle-style__options" role="radiogroup" aria-label="Subtitle background">
            {SUBTITLE_BACKGROUNDS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={style.background === option.id}
                className={`subtitle-chip${
                  style.background === option.id ? ' subtitle-chip--active' : ''
                }`}
                onClick={() => pick({ ...style, background: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {showPreview && (
        <div className="subtitle-style__preview-col">
          <div className="subtitle-preview" style={previewVars}>
            <div className="subtitle-preview__badge">Preview</div>
            <span className="subtitle-preview__cue">{PREVIEW_TEXT}</span>
          </div>
        </div>
      )}
    </div>
  )
}
