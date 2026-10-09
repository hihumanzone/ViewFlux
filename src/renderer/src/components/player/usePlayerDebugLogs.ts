import { useCallback, useEffect, useState } from 'react'
import type { PlaybackLogEntry } from '../../../../shared/types'

const MAX_LOGS = 500

// In-memory circular buffer shared across player instance
const logBuffer: PlaybackLogEntry[] = []
const listeners = new Set<(logs: PlaybackLogEntry[]) => void>()

let clientCounter = 0

function notifyListeners(): void {
  const snapshot = [...logBuffer]
  for (const listener of listeners) {
    try {
      listener(snapshot)
    } catch {
      /* ignore */
    }
  }
}

export function appendPlayerDebugLog(
  entry: Omit<PlaybackLogEntry, 'id' | 'timestamp' | 'isoTime'>
): void {
  const now = new Date()
  const isoTime =
    now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0')
  clientCounter++

  const fullEntry: PlaybackLogEntry = {
    id: `rndr-${Date.now()}-${clientCounter}`,
    timestamp: now.getTime(),
    isoTime,
    ...entry
  }

  logBuffer.push(fullEntry)
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.splice(0, logBuffer.length - MAX_LOGS)
  }

  notifyListeners()
}

export function clearPlayerDebugLogs(): void {
  logBuffer.length = 0
  notifyListeners()
}

export function formatLogsForClipboard(logs: PlaybackLogEntry[]): string {
  if (logs.length === 0) return 'No playback debug logs recorded.'

  const header = [
    '# ViewFlux Playback Debug Log Trace',
    `Generated at: ${new Date().toISOString()}`,
    `Total Events: ${logs.length}`,
    '------------------------------------------------------------',
    ''
  ].join('\n')

  const lines = logs.map((log) => {
    const parts = [
      `[${log.isoTime}] [${log.level.toUpperCase()}] [${log.subsystem}] [${log.action}] ${log.message}`
    ]
    if (log.trigger) parts.push(`  Trigger:    ${log.trigger}`)
    if (log.nextStep) parts.push(`  Next Step:  ${log.nextStep}`)
    if (log.rawError) parts.push(`  Raw Error:  ${log.rawError}`)
    if (log.data && Object.keys(log.data).length > 0) {
      try {
        parts.push(`  Payload:    ${JSON.stringify(log.data)}`)
      } catch {
        /* ignore serialization error */
      }
    }
    return parts.join('\n')
  })

  return header + lines.join('\n\n')
}

export function usePlayerDebugLogs() {
  const [logs, setLogs] = useState<PlaybackLogEntry[]>(() => [...logBuffer])

  useEffect(() => {
    const listener = (updated: PlaybackLogEntry[]): void => {
      setLogs(updated)
    }
    listeners.add(listener)

    // Subscribe to Main Process proxy/manifest logs via preload IPC
    const unsubscribeIpc = window.api.onPlayerDebugLog?.((entry) => {
      logBuffer.push(entry)
      if (logBuffer.length > MAX_LOGS) {
        logBuffer.splice(0, logBuffer.length - MAX_LOGS)
      }
      notifyListeners()
    })

    return () => {
      listeners.delete(listener)
      unsubscribeIpc?.()
    }
  }, [])

  const log = useCallback(
    (
      level: PlaybackLogEntry['level'],
      subsystem: PlaybackLogEntry['subsystem'],
      action: string,
      message: string,
      extras?: {
        trigger?: string
        nextStep?: string
        rawError?: string
        data?: Record<string, unknown>
      }
    ) => {
      appendPlayerDebugLog({
        level,
        subsystem,
        action,
        message,
        trigger: extras?.trigger,
        nextStep: extras?.nextStep,
        rawError: extras?.rawError,
        data: extras?.data
      })
    },
    []
  )

  const clear = useCallback(() => {
    clearPlayerDebugLogs()
  }, [])

  return {
    logs,
    log,
    clear,
    clearLogs: clear,
    copyToClipboard: useCallback(() => formatLogsForClipboard(logs), [logs])
  }
}
