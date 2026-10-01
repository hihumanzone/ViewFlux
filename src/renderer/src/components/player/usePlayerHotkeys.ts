import { useCallback, useEffect } from 'react'
import {
  isActivatable,
  isSpaceKey,
  isTypingTarget,
  type Chapter
} from './types'

export interface UsePlayerHotkeysProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  duration: number
  volume: number
  chapters?: Chapter[]
  menuOpen: boolean
  hasError?: boolean
  fullscreen?: boolean
  onDismissError?: () => void
  onTogglePlay: () => void
  onSeekBy: (delta: number) => void
  onSeekTo: (time: number) => void
  onPreviousChapter: () => void
  onNextChapter: () => void
  onChangeVolume: (volume: number) => void
  onToggleMute: () => void
  onToggleFullscreen: () => void
  onToggleCaptions: () => void
  onTogglePip: () => void
  onStepSpeed: (direction: -1 | 1) => void
  onCloseMenu: () => void
  onRevealControls: () => void
  onPreviousVideo?: () => void
  onNextVideo?: () => void
}

export function usePlayerHotkeys({
  containerRef,
  duration,
  volume,
  chapters = [],
  menuOpen,
  hasError,
  fullscreen,
  onDismissError,
  onTogglePlay,
  onSeekBy,
  onSeekTo,
  onPreviousChapter,
  onNextChapter,
  onChangeVolume,
  onToggleMute,
  onToggleFullscreen,
  onToggleCaptions,
  onTogglePip,
  onStepSpeed,
  onCloseMenu,
  onRevealControls,
  onPreviousVideo,
  onNextVideo
}: UsePlayerHotkeysProps) {
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent | KeyboardEvent) => {
      if (/^[0-9]$/.test(event.key) && duration > 0) {
        event.preventDefault()
        onSeekTo((Number(event.key) / 10) * duration)
        onRevealControls()
        return
      }

      switch (event.key) {
        case ' ':
        case 'Spacebar':
        case 'Space':
        case 'k':
        case 'K':
          event.preventDefault()
          onTogglePlay()
          break
        case 'j':
        case 'J':
          event.preventDefault()
          onSeekBy(-10)
          break
        case 'l':
        case 'L':
          event.preventDefault()
          onSeekBy(10)
          break
        case 'ArrowLeft':
          event.preventDefault()
          if (event.ctrlKey && chapters.length > 0) {
            onPreviousChapter()
          } else {
            onSeekBy(-5)
          }
          break
        case 'ArrowRight':
          event.preventDefault()
          if (event.ctrlKey && chapters.length > 0) {
            onNextChapter()
          } else {
            onSeekBy(5)
          }
          break
        case '[':
          event.preventDefault()
          onPreviousChapter()
          break
        case ']':
          event.preventDefault()
          onNextChapter()
          break
        case 'ArrowUp':
          event.preventDefault()
          onChangeVolume(volume + 0.05)
          break
        case 'ArrowDown':
          event.preventDefault()
          onChangeVolume(volume - 0.05)
          break
        case 'm':
        case 'M':
          event.preventDefault()
          onToggleMute()
          break
        case 'f':
        case 'F':
          event.preventDefault()
          onToggleFullscreen()
          break
        case 'c':
        case 'C': {
          const isCtrlOrMeta = event.ctrlKey || event.metaKey
          const selection = window.getSelection()
          const selectedText = selection ? selection.toString() : ''
          const hasSelection = selectedText.trim().length > 0

          if (isCtrlOrMeta) {
            if (hasSelection) {
              // Context-sensitive Ctrl+C:
              // If text is currently selected, Ctrl+C should copy that text and should not toggle captions.
              void navigator.clipboard.writeText(selectedText).catch(() => undefined)
              return
            } else {
              // If no text is selected, Ctrl+C should toggle captions as usual.
              event.preventDefault()
              onToggleCaptions()
              break
            }
          }

          // Plain 'c' or 'C' without Ctrl toggles captions as usual
          event.preventDefault()
          onToggleCaptions()
          break
        }
        case 'N':
          if (event.shiftKey && onNextVideo) {
            event.preventDefault()
            onNextVideo()
          }
          break
        case 'P':
          if (event.shiftKey && onPreviousVideo) {
            event.preventDefault()
            onPreviousVideo()
          }
          break
        case 'i':
        case 'I':
          event.preventDefault()
          onTogglePip()
          break
        case '<':
        case ',':
          event.preventDefault()
          onStepSpeed(-1)
          break
        case '>':
        case '.':
          event.preventDefault()
          onStepSpeed(1)
          break
        case 'Home':
          event.preventDefault()
          onSeekTo(0)
          break
        case 'End':
          if (duration > 0) {
            event.preventDefault()
            onSeekTo(duration - 0.1)
          }
          break
        case 'Escape':
          if (menuOpen) {
            event.preventDefault()
            onCloseMenu()
          } else if (hasError) {
            event.preventDefault()
            if (fullscreen) {
              onToggleFullscreen()
            } else if (onDismissError) {
              onDismissError()
            }
          }
          break
        default:
          break
      }
      onRevealControls()
    },
    [
      duration,
      volume,
      chapters.length,
      menuOpen,
      hasError,
      fullscreen,
      onDismissError,
      onTogglePlay,
      onSeekBy,
      onSeekTo,
      onPreviousChapter,
      onNextChapter,
      onChangeVolume,
      onToggleMute,
      onToggleFullscreen,
      onToggleCaptions,
      onTogglePip,
      onStepSpeed,
      onCloseMenu,
      onRevealControls,
      onPreviousVideo,
      onNextVideo
    ]
  )

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      const active = document.activeElement
      if (active && isTypingTarget(active)) return

      if (
        isSpaceKey(event) &&
        active !== null &&
        isActivatable(active) &&
        containerRef.current?.contains(active) === true
      ) {
        event.preventDefault()
      }
      onKeyDown(event)
    }

    window.addEventListener('keydown', handleWindowKeyDown)
    return () => window.removeEventListener('keydown', handleWindowKeyDown)
  }, [onKeyDown, containerRef])
}
