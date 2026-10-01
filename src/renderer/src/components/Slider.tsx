import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEventHandler,
  type PointerEventHandler
} from 'react'

export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  className?: string
  /** 'sm' (e.g. for in-player volume popup) | 'md' (standard settings & sheet sliders) */
  size?: 'sm' | 'md'
  /** 'primary' (signature lilac) | 'tertiary' (boosted coral) */
  accent?: 'primary' | 'tertiary'
  'aria-label'?: string
  'aria-valuetext'?: string
  id?: string
  /**
   * Show the ceiling/max stop dot inside the inactive track (default: true).
   * Faithful to the Material 3 Expressive continuous volume slider design.
   */
  showEndStop?: boolean
  /**
   * Whether to render discrete stop dots along the track, or an explicit array of stop values.
   */
  stops?: boolean | number[]
  onChange: (value: number) => void
  onPointerDown?: PointerEventHandler<HTMLInputElement>
  onPointerUp?: PointerEventHandler<HTMLInputElement>
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>
  onKeyUp?: KeyboardEventHandler<HTMLInputElement>
}

/**
 * Material 3 Expressive Slider
 *
 * Implements Google's Material Design 3 Expressive slider specification:
 * - Thick pill-shaped active and inactive tracks (`border-radius: var(--r-full)`)
 * - Tall vertical rounded pill handle/thumb that narrows when pressed
 * - Visible separation gap between active track, handle, and inactive track
 * - Stop indicators (ceiling stop dot for continuous, or discrete dots for stepped)
 * - Accessible native <input type="range"> underpinning for screen readers, keyboard, and touch
 */
export const Slider = memo(function Slider({
  value,
  min,
  max,
  step = 1,
  disabled = false,
  className = '',
  size = 'md',
  accent = 'primary',
  'aria-label': ariaLabel,
  'aria-valuetext': ariaValueText,
  id,
  showEndStop = true,
  stops,
  onChange,
  onPointerDown,
  onPointerUp,
  onKeyDown,
  onKeyUp
}: SliderProps): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false)
  const draggingRef = useRef(false)

  // Global pointer release listener so dragging state resets even if released outside
  useEffect(() => {
    const handleRelease = (): void => {
      if (draggingRef.current) {
        draggingRef.current = false
        setIsDragging(false)
      }
    }
    window.addEventListener('pointerup', handleRelease)
    window.addEventListener('pointercancel', handleRelease)
    return () => {
      window.removeEventListener('pointerup', handleRelease)
      window.removeEventListener('pointercancel', handleRelease)
    }
  }, [])

  const fraction = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0

  // Discrete stop positions as normalized fractions in [0, 1]
  const stopFractions: number[] = []
  if (Array.isArray(stops)) {
    for (const s of stops) {
      if (s >= min && s <= max && max > min) {
        stopFractions.push((s - min) / (max - min))
      }
    }
  } else if (stops === true && step > 0 && max > min) {
    const count = Math.round((max - min) / step)
    // Only auto-render intermediate dots if there is a legible number of stops
    if (count >= 2 && count <= 24) {
      for (let i = 0; i <= count; i++) {
        stopFractions.push(i / count)
      }
    }
  }

  const hasDiscreteStops = stopFractions.length > 0
  const hasActiveTrack = fraction > 0.005
  const hasInactiveTrack = fraction < 0.995
  const isAtMax = fraction >= 0.99
  const isAtMin = fraction <= 0.01

  const styleVars: CSSProperties = {
    ['--p' as string]: fraction,
    ['--pct' as string]: `${fraction * 100}%`
  }

  const handlePointerDown: PointerEventHandler<HTMLInputElement> = (e) => {
    if (disabled) return
    draggingRef.current = true
    setIsDragging(true)
    onPointerDown?.(e)
  }

  const handlePointerUp: PointerEventHandler<HTMLInputElement> = (e) => {
    if (draggingRef.current) {
      draggingRef.current = false
      setIsDragging(false)
    }
    onPointerUp?.(e)
  }

  return (
    <div
      className={`m3-slider m3-slider--${size} m3-slider--${accent}${
        isDragging ? ' m3-slider--dragging' : ''
      }${disabled ? ' m3-slider--disabled' : ''}${className ? ` ${className}` : ''}`}
      style={styleVars}
    >
      {/* Accessible native input handling keyboard, pointer scrubbing, and screen readers */}
      <input
        id={id}
        type="range"
        className="m3-slider__native"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={ariaValueText}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      />

      {/* Visual Material 3 Expressive presentation */}
      <div className="m3-slider__visual" aria-hidden="true">
        {/* Active Track (straight boxy bar with subtle corner radius) */}
        <div
          className={`m3-slider__track-active${
            !hasActiveTrack ? ' m3-slider__track-active--hidden' : ''
          }${isAtMax ? ' m3-slider__track-active--full' : ''}`}
        />

        {/* Inactive Track (straight boxy bar with subtle corner radius) */}
        <div
          className={`m3-slider__track-inactive${
            !hasInactiveTrack ? ' m3-slider__track-inactive--hidden' : ''
          }${isAtMin ? ' m3-slider__track-inactive--full' : ''}`}
        >
          {/* Ceiling/End stop dot at max position (for continuous sliders) */}
          {showEndStop && !hasDiscreteStops && fraction < 0.88 && (
            <span className="m3-slider__stop-dot m3-slider__stop-dot--end" />
          )}
        </div>

        {/* Discrete stops along the track (like Alarm Volume in M3 Expressive) */}
        {hasDiscreteStops && (
          <div className="m3-slider__stops">
            {stopFractions.map((f, idx) => {
              // Hide stops directly under the handle or inside the gap
              if (Math.abs(f - fraction) < 0.035) return null
              const isActive = f < fraction
              return (
                <span
                  key={idx}
                  className={`m3-slider__stop-dot ${
                    isActive ? 'm3-slider__stop-dot--active' : 'm3-slider__stop-dot--inactive'
                  }`}
                  style={{
                    left: `calc(var(--m3-thumb-half-w) + ${f} * (100% - var(--m3-thumb-w)))`
                  }}
                />
              )
            })}
          </div>
        )}

        {/* Tall vertical rounded handle/thumb */}
        <div className="m3-slider__handle" />
      </div>
    </div>
  )
})
