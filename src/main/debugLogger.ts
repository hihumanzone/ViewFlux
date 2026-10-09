import type { BrowserWindow } from 'electron'
import type { PlaybackLogEntry } from '../shared/types'

let targetWindow: BrowserWindow | null = null

export function setDebugLoggerWindow(window: BrowserWindow | null): void {
  targetWindow = window
}

let entryCounter = 0

export function emitPlayerDebugLog(
  entry: Omit<PlaybackLogEntry, 'id' | 'timestamp' | 'isoTime'>
): void {
  const now = new Date()
  const isoTime = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0')
  entryCounter++
  const fullEntry: PlaybackLogEntry = {
    id: `main-${Date.now()}-${entryCounter}`,
    timestamp: now.getTime(),
    isoTime,
    ...entry
  }

  // Also print to main stdout/stderr for dev console tracing
  const tag = `[${fullEntry.subsystem}]`
  const prefix = `[${fullEntry.isoTime}] ${tag} ${fullEntry.action}:`
  if (fullEntry.level === 'error') {
    console.error(prefix, fullEntry.message, fullEntry.rawError ?? fullEntry.data ?? '')
  } else if (fullEntry.level === 'warn') {
    console.warn(prefix, fullEntry.message, fullEntry.data ?? '')
  } else {
    console.log(prefix, fullEntry.message, fullEntry.data ?? '')
  }

  if (targetWindow && !targetWindow.isDestroyed()) {
    try {
      targetWindow.webContents.send('player:debug-log', fullEntry)
    } catch {
      /* window might be closing */
    }
  }
}
