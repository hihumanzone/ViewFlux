// TEMPORARY preview harness — delete before finishing.
import { createRoot } from 'react-dom/client'
import { AppProvider } from './state/AppContext'
import { WatchPage } from './pages/WatchPage'
import { ErrorBoundary } from './components/ErrorBoundary'
import { DEFAULT_SETTINGS } from '../../shared/types'
import './styles.css'

const PLAYLIST_ID = 'pl-preview'
const VIDEO_ID = 'vid-preview'

function makeVideo(index: number): Record<string, unknown> {
  return {
    videoId: `vid-${index}`,
    title: `Track ${index + 1} — a reasonably long title to force text wrapping`,
    author: 'Some Channel',
    thumbnail: '',
    duration: 210,
    addedAt: Date.now()
  }
}

const playlist = {
  id: PLAYLIST_ID,
  name: 'Preview Playlist',
  createdAt: Date.now(),
  kind: 'local',
  videos: Array.from({ length: 8 }, (_, i) => makeVideo(i))
}

const videoDetails = {
  videoId: VIDEO_ID,
  title: 'Preview Video',
  author: 'Some Channel',
  authorId: 'UCtest',
  authorThumbnail: null,
  duration: 300,
  viewCount: 1000,
  likeCount: 100,
  publishDate: '2024-01-01',
  relativeDate: 'Jan 1, 2024',
  description: 'Preview description.',
  thumbnails: [],
  isLive: false,
  playable: false,
  reason: 'preview',
  manifestUrl: null,
  defaultAudioLanguage: null,
  captions: [],
  keywords: [],
  chapters: []
}

const noop = (): undefined => undefined
const asyncStr = async (s: string) => async () => s
const asyncBool = async (b: boolean) => async () => b

;(window as unknown as { api: unknown }).api = {
  getSettings: async () => ({ ...DEFAULT_SETTINGS }),
  saveSettings: async () => undefined,
  getPlaylists: async () => [playlist],
  getHistory: async () => [],
  getSearchHistory: async () => [],
  getSavedChannels: async () => [],
  getChannelFolders: async () => [],
  refreshPlaylist: async () => undefined,
  addHistory: async () => undefined,
  getHistoryProgress: asyncStr('0'),
  updateHistoryPosition: async () => undefined,
  getVideo: async () => videoDetails,
  refreshManifest: asyncBool(false),
  getSponsorSegments: async () => [],
  getDislikes: async () => ({ likes: 100, dislikes: 5, rating: 5, viewCount: 1000 }),
  getChannel: async () => ({ avatar: null }),
  openExternal: async () => undefined,
  search: async () => ({ items: [], next: null }),
  suggestions: async () => [],
  getUpdaterStatus: async () => ({ state: 'idle', currentVersion: '0.0.0' }),
  checkForUpdates: async () => ({ state: 'idle', currentVersion: '0.0.0' }),
  installUpdate: async () => undefined,
  onUpdaterStatus: () => noop,
  setWindowMiniplayer: async () => undefined,
  getRemotePlaylist: async () => ({
    title: playlist.name,
    items: playlist.videos,
    continuation: null
  }),
  addToPlaylist: async () => undefined,
  removeFromPlaylist: async () => undefined,
  createPlaylist: async () => playlist,
  renamePlaylist: async () => undefined,
  deletePlaylist: async () => undefined,
  exportData: async () => '',
  importData: async () => ({ success: true, stats: { playlists: 1, savedChannels: 0, history: 0 } }),
  saveYoutubePlaylist: async () => undefined,
  saveYoutubePlaylistSummary: async () => undefined,
  removeYoutubePlaylist: async () => undefined
}

const container = document.getElementById('root')
if (!container) throw new Error('Root container #root not found')

createRoot(container).render(
  <ErrorBoundary>
    <AppProvider>
      <div className="app">
        <main className="content" id="main-content">
          <WatchPage videoId={VIDEO_ID} listId={PLAYLIST_ID} />
        </main>
      </div>
    </AppProvider>
  </ErrorBoundary>
)
