import { useCallback, useEffect, useState } from 'react'
import type { RemotePlaylist, VideoSummary } from '../../../shared/types'

export interface RemotePlaylistState {
  playlist: RemotePlaylist | null
  items: VideoSummary[]
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
  reload: () => void
}

/**
 * Loads a public YouTube playlist and transparently appends further pages.
 * Shared by the remote playlist page and by saved YouTube playlists so both
 * stay in sync with YouTube instead of caching a stale copy.
 */
export function useRemotePlaylist(playlistId: string | null): RemotePlaylistState {
  const [playlist, setPlaylist] = useState<RemotePlaylist | null>(null)
  const [items, setItems] = useState<VideoSummary[]>([])
  const [continuation, setContinuation] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!playlistId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.api
      .getRemotePlaylist(playlistId)
      .then((result) => {
        if (cancelled) return
        setPlaylist(result)
        setItems(result.items)
        setContinuation(result.continuation)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [playlistId, nonce])

  const loadMore = useCallback((): void => {
    if (!continuation || loadingMore) return
    setLoadingMore(true)
    void window.api
      .remotePlaylistMore(continuation)
      .then((next) => {
        setItems((prev) => {
          const seen = new Set(prev.map((v) => v.videoId))
          return [...prev, ...next.items.filter((v) => !seen.has(v.videoId))]
        })
        setContinuation(next.continuation)
      })
      .catch(() => setContinuation(null))
      .finally(() => setLoadingMore(false))
  }, [continuation, loadingMore])

  const reload = useCallback((): void => setNonce((n) => n + 1), [])

  return {
    playlist,
    items,
    loading,
    loadingMore,
    error,
    hasMore: Boolean(continuation),
    loadMore,
    reload
  }
}
