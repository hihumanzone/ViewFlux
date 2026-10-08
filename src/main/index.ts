import { app, BrowserWindow, ipcMain, shell, session, Menu } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from './store'
import { YoutubeService } from './youtube'
import { MediaProxy } from './proxy'
import { fetchDislikes, fetchSponsorSegments } from './services'
import { YOUTUBE_REQUEST_GLOBALS } from './http'
import { initAutoUpdater } from './updater'
import type {
  ChannelSort,
  HistoryEntry,
  PlaylistSource,
  PlaylistVideo,
  SavedChannel,
  SearchFilter,
  Settings
} from '../shared/types'

const store = new Store()
const youtube = new YoutubeService()
const proxy = new MediaProxy({
  getManifest: (videoId, force) => youtube.getManifest(videoId, force)
})

let mainWindow: BrowserWindow | null = null
let cleanupUpdater: (() => void) | null = null
let isQuitting = false

/**
 * Resolves the application icon across development and packaged builds.
 * On Linux, passing this icon to BrowserWindow sets the _NET_WM_ICON property
 * on the X11 window as a direct fallback for environments or taskbars that do
 * not associate through the .desktop file.
 */
function getAppIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../../build/icon.png'),
    join(__dirname, '../../../build/icon.png'),
    join(process.resourcesPath, 'build/icon.png'),
    join(process.resourcesPath, 'icon.png'),
    join(app.getAppPath(), 'build/icon.png')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return undefined
}

function setupAppMenu(): void {
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: 'ViewFlux on GitHub',
            click: async () => {
              await shell.openExternal('https://github.com/hihumanzone/ViewFlux')
            }
          }
        ]
      }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  } else {
    Menu.setApplicationMenu(null)
  }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    title: 'ViewFlux',
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0c10',
    autoHideMenuBar: !isMac,
    icon: getAppIcon(),
    ...(isMac
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 16, y: 12 }
        }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#101318',
            symbolColor: '#f1f3f7',
            height: 44
          }
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-change', true)
  })

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-change', false)
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // If ready-to-show never fires (e.g. renderer fails first paint after a
  // bad cache), the window would stay hidden forever and the app looks like
  // "it doesn't open". Force-show on successful load as a fallback.
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  let lastConsoleMsg = ''
  let lastConsoleTime = 0
  let repeatCount = 0

  mainWindow.webContents.on('console-message', (event, ...args) => {
    const msg = typeof event?.message === 'string' ? event.message : String(args[1] ?? '')
    const now = Date.now()
    if (msg === lastConsoleMsg && now - lastConsoleTime < 5000) {
      repeatCount++
      return
    }
    if (repeatCount > 0) {
      console.log(`[RENDERER] (previous message repeated ${repeatCount} times)`)
      repeatCount = 0
    }
    lastConsoleMsg = msg
    lastConsoleTime = now
    console.log(`[RENDERER] ${msg}`)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    const hash = process.env['INITIAL_HASH']
    void mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      hash ? { hash } : undefined
    )
  }
}

