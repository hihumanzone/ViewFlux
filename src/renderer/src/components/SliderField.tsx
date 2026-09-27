import { useEffect, useRef, useState } from 'react'

interface SliderFieldProps {
  value: number
  min: number
  max: number
  step: number
  /** Unit shown after the number, e.g. '%' or 'x'. */
  suffix?: string
  /** Decimals used when the slider is dragged. */
  precision?: number
  label: string
  /** Fires continuously while dragging or while typing. */
  onChange: (value: number) => void
  /**
   * Fires once per interaction — when the drag or key presses end, or when a
   * typed value is committed. Use it for side effects (saving, toasts) that
   * must not repeat for every step of a drag.
   */
  onCommit?: (value: number) => void
}

/** Keys that can move a focused range input. */
const SLIDER_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown'
])

/**
 * Range slider with a read-out that can also be typed into, e.g. `100%`.
 * Typing is committed on blur or Enter, then clamped to the slider range.
 */
export function SliderField({
  value,
  min,
  max,
  step,
  suffix = '',
  precision = 0,
  label,
  onChange,
  onCommit
}: SliderFieldProps): React.JSX.Element {
  const format = (input: number): string =>
    `${Number(input.toFixed(precision))}${suffix}`
  const [draft, setDraft] = useState<string | null>(null)
  const draggingRef = useRef(false)
  // Read the newest value from listeners without re-binding them on every step.
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    setDraft(null)
  }, [value])

  // A drag can finish outside the window, so watch the window for the release
  // and commit exactly once per drag.
  useEffect(() => {
    if (!onCommit) return
    const release = (): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      onCommit(valueRef.current)
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [onCommit])

  const commit = (raw: string): void => {
    const parsed = Number.parseFloat(raw.replace(/[^0-9.]/g, ''))
    if (Number.isNaN(parsed)) {
      setDraft(null)
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    const next = Number(clamped.toFixed(precision))
    onChange(next)
    setDraft(null)
    onCommit?.(next)
  }

  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0

  return (
    <div className="slider-field">
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ ['--p' as string]: `${percent}%` }}
        onPointerDown={() => {
          draggingRef.current = true
        }}
        onChange={(event) => onChange(Number(event.target.value))}
        onKeyUp={(event) => {
          if (SLIDER_KEYS.has(event.key)) onCommit?.(valueRef.current)
        }}
      />
      <input
        className="slider-value"
        type="text"
        inputMode="decimal"
        aria-label={`${label} value`}
        value={draft ?? format(value)}
        size={4}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(null)
        }}
      />
    </div>
  )
}
