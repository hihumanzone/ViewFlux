import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'

interface TooltipPosition {
  top: number
  left: number
  text: string
  copied: boolean
}

export function SelectionCopyTooltip(): React.JSX.Element | null {
  const [pos, setPos] = useState<TooltipPosition | null>(null)
  const timerRef = useRef<number | null>(null)
  const upTimerRef = useRef<number | null>(null)
  const isMouseDownRef = useRef(false)

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent): void => {
      // Track left mouse button down
      if (e.button === 0) {
        isMouseDownRef.current = true
      }
    }

    const checkSelection = (fromPointerUp = false): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPos(null)
        return
      }

      const text = selection.toString().trim()
      if (!text) {
        setPos(null)
        return
      }

      // Do not show copy pill when typing/selecting inside standard text inputs
      const anchorNode = selection.anchorNode
      const targetEl = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement
      if (targetEl?.closest('input, textarea, select, [contenteditable="true"]')) {
        setPos(null)
        return
      }

      try {
        const range = selection.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) {
          setPos(null)
          return
        }

        // When selection was made via left-click mouse release, auto-copy to clipboard
        if (fromPointerUp) {
          void navigator.clipboard.writeText(text).catch(() => undefined)
        }

        const top = rect.top >= 48 ? rect.top - 38 : rect.bottom + 8
        const left = Math.max(12, Math.min(window.innerWidth - 110, rect.left + rect.width / 2 - 45))

        setPos((prev) => ({
          top,
          left,
          text,
          copied: fromPointerUp ? true : (prev?.text === text ? prev.copied : false)
        }))

        if (fromPointerUp) {
          if (timerRef.current) window.clearTimeout(timerRef.current)
          timerRef.current = window.setTimeout(() => {
            setPos((curr) => (curr ? { ...curr, copied: false } : null))
          }, 2000)
        }
      } catch {
        setPos(null)
      }
    }

    const handlePointerUp = (e: MouseEvent): void => {
      if (e.button === 0) {
        isMouseDownRef.current = false
        if (upTimerRef.current) window.clearTimeout(upTimerRef.current)
        upTimerRef.current = window.setTimeout(() => checkSelection(true), 10)
      }
    }

    const handleSelectionChange = (): void => {
      // Don't reposition continuously while user is still actively dragging
      if (isMouseDownRef.current) return
      checkSelection(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('mouseup', handlePointerUp)
    document.addEventListener('selectionchange', handleSelectionChange)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('mouseup', handlePointerUp)
      document.removeEventListener('selectionchange', handleSelectionChange)
      if (timerRef.current) window.clearTimeout(timerRef.current)
      if (upTimerRef.current) window.clearTimeout(upTimerRef.current)
    }
  }, [])

  if (!pos || typeof document === 'undefined') return null

  const handleCopyClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    void navigator.clipboard.writeText(pos.text).catch(() => undefined)
    setPos((prev) => (prev ? { ...prev, copied: true } : null))
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      setPos((curr) => (curr ? { ...curr, copied: false } : null))
    }, 2000)
  }

  return createPortal(
    <button
      type="button"
      className={`selection-copy-pill${pos.copied ? ' selection-copy-pill--copied' : ''}`}
      style={{
        top: `${pos.top}px`,
        left: `${pos.left}px`
      }}
      onMouseDown={(e) => {
        // Prevent clearing text selection when clicking the pill
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={handleCopyClick}
      title="Copy selected text"
      aria-label="Copy selected text"
    >
      <Icon name={pos.copied ? 'check' : 'copy'} size={14} />
      <span>{pos.copied ? 'Copied!' : 'Copy'}</span>
    </button>,
    document.body
  )
}
