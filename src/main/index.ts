import { app, BrowserWindow, ipcMain, shell, session } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from './store'
import { YoutubeService } from './youtube'
import { MediaProxy } from './proxy'
import { fetchDislikes, fetchSponsorSegments } from './services'
import { YOUTUBE_REQUEST_GLOBALS } from './http'
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

/**
 * Electron only sets the executable icon in packaged builds; point the window
 * at our generated PNG during `npm run dev` so the taskbar shows the logo.
 */
function devIcon(): string | undefined {
  if (app.isPackaged) return undefined
  const icon = join(__dirname, '../../build/icon.png')
  return existsSync(icon) ? icon : undefined
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'ViewFlux',
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f0d13',
    autoHideMenuBar: true,
    icon: devIcon(),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f0d13',
      symbolColor: '#e6e1e5',
      height: 40
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('console-message', (event, ...args) => {
    const msg = typeof event?.message === 'string' ? event.message : args[1]
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

// A stable AppUserModelID lets Windows group our `SystemMediaTransportControls`
// "now playing" card, its media-key handling and any toast notifications under
// a single app identity instead of lumping them into electron.app.Electron.
// Must run before the app becomes ready, so it sits at module scope.
app.setAppUserModelId('com.viewflux.desktop')

app.whenReady().then(async () => {
  setupWebRequest()
  await store.ready()
  const base = await proxy.start()
  youtube.setProxyBase(base)
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void store.flush()
  void proxy.stop()
})
