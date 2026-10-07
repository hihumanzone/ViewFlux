import { Children, memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export interface MasonryGridProps {
  children: ReactNode
  /** Minimum column width in pixels (default: 290). */
  minColumnWidth?: number
  /** Spacing between columns and items in pixels (default: 20). */
  gap?: number
  /** Additional CSS class name on the container. */
  className?: string
  /** Inline styles for the container. */
  style?: CSSProperties
}

/** Calculates initial columns based on window dimensions to avoid initial layout flash. */
function getInitialColumns(minWidth: number, gap: number): number {
  if (typeof window === 'undefined') return 3
  const available = Math.max(300, window.innerWidth - 300)
  return Math.max(1, Math.floor((available + gap) / (minWidth + gap)))
}

/**
 * Material 3 Expressive Masonry Grid layout.
 *
 * Replaces rigid row-based CSS grids across the application.
 * - Every item receives identical column width.
 * - Items flow down vertical columns naturally according to their content height.
 * - Items are never stretched to match the height of neighboring items.
 * - Adjacent columns can sit at different heights with zero empty gaps.
 * - Gracefully accommodates mixed square and rectangular thumbnails, video cards,
 *   playlist cards, album cards, and channel cards side by side.
 */
export const MasonryGrid = memo(function MasonryGrid({
  children,
  minColumnWidth = 290,
  gap = 20,
  className = '',
  style
}: MasonryGridProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(() => getInitialColumns(minColumnWidth, gap))

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const updateColumns = (width: number) => {
      if (width <= 0) return
      const count = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
      setColumns((prev) => (prev !== count ? count : prev))
    }

    updateColumns(el.clientWidth)

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cr = entry.contentRect
          if (cr && cr.width > 0) {
            updateColumns(cr.width)
          }
        }
      })
      ro.observe(el)
      return () => ro.disconnect()
    }

    const onResize = () => {
      if (el) updateColumns(el.clientWidth)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [minColumnWidth, gap])

  const childList = Children.toArray(children).filter(Boolean)
  const colCount = Math.max(1, columns)

  // Partition items round-robin across columns to preserve left-to-right reading order
  const columnBuckets: ReactNode[][] = Array.from({ length: colCount }, () => [])
  childList.forEach((child, index) => {
    columnBuckets[index % colCount].push(child)
  })

  return (
    <div
      ref={containerRef}
      className={['masonry-grid', className].filter(Boolean).join(' ')}
      style={{
        ...style,
        ['--masonry-gap' as any]: `${gap}px`
      }}
    >
      {columnBuckets.map((bucket, colIndex) => (
        <div key={colIndex} className="masonry-grid__column">
          {bucket}
        </div>
      ))}
    </div>
  )
})
