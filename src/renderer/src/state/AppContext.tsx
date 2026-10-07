import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  DEFAULT_SETTINGS,
  type ChannelFolder,
  type HistoryEntry,
  type Playlist,
  type PlaylistSource,
  type PlaylistSummary,
  type SavedChannel,
  type SearchHistoryEntry,
  type Settings,
  type UpdaterStatus
} from '../../../shared/types'
import { Dialog } from '../components/Dialog'

interface ToastItem {
  id: number
  message: string
  actionLabel?: string
  onAction?: () => void
}

interface ConfirmRequest {
  message: string
  confirmLabel: string
  danger: boolean
  resolve: (value: boolean) => void
}

interface AppContextValue {
  settings: Settings
  playlists: Playlist[]
  history: HistoryEntry[]
  historyMap: ReadonlyMap<string, HistoryEntry>
  searchHistory: SearchHistoryEntry[]
  savedChannels: SavedChannel[]
  channelFolders: ChannelFolder[]
  loaded: boolean
  /** Whether reduced motion is currently in effect (based on setting and OS preference). */
  isReducedMotion: boolean
  /** Whether the host system prefers reduced motion. */
  systemPrefersReducedMotion: boolean
  saveSettings: (settings: Settings) => Promise<void>
  refreshPlaylists: () => Promise<void>
  refreshHistory: () => Promise<void>
  refreshSearchHistory: () => Promise<void>
  refreshSavedChannels: () => Promise<void>
  refreshChannelFolders: () => Promise<void>
  saveChannel: (channel: SavedChannel) => Promise<void>
  updateSavedChannel: (channelId: string, patch: Partial<SavedChannel>) => Promise<void>
  removeSavedChannel: (channelId: string) => Promise<void>
  toggleFavoriteChannel: (channelId: string) => Promise<SavedChannel | undefined>
  createChannelFolder: (name: string) => Promise<ChannelFolder>
  renameChannelFolder: (id: string, name: string) => Promise<void>
  deleteChannelFolder: (id: string) => Promise<void>
  recordSearch: (query: string) => Promise<void>
  removeSearch: (query: string) => Promise<void>
  clearSearchHistory: () => Promise<void>
  /** Updates playback position both in persistent storage and reactively in local state. */
  updateHistoryPosition: (videoId: string, position: number, duration?: number) => void
  /** Returns 0-1 playback progress for a video, or 0 if unplayed / completed */
  getHistoryProgress: (videoId: string, fallbackDuration?: number | null) => number
  /** Returns the full HistoryEntry if watched, otherwise undefined. Fast O(1) lookup. */
  getHistoryEntry: (videoId: string) => HistoryEntry | undefined
  /** True when this channel is bookmarked in saved channels. */
  isChannelSaved: (channelId: string) => boolean
  /** Bookmarks a real YouTube playlist so it shows up in the app's playlists. */
  saveYoutubePlaylist: (playlist: PlaylistSource) => Promise<void>
  /** Bookmarks a remote playlist described by a summary card. */
  saveYoutubePlaylistSummary: (playlist: PlaylistSummary) => Promise<void>
  /** True when this YouTube playlist is already bookmarked. */
  isYoutubePlaylistSaved: (youtubeId: string) => boolean
  /** Removes a bookmarked YouTube playlist by its YouTube id. */
  removeYoutubePlaylist: (youtubeId: string) => Promise<void>
  /** Updates the cached metadata of a saved YouTube playlist. */
  touchYoutubePlaylist: (playlist: Playlist) => void
  exportData: () => Promise<string>
  importData: (json: string) => Promise<{ success: boolean; error?: string; stats?: { playlists: number; savedChannels: number; history: number } }>
  toast: (
    message: string,
    options?: { actionLabel?: string; onAction?: () => void; timeout?: number }
  ) => void
  confirm: (message: string, options?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>
  updaterStatus: UpdaterStatus
  checkForUpdates: () => Promise<UpdaterStatus>
  installUpdate: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

/** Upper bound on simultaneously visible toasts; older ones are dropped. */
const MAX_TOASTS = 5

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>([])
  const [savedChannels, setSavedChannels] = useState<SavedChannel[]>([])
  const [channelFolders, setChannelFolders] = useState<ChannelFolder[]>([])
  const [loaded, setLoaded] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const toastId = useRef(0)
  // Pending auto-dismiss timers, so re-raising a toast restarts its timer.
  const toastTimers = useRef(new Map<number, number>())
  // The newest toast, used to collapse repeats of the same message.
  const lastToast = useRef<{ id: number; message: string } | null>(null)
  // Mirrors `playlists` so callbacks can read the latest value without re-creating.
  const playlistsRef = useRef<Playlist[]>([])
  playlistsRef.current = playlists

  useEffect(() => {
    void (async () => {
      const [s, p, h, sh, sc, cf] = await Promise.all([
        window.api.getSettings(),
        window.api.getPlaylists(),
        window.api.getHistory(),
        window.api.getSearchHistory(),
        window.api.getSavedChannels(),
        window.api.getChannelFolders()
      ])
      setSettings(s)
      setPlaylists(p)
      setHistory(h)
      setSearchHistory(sh)
      setSavedChannels(sc)
      setChannelFolders(cf)
      setLoaded(true)
    })()
  }, [])

  const [systemPrefersReducedMotion, setSystemPrefersReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  // Listen to OS-level prefers-reduced-motion changes
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent): void => {
      setSystemPrefersReducedMotion(e.matches)
    }
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    } else {
      mq.addListener(onChange)
      return () => mq.removeListener(onChange)
    }
  }, [])

  // Resolve whether reduced motion should be active
  const isReducedMotion = useMemo(() => {
    if (settings.reduceMotion === 'on') return true
    if (settings.reduceMotion === 'off') return false
    return systemPrefersReducedMotion
  }, [settings.reduceMotion, systemPrefersReducedMotion])

  // Apply reduced motion state to the document root
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = isReducedMotion ? 'true' : 'false'
  }, [isReducedMotion])

  // Apply the accent palette to the document root.
  useEffect(() => {
    document.documentElement.dataset.accent = settings.accent
  }, [settings.accent])

  const saveSettings = useCallback(async (next: Settings) => {
    const saved = await window.api.saveSettings(next)
    setSettings(saved)
  }, [])

  const refreshSavedChannels = useCallback(async () => {
    setSavedChannels(await window.api.getSavedChannels())
  }, [])

  const refreshChannelFolders = useCallback(async () => {
    setChannelFolders(await window.api.getChannelFolders())
  }, [])

  const saveChannel = useCallback(async (channel: SavedChannel) => {
    await window.api.saveChannel(channel)
    setSavedChannels(await window.api.getSavedChannels())
  }, [])

  const updateSavedChannel = useCallback(async (channelId: string, patch: Partial<SavedChannel>) => {
    await window.api.updateSavedChannel(channelId, patch)
    setSavedChannels(await window.api.getSavedChannels())
  }, [])

  const removeSavedChannel = useCallback(async (channelId: string) => {
    await window.api.removeSavedChannel(channelId)
    setSavedChannels(await window.api.getSavedChannels())
  }, [])

  const toggleFavoriteChannel = useCallback(async (channelId: string) => {
    const updated = await window.api.toggleFavoriteChannel(channelId)
    setSavedChannels(await window.api.getSavedChannels())
    return updated
  }, [])

  const createChannelFolder = useCallback(async (name: string): Promise<ChannelFolder> => {
    const folder = await window.api.createChannelFolder(name)
    setChannelFolders(await window.api.getChannelFolders())
    return folder
  }, [])

  const renameChannelFolder = useCallback(async (id: string, name: string) => {
    await window.api.renameChannelFolder(id, name)
    setChannelFolders(await window.api.getChannelFolders())
  }, [])

  const deleteChannelFolder = useCallback(async (id: string) => {
    await window.api.deleteChannelFolder(id)
    const [sc, cf] = await Promise.all([
      window.api.getSavedChannels(),
      window.api.getChannelFolders()
    ])
    setSavedChannels(sc)
    setChannelFolders(cf)
  }, [])

  const refreshPlaylists = useCallback(async () => {
    setPlaylists(await window.api.getPlaylists())
  }, [])

  const refreshHistory = useCallback(async () => {
    setHistory(await window.api.getHistory())
  }, [])

  const refreshSearchHistory = useCallback(async () => {
    setSearchHistory(await window.api.getSearchHistory())
  }, [])

  const recordSearch = useCallback(
    async (query: string) => {
      const trimmed = query.trim()
      if (!trimmed) return
      await window.api.addSearchHistory(trimmed)
      setSearchHistory(await window.api.getSearchHistory())
    },
    []
  )

  const removeSearch = useCallback(async (query: string) => {
    await window.api.removeSearchHistory(query)
    setSearchHistory(await window.api.getSearchHistory())
  }, [])

  const clearSearchHistory = useCallback(async () => {
    await window.api.clearSearchHistory()
    setSearchHistory([])
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = toastTimers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      toastTimers.current.delete(id)
    }
    if (lastToast.current?.id === id) lastToast.current = null
  }, [])

  const toast = useCallback<AppContextValue['toast']>(
    (message, options) => {
      const timeout = options?.timeout ?? (options?.actionLabel ? 7000 : 4000)
      const schedule = (id: number): void => {
        const pending = toastTimers.current.get(id)
        if (pending !== undefined) window.clearTimeout(pending)
        toastTimers.current.set(id, window.setTimeout(() => dismissToast(id), timeout))
      }

      // The same message raised again while the previous one is still on screen
      // (e.g. a slider drag) must not pile up: keep one toast and restart its
      // timer instead of adding another.
      const previous = lastToast.current
      if (previous && previous.message === message) {
        schedule(previous.id)
        return
      }

      const id = ++toastId.current
      lastToast.current = { id, message }
      // Hard cap: a burst can never build a stack taller than the screen.
      setToasts((prev) =>
        [
          ...prev,
          { id, message, actionLabel: options?.actionLabel, onAction: options?.onAction }
        ].slice(-MAX_TOASTS)
      )
      schedule(id)
    },
    [dismissToast]
  )

  const saveYoutubePlaylist = useCallback<AppContextValue['saveYoutubePlaylist']>(
    async (source) => {
      // Saving something already saved is a no-op, not something to announce:
      // every caller reflects the saved state in its own UI instead.
      if (playlistsRef.current.some((p) => p.youtubeId === source.youtubeId)) return
      await window.api.createPlaylist(source.name, {
        youtubeId: source.youtubeId,
        name: source.name,
        author: source.author ?? null,
        countText: source.countText ?? null,
        thumbnail: source.thumbnail ?? null
      })
      await refreshPlaylists()
      toast(`Saved "${source.name}" to playlists`)
    },
    [refreshPlaylists, toast]
  )

  // Fast O(1) lookup map for video watch history, reactive to history changes
  const historyMap = useMemo(() => {
    const map = new Map<string, HistoryEntry>()
    for (const h of history) {
      map.set(h.videoId, h)
    }
    return map
  }, [history])

  const getHistoryProgress = useCallback(
    (videoId: string, fallbackDuration?: number | null): number => {
      const match = historyMap.get(videoId)
      if (!match || match.position <= 0) return 0
      const duration = match.duration || fallbackDuration
      if (!duration || duration <= 0) return 0
      return Math.min(1, Math.max(0, match.position / duration))
    },
    [historyMap]
  )

  const getHistoryEntry = useCallback(
    (videoId: string): HistoryEntry | undefined => historyMap.get(videoId),
    [historyMap]
  )

  const updateHistoryPosition = useCallback(
    (videoId: string, position: number, duration?: number) => {
      if (!settings.saveWatchHistory) return
      void window.api.updateHistoryPosition(videoId, position)
      setHistory((prev) => {
        const idx = prev.findIndex((h) => h.videoId === videoId)
        if (idx === -1) {
          void window.api.getHistory().then((latest) => setHistory(latest))
          return prev
        }
        const existing = prev[idx]
        if (
          Math.abs(existing.position - position) < 0.5 &&
          (!duration || existing.duration === duration)
        ) {
          return prev
        }
        const updated: HistoryEntry = {
          ...existing,
          position,
          duration: duration ?? existing.duration,
          watchedAt: Date.now()
        }
        const next = [...prev]
        next[idx] = updated
        return next
      })
    },
    [settings.saveWatchHistory]
  )

  // Fast O(1) set for saved channels, reactive to savedChannels changes
  const savedChannelsSet = useMemo(
    () => new Set(savedChannels.map((c) => c.channelId)),
    [savedChannels]
  )

  const isChannelSaved = useCallback(
    (channelId: string): boolean => savedChannelsSet.has(channelId),
    [savedChannelsSet]
  )

  // Fast O(1) set for saved YouTube playlists, reactive to playlists changes
  const savedPlaylistsSet = useMemo(
    () => new Set(playlists.map((p) => p.youtubeId).filter((id): id is string => Boolean(id))),
    [playlists]
  )

  /** Whether a YouTube playlist is already bookmarked, so buttons can flip to "Remove". */
  const isYoutubePlaylistSaved = useCallback(
    (youtubeId: string): boolean => savedPlaylistsSet.has(youtubeId),
    [savedPlaylistsSet]
  )

  /** Undoes `saveYoutubePlaylist`, used by the "Remove from playlists" affordances. */
  const removeYoutubePlaylist = useCallback<AppContextValue['removeYoutubePlaylist']>(
    async (youtubeId: string) => {
      const target = playlistsRef.current.find((p) => p.youtubeId === youtubeId)
      if (!target) return
      await window.api.deletePlaylist(target.id)
      await refreshPlaylists()
      toast(`Removed "${target.name}" from playlists`)
    },
    [refreshPlaylists, toast]
  )

  const saveYoutubePlaylistSummary = useCallback<AppContextValue['saveYoutubePlaylistSummary']>(
    async (summary) => {
      await saveYoutubePlaylist({
        youtubeId: summary.id,
        name: summary.title,
        author: summary.author,
        countText: summary.countText,
        thumbnail: summary.thumbnail
      })
    },
    [saveYoutubePlaylist]
  )

  /** Keeps the stored snapshot of a YouTube playlist in sync with what we just fetched. */
  const touchYoutubePlaylist = useCallback<AppContextValue['touchYoutubePlaylist']>(
    (playlist) => {
      setPlaylists((prev) =>
        prev.map((p) =>
          p.id === playlist.id
            ? {
                ...p,
                name: playlist.name,
                countText: playlist.countText ?? p.countText,
                thumbnail: playlist.thumbnail ?? p.thumbnail,
                syncedAt: Date.now()
              }
            : p
        )
      )
    },
    []
  )

  const confirm = useCallback<AppContextValue['confirm']>((message, options) => {
    return new Promise<boolean>((resolve) => {
      setConfirmRequest({
        message,
        confirmLabel: options?.confirmLabel ?? 'Confirm',
        danger: options?.danger ?? false,
        resolve
      })
    })
  }, [])

  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatus>({
    state: 'idle',
    currentVersion: '0.5.1'
  })

  useEffect(() => {
    void window.api.getUpdaterStatus().then((s) => {
      if (s) setUpdaterStatus(s)
    })
    const unsub = window.api.onUpdaterStatus((s) => {
      setUpdaterStatus(s)
      if (s.state === 'downloaded') {
        toast(`ViewFlux v${s.availableVersion ?? ''} is downloaded and ready to install.`, {
          actionLabel: 'Restart now',
          onAction: () => {
            void window.api.installUpdate()
          },
          timeout: 15000
        })
      }
    })
    return unsub
  }, [toast])

  const checkForUpdates = useCallback(async () => {
    setUpdaterStatus((prev) => ({ ...prev, state: 'checking', error: undefined }))
    const res = await window.api.checkForUpdates()
    setUpdaterStatus(res)
    return res
  }, [])

  const installUpdate = useCallback(async () => {
    await window.api.installUpdate()
  }, [])

  const exportData = useCallback(async (): Promise<string> => {
    return window.api.exportData()
  }, [])

  const importData = useCallback(async (json: string) => {
    const res = await window.api.importData(json)
    if (res.success) {
      const [s, p, h, sh, sc, cf] = await Promise.all([
        window.api.getSettings(),
        window.api.getPlaylists(),
        window.api.getHistory(),
        window.api.getSearchHistory(),
        window.api.getSavedChannels(),
        window.api.getChannelFolders()
      ])
      setSettings(s)
      setPlaylists(p)
      setHistory(h)
      setSearchHistory(sh)
      setSavedChannels(sc)
      setChannelFolders(cf)
    }
    return res
  }, [])

  const value = useMemo<AppContextValue>(
    () => ({
      settings,
      playlists,
      history,
      historyMap,
      searchHistory,
      savedChannels,
      channelFolders,
      loaded,
      isReducedMotion,
      systemPrefersReducedMotion,
      saveSettings,
      refreshPlaylists,
      refreshHistory,
      refreshSearchHistory,
      refreshSavedChannels,
      refreshChannelFolders,
      saveChannel,
      updateSavedChannel,
      removeSavedChannel,
      toggleFavoriteChannel,
      createChannelFolder,
      renameChannelFolder,
      deleteChannelFolder,
      recordSearch,
      removeSearch,
      clearSearchHistory,
      updateHistoryPosition,
      getHistoryProgress,
      getHistoryEntry,
      isChannelSaved,
      saveYoutubePlaylist,
      saveYoutubePlaylistSummary,
      isYoutubePlaylistSaved,
      removeYoutubePlaylist,
      touchYoutubePlaylist,
      exportData,
      importData,
      toast,
      confirm,
      updaterStatus,
      checkForUpdates,
      installUpdate
    }),
    [
      settings,
      playlists,
      history,
      historyMap,
      searchHistory,
      savedChannels,
      channelFolders,
      loaded,
      isReducedMotion,
      systemPrefersReducedMotion,
      saveSettings,
      refreshPlaylists,
      refreshHistory,
      refreshSearchHistory,
      refreshSavedChannels,
      refreshChannelFolders,
      saveChannel,
      updateSavedChannel,
      removeSavedChannel,
      toggleFavoriteChannel,
      createChannelFolder,
      renameChannelFolder,
      deleteChannelFolder,
      recordSearch,
      removeSearch,
      clearSearchHistory,
      updateHistoryPosition,
      getHistoryProgress,
      getHistoryEntry,
      isChannelSaved,
      saveYoutubePlaylist,
      saveYoutubePlaylistSummary,
      isYoutubePlaylistSaved,
      removeYoutubePlaylist,
      touchYoutubePlaylist,
      exportData,
      importData,
      toast,
      confirm,
      updaterStatus,
      checkForUpdates,
      installUpdate
    ]
  )

  const respond = (result: boolean): void => {
    confirmRequest?.resolve(result)
    setConfirmRequest(null)
  }

  return (
    <AppContext.Provider value={value}>
      {children}
      {/* Announced as a polite live region: toasts are the app's only feedback
          channel for things like "Settings saved" and SponsorBlock skips, and
          without this a screen-reader user gets no confirmation at all. */}
      <div className="toast-stack" role="status" aria-live="polite" aria-relevant="additions text">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span className="toast__message">{t.message}</span>
            {t.actionLabel && (
              <button
                className="toast__action"
                onClick={() => {
                  t.onAction?.()
                  dismissToast(t.id)
                }}
              >
                {t.actionLabel}
              </button>
            )}
            <button className="toast__close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      {confirmRequest && (
        /* Was a hand-rolled copy of the modal shell, and so it was missing
           everything `Dialog` fixes: no portal (the scrim was laid out against
           whatever ancestor `confirm()` was called from), no Tab trap (tabbing
           out walked into the page behind it), and no backdrop
           `stopPropagation` (React portals bubble along the React tree, so a
           scrim click could activate the row that opened the prompt). */
        <Dialog title={confirmRequest.message} initialFocus="auto" onClose={() => respond(false)}>
          <div className="modal__actions">
            {/* Focus lands on Cancel: a destructive confirmation should never
                be one stray Enter away from being accepted. `initialFocus="auto"`
                hands focus management to this button instead of the panel. */}
            <button className="btn btn--text" autoFocus onClick={() => respond(false)}>
              Cancel
            </button>
            <button
              className={`btn ${confirmRequest.danger ? 'btn--danger' : 'btn--filled'}`}
              onClick={() => respond(true)}
            >
              {confirmRequest.confirmLabel}
            </button>
          </div>
        </Dialog>
      )}
    </AppContext.Provider>
  )
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
