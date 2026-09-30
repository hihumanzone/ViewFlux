import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  type AppData,
  type ChannelFolder,
  type HistoryEntry,
  type Playlist,
  type PlaylistSource,
  type PlaylistVideo,
  type SavedChannel,
  type SearchHistoryEntry,
  type Settings,
  type ReduceMotionSetting,
  DEFAULT_SETTINGS
} from '../shared/types'
import { normalizeSubtitleStyle } from '../shared/subtitles'

/**
 * Bumped whenever the on-disk shape changes in a way that needs a migration.
 * Recorded in the file so a future build can tell "written by an older version"
 * from "written by a newer one" and refuse to clobber the latter.
 */
const SCHEMA_VERSION = 1

function defaultData(): AppData {
  return {
    history: [],
    playlists: [],
    searchHistory: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    savedChannels: [],
    channelFolders: []
  }
}

function normalizeReduceMotion(raw: Partial<Settings> | undefined): ReduceMotionSetting {
  if (raw?.reduceMotion === 'on' || raw?.reduceMotion === 'off' || raw?.reduceMotion === 'system') {
    return raw.reduceMotion
  }
  if (raw?.respectSystemMotion === true) {
    return 'system'
  }
  if (raw?.respectSystemMotion === false) {
    return (raw as { reduceMotion?: unknown })?.reduceMotion === true ? 'on' : 'off'
  }
  if (typeof (raw as { reduceMotion?: unknown })?.reduceMotion === 'boolean') {
    return (raw as { reduceMotion?: unknown }).reduceMotion ? 'on' : 'off'
  }
  return DEFAULT_SETTINGS.reduceMotion
}

/**
 * Fills in missing settings keys. The top level is a shallow merge, so nested
 * objects (the subtitle style) need their own normalisation to survive a file
 * written by an older build, a partial object, or hand-edited values.
 */
function withSettingDefaults(raw: Partial<Settings> | undefined): Settings {
  const reduceMotion = normalizeReduceMotion(raw)
  return {
    ...DEFAULT_SETTINGS,
    ...(raw ?? {}),
    reduceMotion,
    respectSystemMotion: reduceMotion === 'system',
    subtitleStyle: normalizeSubtitleStyle(raw?.subtitleStyle)
  }
}

/**
 * Tiny dependency-free persistence layer. The whole dataset is held in memory and
 * written atomically (temp file + rename) with debounced saves, so rapid updates
 * (e.g. playback position ticks) never thrash the disk.
 */
export class Store {
  private readonly file: string
  private readonly legacyFile: string
  private readonly backupFile: string
  private data: AppData = defaultData()
  private historyMap = new Map<string, HistoryEntry>()
  private loaded = false
  private loadPromise: Promise<void>
  private saveTimer: NodeJS.Timeout | null = null
  private saving = false
  private dirty = false
  private isStructuralDirty = false
  private lastBackupAt = 0

  private rebuildHistoryIndex(): void {
    this.historyMap.clear()
    for (const h of this.data.history) {
      this.historyMap.set(h.videoId, h)
    }
  }

  constructor() {
    this.file = join(app.getPath('userData'), 'viewflux-data.json')
    this.legacyFile = join(app.getPath('userData'), 'libretube-data.json')
    this.backupFile = `${this.file}.bak`
    this.loadPromise = this.load()
  }

  private async load(): Promise<void> {
    try {
      let raw: string | null = null
      try {
        raw = await fs.readFile(this.file, 'utf8')
      } catch {
        // Fallback: migrate existing data from legacy libretube-data.json
        try {
          raw = await fs.readFile(this.legacyFile, 'utf8')
          this.dirty = true // trigger saving to viewflux-data.json
          this.isStructuralDirty = true
        } catch {
          raw = null
        }
      }

      // A truncated or half-written file used to silently reset the user to
      // empty defaults, losing every playlist and bookmark with no way back.
      // The previous good copy is kept, so a parse failure falls back to it
      // before giving up.
      if (raw) {
        try {
          this.adopt(JSON.parse(raw) as Partial<AppData>)
          return
        } catch (err) {
          console.error('[store] data file is unreadable, trying backup', err)
          try {
            this.adopt(JSON.parse(await fs.readFile(this.backupFile, 'utf8')) as Partial<AppData>)
            console.warn('[store] recovered from backup')
            this.dirty = true
            this.isStructuralDirty = true
            return
          } catch (backupErr) {
            console.error('[store] no usable backup, starting fresh', backupErr)
            this.data = defaultData()
          }
        }
      } else {
        this.data = defaultData()
      }
    } finally {
      this.loaded = true
      if (this.dirty) this.scheduleSave(this.isStructuralDirty)
    }
  }

