import { useEffect, useState } from 'react'

/**
 * Channel pictures are *not* always in the search payloads. Playlist lockups
 * ship `metadata.image === null` and music results have no thumbnail on the
 * author node at all, yet both carry the author's browse id. So when a card has
 * an id but no picture we ask the main process for the channel, which is
 * already cached there, rather than digging through node shapes that may move
 * again next week.
 */

/** id -> url, or `null` for "this channel has no picture" (cached to avoid re-asking). */
const cache = new Map<string, string | null>()

/** Ids already queued or resolved, so N rows of one channel only ask once. */
const requested = new Set<string>()

/** Ids wanted by components that mounted during this tick. */
let batch: string[] = []

let scheduled = false
const listeners = new Set<() => void>()

function publish(): void {
  for (const listener of listeners) listener()
}

function flush(): void {
  scheduled = false
  const ids = [...new Set(batch)]
  batch = []
  if (ids.length === 0) return
  void window.api
    .getChannelAvatars(ids)
    .then((resolved) => {
      for (const id of ids) cache.set(id, resolved[id] ?? null)
    })
    .catch(() => {
      // Best-effort enhancement: a failed batch leaves the initials fallback in
      // place and lets a later mount ask again.
      for (const id of ids) requested.delete(id)
    })
    .finally(publish)
}

function request(ids: string[]): void {
  const fresh = ids.filter((id) => !requested.has(id) && !cache.has(id))
  if (fresh.length === 0) return
  for (const id of fresh) requested.add(id)
  // React commits every card of a result grid in one pass, so gathering on a
  // microtask and flushing once turns 20 rows into a single `channel:avatar` call.
  batch = [...batch, ...fresh]
  if (!scheduled) {
    scheduled = true
    queueMicrotask(flush)
  }
}

/** Pre-warms the cache for a list of rows without mounting anything. */
export function primeChannelAvatars(ids: (string | null | undefined)[]): void {
  request(ids.filter((id): id is string => Boolean(id)))
}

/**
 * Resolves a channel avatar, preferring whatever the payload already gave us and
 * only falling back to a channel lookup when it did not. Shows the initials
 * fallback until the picture arrives.
 */
export function useChannelAvatar(
  channelId: string | null,
  initial?: string | null
): string | null {
  const [resolved, setResolved] = useState<string | null>(() => {
    if (initial) return initial
    if (!channelId) return null
    return cache.get(channelId) ?? null
  })

  useEffect(() => {
    if (initial) {
      setResolved(initial)
      return
    }
    if (!channelId) {
      setResolved(null)
      return
    }
    const cached = cache.get(channelId)
    if (cached !== undefined) {
      setResolved(cached)
      return
    }

    setResolved(null)
    const onChange = (): void => {
      const next = cache.get(channelId)
      if (next !== undefined) setResolved(next)
    }
    listeners.add(onChange)
    request([channelId])
    return () => {
      listeners.delete(onChange)
    }
  }, [channelId, initial])

  return resolved
}
