import { useCallback, useEffect, useRef, useState } from 'react'
import type { SetStateAction } from 'react'

export interface AsyncResource<T> {
  /** Last resolved value, or `undefined` before the first success. */
  data: T | undefined
  /** Message of the last failure, reset when a new run starts. */
  error: string | null
  /** True while a run is in flight. */
  loading: boolean
  /** Re-runs the effect without changing its inputs. */
  reload: () => void
  /** Patch the value in place, for optimistic updates. */
  setData: (value: SetStateAction<T | undefined>) => void
}

export interface UseAsyncOptions<T> {
  /** While false the effect is skipped and `loading` stays false. */
  enabled?: boolean
  /** Value to report before the first run resolves. */
  initialData?: T
  /**
   * Keep the previous `data` visible while a new run is in flight instead of
   * clearing it. Use for screens that append to a list, or where a reload
   * should not blank the page.
   */
  keepPreviousData?: boolean
}

/**
 * Runs an async loader whenever `deps` change, giving every call site the two
 * things they were all spelling out by hand: a cancellation guard (so a slow
 * response can't stomp state after its inputs changed, or after unmount) and
 * `loading` / `error` bookkeeping.
 *
 * `run` is held in a ref, so an inline closure does not re-trigger the effect.
 * The dep list stays the single source of truth for when to refetch — which is
 * what you want, because a refetch driven by a function identity is how you
 * accidentally build an infinite request loop.
 */
export function useAsync<T>(
  run: () => Promise<T>,
  deps: readonly unknown[],
  options: UseAsyncOptions<T> = {}
): AsyncResource<T> {
  const { enabled = true, initialData, keepPreviousData = false } = options

  const [data, setData] = useState<T | undefined>(initialData)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [nonce, setNonce] = useState(0)

  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    if (!enabled) {
      // Drop the previous result: a disabled source has no value, and leaving a
      // stale one on screen is worse than an honest empty state.
      if (!keepPreviousData) setData(undefined)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    if (!keepPreviousData) setData(undefined)
    void runRef.current().then(
      (value) => {
        if (cancelled) return
        setData(value)
        setLoading(false)
      },
      (reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, keepPreviousData, nonce, ...deps])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { data, error, loading, reload, setData }
}

/**
 * Same ergonomics as {@link useAsync} for fire-and-forget side effects driven
 * by props or settings (persisting a setting, firing a request whose result is
 * only ever used for a toast). Rejects are logged rather than surfaced, because
 * there is nothing to render — prefer {@link useAsync} when there is.
 */
export function useAsyncEffect(
  run: () => void | Promise<unknown>,
  deps: readonly unknown[],
  options: { enabled?: boolean } = {}
): void {
  const { enabled = true } = options
  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    if (!enabled) return
    void Promise.resolve()
      .then(() => runRef.current())
      .catch((reason: unknown) => {
        console.warn('[renderer] async effect failed', reason)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])
}