  /** Validates and applies a parsed file, trimming to the configured limits. */
  private adopt(parsed: Partial<AppData>): void {
    this.data = {
      history: Array.isArray(parsed.history) ? parsed.history : [],
      playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
      searchHistory: Array.isArray(parsed.searchHistory) ? parsed.searchHistory : [],
      settings: withSettingDefaults(parsed.settings),
      savedChannels: Array.isArray(parsed.savedChannels) ? parsed.savedChannels : [],
      channelFolders: Array.isArray(parsed.channelFolders) ? parsed.channelFolders : []
    }
    this.trimToLimits()
    this.rebuildHistoryIndex()
  }

  async ready(): Promise<void> {
    await this.loadPromise
    await fs.mkdir(join(app.getPath('userData')), { recursive: true }).catch(() => undefined)
  }

  private scheduleSave(structural = true): void {
    if (!this.loaded) return
    this.dirty = true
    if (structural) {
      this.isStructuralDirty = true
    }
    // If a timer is already queued and a structural modification comes in,
    // collapse to a fast 400ms save instead of waiting for a relaxed tick timer.
    if (this.saveTimer) {
      if (structural) {
        clearTimeout(this.saveTimer)
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null
          void this.flush()
        }, 400)
      }
      return
    }
    // High-frequency playback ticks coalesce over 15s to prevent SSD/disk thrashing;
    // structural edits (playlists, channels, settings) flush promptly within 400ms.
    const delay = structural ? 400 : 15_000
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, delay)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.saving || !this.dirty) return
    this.saving = true
    this.dirty = false
    const structural = this.isStructuralDirty
    this.isStructuralDirty = false
    const tmp = `${this.file}.tmp`
    try {
      await fs.writeFile(
        tmp,
        JSON.stringify({ version: SCHEMA_VERSION, ...this.data }),
        'utf8'
      )
      // Only refresh the backup copy on structural modifications or once every 10 minutes,
      // avoiding redundant file duplication on periodic playback position ticks.
      const now = Date.now()
      if (structural || now - this.lastBackupAt > 10 * 60 * 1000) {
        this.lastBackupAt = now
        await fs
          .copyFile(this.file, this.backupFile)
          .catch(() => undefined)
      }
      try {
        await fs.rename(tmp, this.file)
      } catch (renameErr: unknown) {
        const code = (renameErr as { code?: string })?.code
        if (code === 'EPERM' || code === 'EEXIST' || code === 'EBUSY') {
          await fs.unlink(this.file).catch(() => undefined)
          await fs.rename(tmp, this.file)
        } else {
          throw renameErr
        }
      }
    } catch (err) {
      console.error('[store] failed to persist data', err)
      await fs.unlink(tmp).catch(() => undefined)
    } finally {
      this.saving = false
      if (this.dirty) this.scheduleSave(this.isStructuralDirty)
    }
  }

  // ---- Settings -----------------------------------------------------------
  getSettings(): Settings {
    return { ...this.data.settings }
  }

  saveSettings(settings: Settings): Settings {
    this.data.settings = withSettingDefaults(settings)
    this.trimToLimits()
    this.scheduleSave()
    return { ...this.data.settings }
  }

  /**
   * Enforces the history limits. Run after loading and after any limit change,
   * so lowering a limit actually discards the surplus immediately instead of
   * waiting for the next append.
   */
  private trimToLimits(): void {
    const maxWatch = this.data.settings.maxWatchHistory || 500
    if (this.data.history.length > maxWatch) {
      this.data.history.length = maxWatch
    }
    const maxSearch = this.data.settings.maxSearchHistory || 50
    if (this.data.searchHistory.length > maxSearch) {
      this.data.searchHistory.length = maxSearch
    }
  }

  // ---- History ------------------------------------------------------------
  getHistory(): HistoryEntry[] {
    return this.data.history
  }

  addHistory(entry: HistoryEntry): void {
    if (!this.data.settings.saveWatchHistory) return
    const idx = this.data.history.findIndex((h) => h.videoId === entry.videoId)
    let finalEntry: HistoryEntry
    if (idx !== -1) {
      const existing = this.data.history[idx]
      this.data.history.splice(idx, 1)
      finalEntry = {
        ...existing,
        ...entry,
        // Channel details resolve a tick after the video info does, so never let
        // a late `null` wipe an id/avatar an earlier pass already stored.
        authorId: entry.authorId ?? existing.authorId ?? null,
        authorAvatar: entry.authorAvatar ?? existing.authorAvatar ?? null
      }
      this.data.history.unshift(finalEntry)
    } else {
      finalEntry = entry
      this.data.history.unshift(finalEntry)
    }
    this.historyMap.set(entry.videoId, finalEntry)
    const limit = this.data.settings.maxWatchHistory || 500
    if (this.data.history.length > limit) {
      const removed = this.data.history.pop()
      if (removed) this.historyMap.delete(removed.videoId)
    }
    this.scheduleSave()
  }

  updateHistoryPosition(videoId: string, position: number): void {
    if (!this.data.settings.saveWatchHistory) return
    const entry = this.historyMap.get(videoId)
    if (!entry) return
    // Skip if position hasn't changed noticeably (>0.5s) unless reset to 0
    if (position > 0 && Math.abs(entry.position - position) < 0.5) return
    entry.position = position
    entry.watchedAt = Date.now()
    this.scheduleSave(false)
  }

  removeHistory(videoId: string): void {
    const idx = this.data.history.findIndex((h) => h.videoId === videoId)
    if (idx !== -1) {
      this.data.history.splice(idx, 1)
      this.historyMap.delete(videoId)
      this.scheduleSave()
    }
  }

  clearHistory(): void {
    this.data.history = []
    this.historyMap.clear()
    this.scheduleSave()
  }

  // ---- Search history -----------------------------------------------------
  getSearchHistory(): SearchHistoryEntry[] {
    return this.data.searchHistory
  }

  addSearchHistory(query: string): void {
    const q = query.trim()
    if (!q) return
    const idx = this.data.searchHistory.findIndex((s) => s.query === q)
    if (idx !== -1) this.data.searchHistory.splice(idx, 1)
    this.data.searchHistory.unshift({ query: q, searchedAt: Date.now() })
    const limit = this.data.settings.maxSearchHistory || 50
    if (this.data.searchHistory.length > limit) {
      this.data.searchHistory.length = limit
    }
    this.scheduleSave()
  }

  removeSearchHistory(query: string): void {
    const idx = this.data.searchHistory.findIndex((s) => s.query === query)
    if (idx !== -1) {
      this.data.searchHistory.splice(idx, 1)
      this.scheduleSave()
    }
  }

  clearSearchHistory(): void {
    this.data.searchHistory = []
    this.scheduleSave()
  }

  // ---- Playlists ----------------------------------------------------------
  getPlaylists(): Playlist[] {
    return this.data.playlists
  }

  createPlaylist(name: string, source?: PlaylistSource): Playlist {
    if (source) {
      const existing = this.data.playlists.find(
        (p) => p.kind === 'youtube' && p.youtubeId === source.youtubeId
      )
      if (existing) {
        existing.name = source.name.trim() || existing.name
        existing.author = source.author ?? existing.author
        existing.countText = source.countText ?? existing.countText
        existing.thumbnail = source.thumbnail ?? existing.thumbnail
        existing.syncedAt = Date.now()
        this.scheduleSave()
        return structuredClone(existing)
      }
    }

    const playlist: Playlist = source
      ? {
          id: randomUUID(),
          name: source.name.trim() || 'Untitled playlist',
          createdAt: Date.now(),
          videos: [],
          kind: 'youtube',
          youtubeId: source.youtubeId,
          author: source.author ?? null,
          countText: source.countText ?? null,
          thumbnail: source.thumbnail ?? null,
          syncedAt: Date.now()
        }
      : {
          id: randomUUID(),
          name: name.trim() || 'Untitled playlist',
          createdAt: Date.now(),
          videos: [],
          kind: 'local'
        }
    this.data.playlists.unshift(playlist)
    this.scheduleSave()
    return structuredClone(playlist)
  }

  private findPlaylist(id: string): Playlist | undefined {
    return this.data.playlists.find((p) => p.id === id)
  }

  renamePlaylist(id: string, name: string): void {
    const playlist = this.findPlaylist(id)
    if (!playlist) return
    playlist.name = name.trim() || playlist.name
    this.scheduleSave()
  }

  deletePlaylist(id: string): void {
    const idx = this.data.playlists.findIndex((p) => p.id === id)
    if (idx !== -1) {
      this.data.playlists.splice(idx, 1)
      this.scheduleSave()
    }
  }

  addToPlaylist(id: string, video: PlaylistVideo): Playlist | undefined {
    const playlist = this.findPlaylist(id)
    if (!playlist) return undefined
    const existing = playlist.videos.findIndex((v) => v.videoId === video.videoId)
    if (existing !== -1) playlist.videos.splice(existing, 1)
    playlist.videos.unshift(video)
    this.scheduleSave()
    return structuredClone(playlist)
  }

  removeFromPlaylist(id: string, videoId: string): Playlist | undefined {
    const playlist = this.findPlaylist(id)
    if (!playlist) return undefined
    const idx = playlist.videos.findIndex((v) => v.videoId === videoId)
    if (idx !== -1) playlist.videos.splice(idx, 1)
    this.scheduleSave()
    return structuredClone(playlist)
  }

  movePlaylistItem(id: string, from: number, to: number): Playlist | undefined {
    const playlist = this.findPlaylist(id)
    if (!playlist) return undefined
    if (from < 0 || from >= playlist.videos.length || to < 0 || to >= playlist.videos.length) {
      return structuredClone(playlist)
    }
    const [item] = playlist.videos.splice(from, 1)
    playlist.videos.splice(to, 0, item)
    this.scheduleSave()
    return structuredClone(playlist)
  }

  // ---- Saved Channels (Bookmarks) -----------------------------------------
  getSavedChannels(): SavedChannel[] {
    return this.data.savedChannels
  }

  saveChannel(channel: SavedChannel): SavedChannel {
    const idx = this.data.savedChannels.findIndex((c) => c.channelId === channel.channelId)
    if (idx !== -1) {
      this.data.savedChannels[idx] = { ...this.data.savedChannels[idx], ...channel }
    } else {
      this.data.savedChannels.unshift(channel)
    }
    this.scheduleSave()
    return { ...this.data.savedChannels[idx !== -1 ? idx : 0] }
  }

  updateSavedChannel(channelId: string, patch: Partial<SavedChannel>): SavedChannel | undefined {
    const channel = this.data.savedChannels.find((c) => c.channelId === channelId)
    if (!channel) return undefined
    Object.assign(channel, patch)
    this.scheduleSave()
    return { ...channel }
  }

  removeSavedChannel(channelId: string): void {
    const idx = this.data.savedChannels.findIndex((c) => c.channelId === channelId)
    if (idx !== -1) {
      this.data.savedChannels.splice(idx, 1)
      this.scheduleSave()
    }
  }

  // ---- Channel Folders ----------------------------------------------------
  getChannelFolders(): ChannelFolder[] {
    return this.data.channelFolders
  }

  createChannelFolder(name: string): ChannelFolder {
    const folder: ChannelFolder = {
      id: randomUUID(),
      name: name.trim() || 'Untitled folder',
      createdAt: Date.now()
    }
    this.data.channelFolders.push(folder)
    this.scheduleSave()
    return structuredClone(folder)
  }

  renameChannelFolder(id: string, name: string): void {
    const folder = this.data.channelFolders.find((f) => f.id === id)
    if (!folder) return
    folder.name = name.trim() || folder.name
    this.scheduleSave()
  }

  deleteChannelFolder(id: string): void {
    const idx = this.data.channelFolders.findIndex((f) => f.id === id)
    if (idx !== -1) {
      this.data.channelFolders.splice(idx, 1)
      // Un-assign channels from the deleted folder
      for (const ch of this.data.savedChannels) {
        if (ch.folderId === id) ch.folderId = null
      }
      this.scheduleSave()
    }
  }

  // ---- Backup & Restore (Export / Import) -----------------------------------
  exportData(): string {
    const payload = {
      app: 'ViewFlux',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      data: structuredClone(this.data)
    }
    return JSON.stringify(payload, null, 2)
  }

  async importData(jsonContent: string): Promise<{
    success: boolean
    error?: string
    stats?: { playlists: number; savedChannels: number; history: number }
  }> {
    try {
      const parsed = JSON.parse(jsonContent)
      if (!parsed || typeof parsed !== 'object') {
        return { success: false, error: 'Invalid backup file: not a JSON object' }
      }
      const dataToImport = (parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed) as Partial<AppData>

      this.adopt(dataToImport)
      this.dirty = true
      this.isStructuralDirty = true
      await this.flush()

      return {
        success: true,
        stats: {
          playlists: this.data.playlists.length,
          savedChannels: this.data.savedChannels.length,
          history: this.data.history.length
        }
      }
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to parse JSON backup file'
      }
    }
  }
}
