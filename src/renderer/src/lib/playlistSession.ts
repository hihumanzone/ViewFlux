export interface PlaylistSessionState {
  playlistId: string
  speed: number | null
  volume: number | null
  captionsEnabled: boolean | null
  fullscreen: boolean | null
}

let activeSession: PlaylistSessionState | null = null

/**
 * Returns the active playlist session if listId matches, or initializes a new session.
 * Returns null if listId is null or empty.
 */
export function getPlaylistSession(listId: string | null): PlaylistSessionState | null {
  if (!listId) {
    if (activeSession) {
      clearPlaylistSession()
    }
    return null
  }

  if (activeSession && activeSession.playlistId !== listId) {
    clearPlaylistSession()
  }

  if (!activeSession) {
    activeSession = {
      playlistId: listId,
      speed: null,
      volume: null,
      captionsEnabled: null,
      fullscreen: typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false
    }
  }

  return activeSession
}

/**
 * Updates the custom playback speed for the active playlist session.
 */
export function setPlaylistSpeed(listId: string, speed: number): void {
  if (activeSession && activeSession.playlistId === listId) {
    activeSession.speed = speed
  }
}

/**
 * Updates the custom volume for the active playlist session.
 */
export function setPlaylistVolume(listId: string, volume: number): void {
  if (activeSession && activeSession.playlistId === listId) {
    activeSession.volume = volume
  }
}

/**
 * Updates the captions visibility preference for the active playlist session.
 */
export function setPlaylistCaptions(listId: string, enabled: boolean): void {
  if (activeSession && activeSession.playlistId === listId) {
    activeSession.captionsEnabled = enabled
  }
}

/**
 * Updates the fullscreen state for the active playlist session.
 */
export function setPlaylistFullscreen(listId: string, isFullscreen: boolean): void {
  if (activeSession && activeSession.playlistId === listId) {
    activeSession.fullscreen = isFullscreen
  }
}

/**
 * Clears the active playlist session and reverts any session-scoped state (e.g. fullscreen).
 */
export function clearPlaylistSession(): void {
  if (activeSession) {
    // If we were in fullscreen during this playlist session, exit fullscreen so we revert to default
    if (activeSession.fullscreen && typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    }
    activeSession = null
  }
}
