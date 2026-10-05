import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppApi,
  ChannelSort,
  HistoryEntry,
  PlaylistSource,
  PlaylistVideo,
  SavedChannel,
  SearchFilter,
  Settings
} from '../shared/types'

const api: AppApi = {
  search: (query: string, filter: SearchFilter) =>
    ipcRenderer.invoke('search', query, filter),
  searchMore: (token: string) => ipcRenderer.invoke('search:more', token),
  suggestions: (query: string) => ipcRenderer.invoke('suggestions', query),
  getVideo: (videoId: string) => ipcRenderer.invoke('video:get', videoId),
  refreshManifest: (videoId: string) => ipcRenderer.invoke('manifest:refresh', videoId),
  getProgressiveUrl: (videoId: string) => ipcRenderer.invoke('video:progressive', videoId),
  getSponsorSegments: (videoId: string, categories: string[]) =>
    ipcRenderer.invoke('sponsor:segments', videoId, categories),
  getDislikes: (videoId: string) => ipcRenderer.invoke('ryd:dislikes', videoId),

  getChannel: (id: string) => ipcRenderer.invoke('channel:get', id),
  getChannelVideos: (id: string, sort: ChannelSort) =>
    ipcRenderer.invoke('channel:videos', id, sort),
  channelVideosMore: (token: string) => ipcRenderer.invoke('channel:videos-more', token),
  getChannelPlaylists: (id: string) => ipcRenderer.invoke('channel:playlists', id),
  channelPlaylistsMore: (token: string) =>
    ipcRenderer.invoke('channel:playlists-more', token),
  getChannelReleases: (id: string) => ipcRenderer.invoke('channel:releases', id),
  channelReleasesMore: (token: string) => ipcRenderer.invoke('channel:releases-more', token),
  getChannelAbout: (id: string) => ipcRenderer.invoke('channel:about', id),
  getRemotePlaylist: (id: string) => ipcRenderer.invoke('playlist:get', id),
  remotePlaylistMore: (token: string) => ipcRenderer.invoke('playlist:more', token),

  getSavedChannels: () => ipcRenderer.invoke('channels:saved:get'),
  saveChannel: (channel: SavedChannel) => ipcRenderer.invoke('channels:saved:save', channel),
  updateSavedChannel: (channelId: string, patch: Partial<SavedChannel>) =>
    ipcRenderer.invoke('channels:saved:update', channelId, patch),
  toggleFavoriteChannel: (channelId: string) =>
    ipcRenderer.invoke('channels:saved:toggle-favorite', channelId),
  removeSavedChannel: (channelId: string) =>
    ipcRenderer.invoke('channels:saved:remove', channelId),

  getChannelFolders: () => ipcRenderer.invoke('channels:folders:get'),
  createChannelFolder: (name: string) =>
    ipcRenderer.invoke('channels:folders:create', name),
  renameChannelFolder: (id: string, name: string) =>
    ipcRenderer.invoke('channels:folders:rename', id, name),
  deleteChannelFolder: (id: string) =>
    ipcRenderer.invoke('channels:folders:delete', id),

  getSavedChannelsFeed: (channelIds: string[], maxAgeDays?: number, requestId?: string) =>
    ipcRenderer.invoke('channels:feed', channelIds, maxAgeDays, requestId),

  getChannelAvatars: (ids: string[]) => ipcRenderer.invoke('channel:avatar', ids),
  onFeedProgress: (requestId: string, onProgress: (done: number, total: number) => void) => {
    // Listener is filtered by request id here rather than in the renderer, so
    // a component that unmounts mid-fetch simply stops being handed events and
    // its own cleanup has nothing left to do beyond removing this one listener.
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { requestId: string; done: number; total: number }
    ): void => {
      if (payload?.requestId === requestId) onProgress(payload.done, payload.total)
    }
    ipcRenderer.on('channels:feed-progress', listener)
    return () => {
      ipcRenderer.removeListener('channels:feed-progress', listener)
    }
  },

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: Settings) => ipcRenderer.invoke('settings:save', settings),

  getHistory: () => ipcRenderer.invoke('history:get'),
  addHistory: (entry: HistoryEntry) => ipcRenderer.invoke('history:add', entry),
  updateHistoryPosition: (videoId: string, position: number) =>
    ipcRenderer.invoke('history:position', videoId, position),
  removeHistory: (videoId: string) => ipcRenderer.invoke('history:remove', videoId),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  getSearchHistory: () => ipcRenderer.invoke('searchhistory:get'),
  addSearchHistory: (query: string) => ipcRenderer.invoke('searchhistory:add', query),
  removeSearchHistory: (query: string) => ipcRenderer.invoke('searchhistory:remove', query),
  clearSearchHistory: () => ipcRenderer.invoke('searchhistory:clear'),

  getPlaylists: () => ipcRenderer.invoke('playlists:get'),
  createPlaylist: (name: string, source?: PlaylistSource) =>
    ipcRenderer.invoke('playlists:create', name, source),
  renamePlaylist: (id: string, name: string) => ipcRenderer.invoke('playlists:rename', id, name),
  deletePlaylist: (id: string) => ipcRenderer.invoke('playlists:delete', id),
  addToPlaylist: (id: string, video: PlaylistVideo) =>
    ipcRenderer.invoke('playlists:add', id, video),
  removeFromPlaylist: (id: string, videoId: string) =>
    ipcRenderer.invoke('playlists:remove', id, videoId),
  movePlaylistItem: (id: string, from: number, to: number) =>
    ipcRenderer.invoke('playlists:move', id, from, to),

  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: (json: string) => ipcRenderer.invoke('data:import', json),

  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getUpdaterStatus: () => ipcRenderer.invoke('updater:get-status'),
  onUpdaterStatus: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, status: unknown): void => {
      callback(status as any)
    }
    ipcRenderer.on('updater:status', listener)
    return () => {
      ipcRenderer.removeListener('updater:status', listener)
    }
  },

  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)
