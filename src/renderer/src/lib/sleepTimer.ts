import { useSyncExternalStore } from 'react'

export interface SleepTimerState {
  minutes: number | null
  remainingSec: number | null
  endTimestamp: number | null
}

let currentState: SleepTimerState = {
  minutes: null,
  remainingSec: null,
  endTimestamp: null
}

const listeners = new Set<() => void>()
let timerInterval: number | null = null

let activeVideo: HTMLVideoElement | null = null
let activeShowOsd: ((text: string, icon?: string) => void) | null = null

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function stopInterval(): void {
  if (timerInterval !== null) {
    window.clearInterval(timerInterval)
    timerInterval = null
  }
}

export function getSleepTimerState(): SleepTimerState {
  return currentState
}

export function subscribeSleepTimer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSleepTimer(): SleepTimerState {
  return useSyncExternalStore(subscribeSleepTimer, getSleepTimerState)
}

/**
 * Registers the active player video element and OSD display callback.
 * Returns an unregister function.
 */
export function registerActivePlayer(
  video: HTMLVideoElement | null,
  showOsd: (text: string, icon?: string) => void
): () => void {
  activeVideo = video
  activeShowOsd = showOsd

  return () => {
    if (activeVideo === video) {
      activeVideo = null
    }
    if (activeShowOsd === showOsd) {
      activeShowOsd = null
    }
  }
}

/**
 * Completely clears and turns off the sleep timer.
 */
export function clearSleepTimer(): void {
  stopInterval()
  currentState = {
    minutes: null,
    remainingSec: null,
    endTimestamp: null
  }
  notify()
}

/**
 * Sets or turns off the sleep timer.
 */
export function setSleepTimer(minutes: number | null, video?: HTMLVideoElement | null): void {
  stopInterval()

  const targetVideo = video ?? activeVideo

  if (minutes === null) {
    currentState = {
      minutes: null,
      remainingSec: null,
      endTimestamp: null
    }
    notify()
    activeShowOsd?.('Sleep timer off', 'timer')
  } else if (minutes === -1) {
    let remainingSec: number | null = null
    if (targetVideo && targetVideo.duration > 0) {
      remainingSec = Math.max(0, Math.round(targetVideo.duration - targetVideo.currentTime))
    }
    currentState = {
      minutes: -1,
      remainingSec,
      endTimestamp: null
    }
    notify()
    activeShowOsd?.('Sleep timer: end of video', 'timer')
  } else {
    const totalSec = Math.round(minutes * 60)
    const endTimestamp = Date.now() + totalSec * 1000

    currentState = {
      minutes,
      remainingSec: totalSec,
      endTimestamp
    }
    notify()
    activeShowOsd?.(`Sleep timer: ${minutes}m`, 'timer')

    timerInterval = window.setInterval(() => {
      if (!currentState.endTimestamp) return
      const left = Math.max(0, Math.round((currentState.endTimestamp - Date.now()) / 1000))

      if (left <= 0) {
        stopInterval()
        currentState = {
          minutes: null,
          remainingSec: null,
          endTimestamp: null
        }
        notify()
        try {
          activeVideo?.pause()
        } catch {
          // Ignore
        }
        activeShowOsd?.('Sleep timer paused playback', 'timer')
      } else {
        currentState = {
          ...currentState,
          remainingSec: left
        }
        notify()
      }
    }, 1000)
  }
}

/**
 * Updates remaining seconds when in "End of video" mode.
 */
export function updateEndOfVideoRemaining(remainingSec: number): void {
  if (currentState.minutes !== -1) return
  if (currentState.remainingSec !== remainingSec) {
    currentState = {
      ...currentState,
      remainingSec
    }
    notify()
  }
}

/**
 * Triggered when playback ends while "End of video" sleep timer is set.
 */
export function onEndOfVideoReached(video?: HTMLVideoElement | null): void {
  if (currentState.minutes !== -1) return
  const target = video ?? activeVideo
  try {
    target?.pause()
  } catch {
    // Ignore
  }
  clearSleepTimer()
  activeShowOsd?.('Sleep timer paused video', 'timer')
}
