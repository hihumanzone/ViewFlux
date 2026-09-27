import { useEffect, useRef } from 'react'

/**
 * Bridges the app's player to the W3C Media Session API.
 *
 * Electron is Chromium, and Chromium implements the Media Session API on top of
 * the Windows `SystemMediaTransportControls` (SMTC) flyout. That means the
 * hardware media keys, the lock-screen transport controls and the Windows
 * volume-flyout "now playing" card are all driven by these calls - no native
 * addon or extra IPC is required.
 *
 * Two rules matter for a good OS integration:
 *  - every `setActionHandler` must be wrapped in `try/catch`; unsupported
 *    actions reject with a `NotSupportedError` and an uncaught one would break
 *    playback entirely.
 *  - `setPositionState` is validated strictly (finite, non-negative duration,
 *    position within the duration) and throws on bad input, so every value is
 *    clamped before it is handed over.
 */

export interface MediaSessionInfo {
  /** Video title - shown as the primary line in the OS card. */
  title: string
  /** Channel name - the secondary line. */
  artist: string
  /** Optional grouping line, e.g. the playlist the video came from. */
  album?: string
  /** Cover art URL. YouTube thumbnails are already 16:9, so `16x9` is used. */
  artwork?: string | null
  playing: boolean
  position: number
  duration: number
  /** When false the OS session is torn down entirely. */
  active: boolean
}

export interface MediaSessionHandlers {
  play: () => void
  pause: () => void
  /** Optional; the OS card hides the stop button when absent. */
  stop?: () => void
  seekBackward: (seconds: number) => void
  seekForward: (seconds: number) => void
  seekTo: (seconds: number) => void
  previous?: () => void
  next?: () => void
}

function supports(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator
}

/** `MediaSessionAction` is a DOM global, so the local union is renamed. */
type MediaActionName =
  | 'play'
  | 'pause'
  | 'stop'
  | 'seekbackward'
  | 'seekforward'
  | 'seekto'
  | 'previoustrack'
  | 'nexttrack'

/**
 * The DOM lib types `setActionHandler` with per-action overloads whose handler
 * signatures disagree, which makes a generic helper impossible to satisfy.
 * The runtime contract is uniform, so one loosely-typed shim is used instead.
 */
const setAction = (
  action: MediaActionName,
  handler: ((details: MediaSessionActionDetails) => void) | null
): void => {
  try {
    const register = navigator.mediaSession.setActionHandler as unknown as (
      a: MediaActionName,
      h: ((details: MediaSessionActionDetails) => void) | null
    ) => void
    register(action, handler)
  } catch {
    // Unsupported actions reject with NotSupportedError - ignore those.
  }
}

/** Wraps a no-argument callback so it satisfies the uniform handler type. */
const noArgs = (fn: () => void): ((details: MediaSessionActionDetails) => void) => {
  return () => fn()
}

const ALL_ACTIONS: MediaActionName[] = [
  'play',
  'pause',
  'stop',
  'seekbackward',
  'seekforward',
  'seekto',
  'previoustrack',
  'nexttrack'
]

export function useMediaSession(info: MediaSessionInfo, handlers: MediaSessionHandlers): void {
  // Keep the latest handlers in a ref so the OS bindings are registered once
  // and never have to be torn down/re-registered on every render.
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const { title, artist, album, artwork, playing, position, duration, active } = info

  // ---- Metadata -------------------------------------------------------------
  useEffect(() => {
    if (!supports()) return
    if (!active) {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = 'none'
      return
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title || 'Unknown video',
        artist: artist || '',
        album: album || '',
        artwork: artwork ? [{ src: artwork, sizes: '16x9', type: 'image/jpeg' }] : []
      })
    } catch {
      navigator.mediaSession.metadata = null
    }
  }, [active, title, artist, album, artwork])

  // ---- Playback state -------------------------------------------------------
  useEffect(() => {
    if (!supports()) return
    navigator.mediaSession.playbackState = active ? (playing ? 'playing' : 'paused') : 'none'
  }, [active, playing])

  // ---- Action handlers ------------------------------------------------------
  useEffect(() => {
    if (!supports()) return
    if (!active) {
      for (const action of ALL_ACTIONS) setAction(action, null)
      return
    }
    setAction('play', noArgs(() => handlersRef.current.play()))
    setAction('pause', noArgs(() => handlersRef.current.pause()))
    setAction(
      'stop',
      handlersRef.current.stop ? noArgs(() => handlersRef.current.stop?.()) : null
    )
    setAction('seekbackward', (details) => {
      const delta = details.seekOffset
      handlersRef.current.seekBackward(typeof delta === 'number' && delta > 0 ? delta : 10)
    })
    setAction('seekforward', (details) => {
      const delta = details.seekOffset
      handlersRef.current.seekForward(typeof delta === 'number' && delta > 0 ? delta : 10)
    })
    setAction('seekto', (details) => {
      if (typeof details.seekTime === 'number' && Number.isFinite(details.seekTime)) {
        handlersRef.current.seekTo(details.seekTime)
      }
    })
    setAction(
      'previoustrack',
      handlersRef.current.previous ? noArgs(() => handlersRef.current.previous?.()) : null
    )
    setAction(
      'nexttrack',
      handlersRef.current.next ? noArgs(() => handlersRef.current.next?.()) : null
    )
  }, [active])

  // ---- Position state -------------------------------------------------------
  // The OS extrapolates from the last reported position, so publishing only on
  // `timeupdate` (~4 Hz) leaves the Windows scrubber visibly stuttering. A
  // one-second heartbeat fills the gaps while playing. Both the publisher and
  // the clock live in refs so that a new `position` value never restarts the
  // interval.
  const publishRef = useRef<(position: number, duration: number, rate: number) => void>(() => undefined)
  publishRef.current = (pos: number, dur: number, rate: number): void => {
    if (!supports() || !active) return
    if (!Number.isFinite(dur) || dur <= 0) return
    const clamped = Math.max(0, Math.min(pos, dur))
    try {
      navigator.mediaSession.setPositionState({ duration: dur, position: clamped, playbackRate: rate })
    } catch {
      // Chromium rejects non-finite / out-of-range positions; ignore.
    }
  }

  const clockRef = useRef({ position, duration, playing })
  clockRef.current = { position, duration, playing }

  // Publish immediately so a seek while paused is reflected in the OS card.
  useEffect(() => {
    publishRef.current(clockRef.current.position, duration, playing ? 1 : 0)
  }, [position, duration, playing, active])

  useEffect(() => {
    if (!supports() || !active || !playing) return
    const id = window.setInterval(() => {
      const { position: pos, duration: dur } = clockRef.current
      publishRef.current(Math.min(pos + 1, dur), dur, 1)
    }, 1000)
    return () => window.clearInterval(id)
  }, [active, playing])
}