function registerIpc(): void {
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
      return false
    } else {
      mainWindow.maximize()
      return true
    }
  })
  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })
  ipcMain.handle('window:is-maximized', () => {
    return mainWindow?.isMaximized() ?? false
  })

  ipcMain.handle('search', (_e, query: string, filter: SearchFilter) =>
    youtube.search(query, filter)
  )
  ipcMain.handle('search:more', (_e, token: string) => youtube.searchMore(token))
  ipcMain.handle('suggestions', (_e, query: string) => youtube.suggestions(query))
  ipcMain.handle('video:get', (_e, videoId: string) => youtube.getVideo(videoId))
  ipcMain.handle('manifest:refresh', async (_e, videoId: string) => {
    const xml = await youtube.getManifest(videoId, true)
    return xml != null
  })
  ipcMain.handle('video:progressive', (_e, videoId: string) => youtube.getProgressiveUrl(videoId))
  ipcMain.handle('sponsor:segments', (_e, videoId: string, categories: string[]) =>
    fetchSponsorSegments(videoId, categories)
  )
  ipcMain.handle('ryd:dislikes', (_e, videoId: string) => fetchDislikes(videoId))

  ipcMain.handle('channel:get', (_e, id: string) => youtube.getChannelInfo(id))
  ipcMain.handle('channel:videos', (_e, id: string, sort: ChannelSort) =>
    youtube.getChannelVideos(id, sort)
  )
  ipcMain.handle('channel:videos-more', (_e, token: string) =>
    youtube.channelVideosMore(token)
  )
  ipcMain.handle('channel:live', (_e, id: string) => youtube.getChannelLiveStreams(id))
  ipcMain.handle('channel:live-more', (_e, token: string) =>
    youtube.channelLiveStreamsMore(token)
  )
  ipcMain.handle('channel:playlists', (_e, id: string) => youtube.getChannelPlaylists(id))
  ipcMain.handle('channel:playlists-more', (_e, token: string) =>
    youtube.channelPlaylistsMore(token)
  )
  ipcMain.handle('channel:releases', (_e, id: string) => youtube.getChannelReleases(id))
  ipcMain.handle('channel:releases-more', (_e, token: string) =>
    youtube.channelReleasesMore(token)
  )
  ipcMain.handle('channel:about', (_e, id: string) => youtube.getChannelAbout(id))
  ipcMain.handle('channel:avatar', (_e, ids: string[]) => youtube.getChannelAvatars(ids))
  ipcMain.handle('playlist:get', (_e, id: string) => youtube.getRemotePlaylist(id))
  ipcMain.handle('playlist:more', (_e, token: string) => youtube.remotePlaylistMore(token))

  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:save', (_e, settings: Settings) => store.saveSettings(settings))

  ipcMain.handle('history:get', () => store.getHistory())
  ipcMain.handle('history:add', (_e, entry: HistoryEntry) => store.addHistory(entry))
  ipcMain.handle('history:position', (_e, videoId: string, position: number) =>
    store.updateHistoryPosition(videoId, position)
  )
  ipcMain.handle('history:remove', (_e, videoId: string) => store.removeHistory(videoId))
  ipcMain.handle('history:clear', () => store.clearHistory())

  ipcMain.handle('searchhistory:get', () => store.getSearchHistory())
  ipcMain.handle('searchhistory:add', (_e, query: string) => store.addSearchHistory(query))
  ipcMain.handle('searchhistory:remove', (_e, query: string) =>
    store.removeSearchHistory(query)
  )
  ipcMain.handle('searchhistory:clear', () => store.clearSearchHistory())

  ipcMain.handle('playlists:get', () => store.getPlaylists())
  ipcMain.handle('playlists:create', (_e, name: string, source?: PlaylistSource) =>
    store.createPlaylist(name, source)
  )
  ipcMain.handle('playlists:rename', (_e, id: string, name: string) =>
    store.renamePlaylist(id, name)
  )
  ipcMain.handle('playlists:delete', (_e, id: string) => store.deletePlaylist(id))
  ipcMain.handle('playlists:add', (_e, id: string, video: PlaylistVideo) =>
    store.addToPlaylist(id, video)
  )
  ipcMain.handle('playlists:remove', (_e, id: string, videoId: string) =>
    store.removeFromPlaylist(id, videoId)
  )
  ipcMain.handle('playlists:move', (_e, id: string, from: number, to: number) =>
    store.movePlaylistItem(id, from, to)
  )

  ipcMain.handle('channels:saved:get', () => store.getSavedChannels())
  ipcMain.handle('channels:saved:save', (_e, channel: SavedChannel) =>
    store.saveChannel(channel)
  )
  ipcMain.handle(
    'channels:saved:update',
    (_e, channelId: string, patch: Partial<SavedChannel>) =>
      store.updateSavedChannel(channelId, patch)
  )
  ipcMain.handle('channels:saved:toggle-favorite', (_e, channelId: string) =>
    store.toggleFavoriteChannel(channelId)
  )
  ipcMain.handle('channels:saved:remove', (_e, channelId: string) =>
    store.removeSavedChannel(channelId)
  )

  ipcMain.handle('channels:folders:get', () => store.getChannelFolders())
  ipcMain.handle('channels:folders:create', (_e, name: string) =>
    store.createChannelFolder(name)
  )
  ipcMain.handle('channels:folders:rename', (_e, id: string, name: string) =>
    store.renameChannelFolder(id, name)
  )
  ipcMain.handle('channels:folders:delete', (_e, id: string) =>
    store.deleteChannelFolder(id)
  )

  // Progress rides on a separate event so the `invoke` still resolves with a
  // plain array. The renderer mints `requestId` per fetch and only listens to
  // its own events, so switching folders mid-flight cannot paint a stale bar.
  ipcMain.handle(
    'channels:feed',
    (e, channelIds: string[], maxAgeDays?: number, requestId?: string) => {
      const send = (done: number, total: number): void => {
        if (!requestId) return
        e.sender.send('channels:feed-progress', { requestId, done, total })
      }
      return youtube.getSavedChannelsFeed(channelIds, maxAgeDays, send)
    }
  )

  // Rejects rather than resolving silently, so the renderer can tell the user
  // their click did nothing. This is only reachable for links the user
  // explicitly activates, and a silent no-op there is the worst outcome.
  ipcMain.handle('app:open-external', async (_e, url: unknown): Promise<void> => {
    // Renderers occasionally pass through uncoerced node data (objects), so
    // validate before touching the string API — otherwise this throws and the
    // click silently dies with an uncaught IPC rejection in the console.
    if (typeof url !== 'string' || !(url.startsWith('http://') || url.startsWith('https://'))) {
      throw new Error('Only http(s) links can be opened externally')
    }
    try {
      await shell.openExternal(url)
    } catch (reason) {
      console.error('[main] openExternal failed', url, reason)
      throw new Error('Could not open that link')
    }
  })

  ipcMain.handle('data:export', () => store.exportData())
  ipcMain.handle('data:import', (_e, json: string) => store.importData(json))
}

