import { useEffect, useRef, useState } from 'react'
import { Slider } from './Slider'

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
  /** 'primary' (signature lilac) | 'tertiary' (boosted coral) */
  accent?: 'primary' | 'tertiary'
  /** 'sm' | 'md' */
  size?: 'sm' | 'md'
  /** Show the ceiling stop dot */
  showEndStop?: boolean
  /** Discrete stops */
  stops?: boolean | number[]
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
  accent,
  size,
  showEndStop,
  stops,
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

  return (
    <div className="slider-field">
      <Slider
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        accent={accent}
        size={size}
        showEndStop={showEndStop}
        stops={stops}
        onPointerDown={() => {
          draggingRef.current = true
        }}
        onChange={onChange}
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
