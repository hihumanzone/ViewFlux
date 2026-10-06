import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatus } from '../shared/types'

let status: UpdaterStatus = {
  state: 'idle',
  currentVersion: app.getVersion()
}

function broadcastStatus(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater:status', status)
    }
  }
}

function setStatus(patch: Partial<UpdaterStatus>): UpdaterStatus {
  status = {
    ...status,
    ...patch,
    currentVersion: app.getVersion()
  }
  broadcastStatus()
  return status
}

/** Check GitHub releases API as a fallback, with unthrottled web redirect fallback on 403 */
async function checkGitHubApi(): Promise<UpdaterStatus> {
  try {
    let tag = ''
    let releaseNotes: string | undefined
    let releaseDate: string | undefined

    try {
      const res = await fetch('https://api.github.com/repos/hihumanzone/ViewFlux/releases/latest', {
        headers: {
          'User-Agent': `ViewFlux/${app.getVersion()} (electron)`
        }
      })
      if (res.ok) {
        const data = (await res.json()) as { tag_name?: string; body?: string; published_at?: string }
        tag = (data.tag_name ?? '').replace(/^v/, '')
        releaseNotes = data.body
        releaseDate = data.published_at
      } else if (res.status === 404) {
        return setStatus({ state: 'not-available' })
      }
    } catch {
      // API call failed, proceed to unthrottled redirect fallback
    }

    // If GitHub API rate-limited (status 403) or failed, query the public web redirect which has no rate limits
    if (!tag) {
      try {
        const redirectRes = await fetch('https://github.com/hihumanzone/ViewFlux/releases/latest', {
          method: 'HEAD',
          redirect: 'manual'
        })
        const location = redirectRes.headers.get('location') || ''
        const match = location.match(/releases\/tag\/v?([0-9.]+)/)
        if (match) {
          tag = match[1]
        }
      } catch {
        // Both API and web redirect failed
      }
    }

    if (tag) {
      const current = app.getVersion()
      if (isNewerVersion(tag, current)) {
        return setStatus({
          state: 'available',
          availableVersion: tag,
          releaseNotes,
          releaseDate
        })
      }
      return setStatus({ state: 'not-available' })
    }

    return setStatus({ state: 'not-available' })
  } catch (err) {
    return setStatus({
      state: 'error',
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function isNewerVersion(latest: string, current: string): boolean {
  const l = latest.split('.').map((p) => parseInt(p, 10) || 0)
  const c = current.split('.').map((p) => parseInt(p, 10) || 0)
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lPart = l[i] ?? 0
    const cPart = c[i] ?? 0
    if (lPart > cPart) return true
    if (lPart < cPart) return false
  }
  return false
}

export function initAutoUpdater(): () => void {
  // Configure electron-updater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => {
    setStatus({ state: 'checking', error: undefined })
  })

  autoUpdater.on('update-available', (info) => {
    setStatus({
      state: 'available',
      availableVersion: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
    })
  })

  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'not-available', error: undefined })
  })

  autoUpdater.on('download-progress', (progressObj) => {
    setStatus({
      state: 'downloading',
      progress: {
        percent: Math.round(progressObj.percent),
        bytesPerSecond: Math.round(progressObj.bytesPerSecond),
        transferred: progressObj.transferred,
        total: progressObj.total
      }
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setStatus({
      state: 'downloaded',
      availableVersion: info.version,
      error: undefined
    })
  })

  autoUpdater.on('error', (err) => {
    console.log('[updater] autoUpdater error, falling back to unthrottled release check:', err?.message)
    void checkGitHubApi()
  })

  // IPC handlers
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      return checkGitHubApi()
    }
    try {
      setStatus({ state: 'checking', error: undefined })
      await autoUpdater.checkForUpdates()
      return status
    } catch {
      return checkGitHubApi()
    }
  })

  ipcMain.handle('updater:install', () => {
    if (status.state === 'downloaded') {
      autoUpdater.quitAndInstall()
    }
  })

  ipcMain.handle('updater:get-status', () => status)

  // Initial check after app starts
  const initialTimer = setTimeout(() => {
    if (app.isPackaged) {
      void autoUpdater.checkForUpdates().catch(() => {
        void checkGitHubApi()
      })
    } else {
      void checkGitHubApi()
    }
  }, 6000)

  // Check periodically every 4 hours. The timer is returned so graceful
  // shutdown can clear it — otherwise the dangling interval keeps the main
  // event loop alive after the window closes and the next launch finds a
  // stale Singleton lock with no window to focus.
  const timer = setInterval(() => {
    if (app.isPackaged) {
      void autoUpdater.checkForUpdates().catch(() => {})
    }
  }, 4 * 60 * 60 * 1000)

  return () => {
    clearTimeout(initialTimer)
    clearInterval(timer)
  }
}