function setupWebRequest(): void {
  const filter = {
    urls: [
      '*://*.googlevideo.com/*',
      '*://*.youtube.com/*',
      '*://*.ytimg.com/*',
      '*://*.ggpht.com/*',
      '*://*.googleusercontent.com/*'
    ]
  }

  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const requestHeaders = details.requestHeaders || {}
    Object.assign(requestHeaders, YOUTUBE_REQUEST_GLOBALS)
    callback({ requestHeaders })
  })

  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const responseHeaders = details.responseHeaders || {}
    responseHeaders['Access-Control-Allow-Origin'] = ['*']
    responseHeaders['Access-Control-Allow-Methods'] = ['GET, HEAD, OPTIONS']
    responseHeaders['Access-Control-Allow-Headers'] = [
      'Range, Content-Type, Authorization, X-Client-Data, Accept, If-Range, If-None-Match, If-Modified-Since'
    ]
    responseHeaders['Access-Control-Expose-Headers'] = [
      'Content-Range, Content-Length, Accept-Ranges, Date, ETag'
    ]
    callback({ responseHeaders })
  })
}

// Configure application identity at module scope before ready event
app.setName('ViewFlux')

// Disable Chromium DirectComposition hardware video overlays on Windows.
// When letterboxed videos (e.g. 21:9 or 2.35:1) play in fullscreen on Windows, Chromium's DComp
// video overlay plane can occlude sibling DOM overlays (player controls, seek bar, captions)
// situated in the letterbox margin areas. Disabling video overlays forces standard compositing
// into the root swapchain while preserving full hardware-accelerated decoding.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-direct-composition-video-overlays')
  app.commandLine.appendSwitch(
    'disable-features',
    'DirectCompositionVideoOverlays,DirectCompositionSoftwareOverlays'
  )
}

// Single-instance lock MUST be acquired before `ready` — otherwise two
// launches can both pass `whenReady`, both bind the media proxy / userData,
// and the second one silently exits on Chromium's internal Singleton lock
// with no window. The loser quits immediately; the winner restores/focuses
// its window in the `second-instance` handler below.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

function focusOrCreateWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.show()
  } else if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.focus()
        win.show()
        break
      }
    }
  }
}

app.on('second-instance', () => {
  focusOrCreateWindow()
})

// A stable AppUserModelID lets Windows group our `SystemMediaTransportControls`
// "now playing" card, its media-key handling and any toast notifications under
// a single app identity instead of lumping them into electron.app.Electron.
if (process.platform === 'win32') {
  app.setAppUserModelId('app.viewflux.desktop')
}

// On Linux, setting desktop name aligns the running window's WM_CLASS (X11) and
// app_id (Wayland) with the installed `viewflux.desktop` file, allowing the taskbar,
// dock, and alt-tab switcher to correctly display the app logo and title.
if (process.platform === 'linux' && typeof app.setDesktopName === 'function') {
  app.setDesktopName('viewflux.desktop')
}

app.whenReady().then(async () => {
  setupAppMenu()
  setupWebRequest()
  await store.ready()
  const base = await proxy.start()
  youtube.setProxyBase(base)
  registerIpc()
  cleanupUpdater = initAutoUpdater()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  // Async cleanup (store flush + proxy stop + updater timers) must finish
  // before exit, but Electron gives `before-quit` no async hook. Block the
  // default quit, clean up with a timeout guard, then exit explicitly via
  // app.exit() (not process.exit(), which skips Electron child teardown and
  // leaves zombie GPU/zygote processes holding the Singleton lock on Linux).
  event.preventDefault()
  isQuitting = true
  void (async () => {
    try {
      cleanupUpdater?.()
      cleanupUpdater = null
      await Promise.race([
        Promise.allSettled([store.flush(), proxy.stop()]),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2500)
          t.unref?.()
        })
      ])
    } finally {
      app.exit(0)
    }
  })()
})
