import { useCallback } from 'react'
import { useApp } from '../state/AppContext'

/**
 * Copying a link is the app's only external-URL action — there is deliberately
 * no "open on YouTube" anywhere, so these builders are the single place that
 * knows YouTube's URL shapes.
 */

export function videoUrl(id: string): string {
  return `https://youtu.be/${id}`
}

export function playlistUrl(id: string): string {
  return `https://www.youtube.com/playlist?list=${id}`
}

export function channelUrl(id: string): string {
  if (id.startsWith('@')) return `https://www.youtube.com/${id}`
  return `https://www.youtube.com/channel/${id}`
}

/**
 * Hands a link to the system browser, reporting failure instead of swallowing
 * it — a dead link chip or an unregistered protocol handler otherwise looks
 * like an unresponsive app.
 */
export function useOpenExternal(): (url: string) => void {
  const { toast } = useApp()
  return useCallback(
    (url: string) => {
      void window.api
        .openExternal(url)
        .catch(() => toast('Could not open that link', { timeout: 5000 }))
    },
    [toast]
  )
}

/**
 * Copies `url` to the clipboard and confirms with a toast. Returns the copied
 * url so callers can chain it off a menu item's `onSelect`.
 */
export function useCopyLink(): (url: string, message?: string) => void {
  const { toast } = useApp()
  return useCallback(
    (url: string, message = 'Link copied to clipboard') => {
      // The async clipboard API rejects when the document is not focused, which
      // happens whenever a copy is triggered from the Windows media overlay.
      void navigator.clipboard
        .writeText(url)
        .then(() => toast(message))
        .catch(() => toast('Could not copy the link', { timeout: 5000 }))
    },
    [toast]
  )
}
