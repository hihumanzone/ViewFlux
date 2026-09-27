import { useCallback, useEffect, useState } from 'react'

/**
 * Tracks whether a remote image URL failed to load, and re-arms itself when the
 * URL changes.
 *
 * Channel avatars and thumbnails come from YouTube's CDN without referrer
 * headers, so they intermittently 404 or get blocked. The failure has to be
 * remembered per-URL: without the reset a later, valid avatar for the same
 * channel would stay hidden forever, and without the "this exact URL broke"
 * check a new URL would be wrongly treated as already-broken.
 *
 * This pattern was copy-pasted into VideoCard, ChannelCard and ChannelLine with
 * subtly different bugs; one hook keeps them consistent.
 */
export function useBrokenImage(url: string | null | undefined): {
  broken: boolean
  onError: () => void
} {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)

  useEffect(() => {
    setBrokenUrl((current) => (current !== null && current !== url ? null : current))
  }, [url])

  const onError = useCallback(() => {
    setBrokenUrl(url ?? null)
  }, [url])

  return { broken: Boolean(url) && brokenUrl === url, onError }
}
