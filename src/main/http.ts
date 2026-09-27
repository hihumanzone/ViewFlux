/**
 * Shared HTTP identity for every outbound request the app makes.
 *
 * YouTube serves the app's media and page requests differently depending on
 * whether they look like they came from the desktop client, the web client, or
 * something with no referer at all, so the same identity has to be attached in
 * the media proxy, the SponsorBlock/RYD calls and the session-level
 * `onBeforeSendHeaders` hook. Keeping one copy means a UA bump is a one-line
 * change instead of a hunt through three files.
 */

/**
 * A current Chrome-on-Windows UA. Sent so YouTube serves the app the same
 * streams it would serve the web player rather than the degraded mobile set.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** The page the app claims to be acting on behalf of. */
export const REFERER = 'https://www.youtube.com/'

/** Serialised form of {@link REFERER} — `Origin` is a scheme+host only. */
export const ORIGIN = 'https://www.youtube.com'

/**
 * Globals injected into every renderer request to YouTube's hosts. Chromium
 * otherwise sends the app's own `file://` origin, which the media endpoints
 * reject. Kept in sync with the proxy's own header set by importing from here.
 */
export const YOUTUBE_REQUEST_GLOBALS: Record<string, string> = {
  Referer: REFERER,
  Origin: ORIGIN
}
