/**
 * Shared type definitions used across the main process, preload bridge and renderer.
 * Everything that crosses the IPC boundary is a plain, structured-cloneable object.
 */

import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from './subtitles'

export interface Thumb {
  url: string
  width: number
  height: number
}

export interface VideoSummary {
  videoId: string
  title: string
  author: string
  authorId: string | null
  /** Channel avatar next to the author name; null when the source node has none. */
  authorAvatar: string | null
  duration: number | null
  thumbnail: string
  viewCount: number | null
  published: string | null
  isLive: boolean
  isPremiere?: boolean
  isStreamed?: boolean
  publishTimestamp?: number | null
}

export interface ChannelSummary {
  id: string
  name: string
  avatar: string | null
  /** e.g. '@veritasium' */
  handle: string | null
  /** e.g. '21.3M subscribers' */
  subscribers: string | null
  /** e.g. '536 videos' */
  videoCount: string | null
  description: string | null
  /** Music channel — YouTube shows its note logo next to the channel name. */
  isMusic?: boolean
}

export interface PlaylistSummary {
  id: string
  title: string
  author: string | null
  /** Channel id of the playlist owner, so the name can link to their page. */
  authorId?: string | null
  /** Avatar of the playlist owner. */
  authorAvatar?: string | null
  /** Number of videos, parsed from text when possible. */
  count: number | null
  /** Raw count text, e.g. '30 videos'. */
  countText: string | null
  thumbnail: string | null
  /** Music release (a channel's "Releases" tab) rather than a regular playlist. */
  isAlbum?: boolean
  /** Release year, e.g. '2026'. */
  year?: string | null
}

export type SearchItem =
  | ({ type: 'video' } & VideoSummary)
  | ({ type: 'channel' } & ChannelSummary)
  | ({ type: 'playlist' } & PlaylistSummary)

export type SearchFilter = 'all' | 'videos' | 'channels' | 'playlists' | 'music'

export interface SearchPage {
  items: SearchItem[]
  /** Opaque token used to request the next page, or null when exhausted. */
  continuation: string | null
}

export interface SearchHistoryEntry {
  query: string
  searchedAt: number
}

export interface CaptionTrack {
  languageCode: string
  name: string
  kind: string | null
  isTranslatable: boolean
  isAutomatic: boolean
  /** Proxied, VTT-converted URL ready to be handed to the player. */
  url: string
}

export interface Chapter {
  title: string
  /** Start time in seconds */
  start: number
  /** End time in seconds */
  end: number
  /** Optional thumbnail URL */
  thumbnail?: string | null
}

export interface VideoDetails {
  videoId: string
  title: string
  author: string
  authorId: string | null
  authorThumbnail: string | null
  duration: number
  viewCount: number | null
  likeCount: number | null
  publishDate: string | null
  relativeDate?: string | null
  publishTimestamp?: number | null
  description: string
  thumbnails: Thumb[]
  isLive: boolean
  isPremiere?: boolean
  isStreamed?: boolean
  playable: boolean
  reason: string | null
  /** Local manifest URL served by the media proxy. Null when unplayable. */
  manifestUrl: string | null
  /**
   * BCP-47 language of the video's original audio track (from the player
   * response `audioTrack.audioIsDefault` / `is_original` markers — the same
   * two sources NewPipeExtractor uses). Null when it cannot be determined.
   */
  defaultAudioLanguage: string | null
  captions: CaptionTrack[]
  keywords: string[]
  chapters: Chapter[]
}

export interface SponsorSegment {
  category: string
  /** [start, end] in seconds. */
  segment: [number, number]
  uuid: string
  actionType: string
  votes: number
  locked: boolean
}

export interface RydResult {
  likes: number
  dislikes: number
  rating: number
  viewCount: number
}

export interface HistoryEntry {
  videoId: string
  title: string
  author: string
  thumbnail: string
  duration: number | null
  /** Last playback position in seconds. */
  position: number
  watchedAt: number
  /** Channel id when known (entries recorded before this field fall back to a search). */
  authorId?: string | null
  /** Channel avatar when known, so History rows can show the same chip as playlists. */
  authorAvatar?: string | null
  viewCount?: number | null
  published?: string | null
  publishTimestamp?: number | null
  isPremiere?: boolean
  isStreamed?: boolean
  isLive?: boolean
}

export interface PlaylistVideo {
  videoId: string
  title: string
  author: string
  thumbnail: string
  duration: number | null
  addedAt: number
  /** Channel id when known (older entries predate this field). */
  authorId?: string | null
  /** Channel avatar when known. */
  authorAvatar?: string | null
  /** View count when known. */
  viewCount?: number | null
  /** Relative publish text ('5d ago') when known. */
  published?: string | null
  publishTimestamp?: number | null
  isPremiere?: boolean
  isStreamed?: boolean
  isLive?: boolean
}

/**
 * A playlist can either be a local bookmark list (videos stored on this device) or a
 * reference to a real YouTube playlist, which stays in sync with YouTube.
 */
export interface Playlist {
  id: string
  name: string
  createdAt: number
  videos: PlaylistVideo[]
  /** Defaults to 'local' when omitted (older data). */
  kind?: 'local' | 'youtube'
  /** Playlist id on YouTube, for kind === 'youtube'. */
  youtubeId?: string
  author?: string | null
  countText?: string | null
  thumbnail?: string | null
  /** Last time the remote contents were fetched. */
  syncedAt?: number | null
}

/** Everything needed to bookmark a YouTube playlist into the app. */
export interface PlaylistSource {
  youtubeId: string
  name: string
  author?: string | null
  countText?: string | null
  thumbnail?: string | null
}

export interface ChannelInfo {
  id: string
  name: string
  avatar: string | null
  banner: string | null
  handle: string | null
  subscribers: string | null
  videoCount: string | null
  description: string | null
  /** Tab names available on the channel, e.g. ['Videos', 'Playlists']. */
  tabs: string[]
  /** Music channel — YouTube shows its note logo next to the channel name. */
  isMusic?: boolean
}

export type ChannelSort = 'newest' | 'oldest' | 'popular'

export interface ChannelFolder {
  id: string
  name: string
  createdAt: number
}

export interface SavedChannel {
  channelId: string
  title: string
  handle?: string | null
  avatar?: string | null
  savedAt: number
  folderId?: string | null
  labels: string[]
  isFavorite?: boolean
}

export interface ChannelVideosPage {
  items: VideoSummary[]
  /**
   * Opaque continuation token for infinite scroll, or null when exhausted.
   *
   * Non-`newest` sorts are applied server-side via InnerTube's filter chips, so
   * pages are already correctly ordered and the renderer does not need to know
   * how the ordering was produced.
   */
  continuation: string | null
}

export interface AboutInfo {
  description: string | null
  country: string | null
  subscriberCount: string | null
  viewCount: string | null
  joinedDate: string | null
  videoCount: string | null
  links: { title: string; url: string }[]
}

export interface RemotePlaylist {
  id: string
  title: string
  author: string | null
  /** Total item count when known, else null. */
  count: number | null
  countText: string | null
  views: string | null
  lastUpdated: string | null
  description: string | null
  thumbnail: string | null
  items: VideoSummary[]
  continuation: string | null
}

export type ReduceMotionSetting = 'system' | 'on' | 'off'

export interface Settings {
  sponsorBlockEnabled: boolean
  autoSkip: boolean
  sponsorCategories: Record<string, boolean>
  showDislikes: boolean
  defaultVolume: number
  /** Preferred max height, or 'auto' / 'max'. */
  preferredQuality: 'auto' | 'max' | '2160' | '1440' | '1080' | '720' | '480' | '360'
  preferredSpeed: number
  alwaysShowCaptions: boolean
  /** Caption size, colour and background. */
  subtitleStyle: SubtitleStyle
  /** Keep audio pitch when changing playback speed. */
  preservePitch: boolean
  /** Auto-skip silent parts (experimental). */
  skipSilence: boolean
  /** UI accent color id. */
  accent: string
  /**
   * UI motion behavior:
   * - 'system': Follow operating system preference (prefers-reduced-motion)
   * - 'on': Force reduce motion (animations & transitions minimized)
   * - 'off': Force full motion (animations & transitions enabled)
   */
  reduceMotion: ReduceMotionSetting
  /** Whether to respect the system prefers-reduced-motion setting. */
  respectSystemMotion?: boolean
  /** Automatically play next video in a playlist. */
  autoplayPlaylists: boolean
  /** Store searches in search history. */
  saveSearchHistory: boolean
  /** Record watched videos and their last position. */
  saveWatchHistory: boolean
  /** Maximum number of watch history entries stored. */
  maxWatchHistory: number
  /** Maximum number of search history entries stored. */
  maxSearchHistory: number
  defaultViewMode: 'grid' | 'list'
  viewModes?: Record<string, 'grid' | 'list'>
}

export interface AppData {
  history: HistoryEntry[]
  playlists: Playlist[]
  searchHistory: SearchHistoryEntry[]
  settings: Settings
  savedChannels: SavedChannel[]
  channelFolders: ChannelFolder[]
}

export const ACCENTS: { id: string; label: string; color: string }[] = [
  { id: 'purple', label: 'Purple', color: '#d0bcff' },
  { id: 'coral', label: 'Coral', color: '#ffa39e' },
  { id: 'blue', label: 'Blue', color: '#a8c8ff' },
  { id: 'teal', label: 'Teal', color: '#7ad0d0' },
  { id: 'green', label: 'Green', color: '#a6d37f' },
  { id: 'amber', label: 'Amber', color: '#f5c26b' },
  { id: 'pink', label: 'Pink', color: '#ffb1c8' },
  { id: 'red', label: 'Red', color: '#ffb4ab' }
]

export const SPONSOR_CATEGORIES: { id: string; label: string }[] = [
  { id: 'sponsor', label: 'Sponsor' },
  { id: 'selfpromo', label: 'Unpaid / Self Promotion' },
  { id: 'interaction', label: 'Interaction Reminder' },
  { id: 'intro', label: 'Intermission / Intro Animation' },
  { id: 'outro', label: 'Endcards / Credits' },
  { id: 'preview', label: 'Preview / Recap' },
  { id: 'music_offtopic', label: 'Non-Music Section' },
  { id: 'filler', label: 'Filler / Tangents' }
]

/**
 * SponsorBlock returns a bare category id; the UI needs a name and a colour.
 * Both live here next to {@link SPONSOR_CATEGORIES} so a new category is added
 * in one place instead of three (settings list, player bar, skip toast).
 */
export const SPONSOR_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  SPONSOR_CATEGORIES.map(({ id, label }) => [id, label])
)

/** Per-category accent used for the segments drawn on the player's seek bar. */
export const SPONSOR_CATEGORY_COLORS: Record<string, string> = {
  sponsor: '#2ba640',
  selfpromo: '#f5c518',
  interaction: '#5b6ee1',
  intro: '#00b3b3',
  outro: '#e11d48',
  preview: '#8b5cf6',
  music_offtopic: '#ff7f11',
  filler: '#a855f7'
}

/** Label for a category id, falling back to the raw id for unknown categories. */
export function sponsorCategoryLabel(category: string): string {
  return SPONSOR_CATEGORY_LABELS[category] ?? category
}

export const DEFAULT_SETTINGS: Settings = {
  sponsorBlockEnabled: true,
  autoSkip: true,
  sponsorCategories: {
    sponsor: true,
    selfpromo: true,
    interaction: false,
    intro: false,
    outro: false,
    preview: false,
    music_offtopic: false,
    filler: false
  },
  showDislikes: true,
  defaultVolume: 1,
  preferredQuality: 'auto',
  preferredSpeed: 1,
  alwaysShowCaptions: false,
  subtitleStyle: DEFAULT_SUBTITLE_STYLE,
  preservePitch: true,
  skipSilence: false,
  accent: 'purple',
  reduceMotion: 'system',
  respectSystemMotion: true,
  autoplayPlaylists: true,
  saveSearchHistory: true,
  saveWatchHistory: true,
  maxWatchHistory: 500,
  maxSearchHistory: 50,
  defaultViewMode: 'grid',
  viewModes: {}
}

export interface AppApi {
  search(query: string, filter: SearchFilter): Promise<SearchPage>
  searchMore(continuation: string): Promise<SearchPage>
  suggestions(query: string): Promise<string[]>
  getVideo(videoId: string): Promise<VideoDetails>
  /** Re-resolves a video's stream URLs (bypasses the manifest cache). */
  refreshManifest(videoId: string): Promise<boolean>
  /**
   * Direct progressive (muxed audio+video) stream URL through the proxy, used
   * as the last-resort fallback when adaptive/DASH playback keeps failing —
   * the same DASH→progressive ladder FreeTube and NewPipe use. Null when the
   * video offers no muxed format.
   */
  getProgressiveUrl(videoId: string): Promise<string | null>
  getSponsorSegments(videoId: string, categories: string[]): Promise<SponsorSegment[]>
  getDislikes(videoId: string): Promise<RydResult | null>

  getChannel(id: string): Promise<ChannelInfo>
  getChannelVideos(id: string, sort: ChannelSort): Promise<ChannelVideosPage>
  channelVideosMore(continuation: string): Promise<ChannelVideosPage>
  getChannelPlaylists(id: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }>
  channelPlaylistsMore(continuation: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }>
  /** Music releases (albums) of a music channel. */
  getChannelReleases(id: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }>
  channelReleasesMore(continuation: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }>
  getChannelAbout(id: string): Promise<AboutInfo>
  getRemotePlaylist(id: string): Promise<RemotePlaylist>
  remotePlaylistMore(continuation: string): Promise<RemotePlaylist>

  getSavedChannels(): Promise<SavedChannel[]>
  saveChannel(channel: SavedChannel): Promise<SavedChannel>
  updateSavedChannel(channelId: string, patch: Partial<SavedChannel>): Promise<SavedChannel | undefined>
  toggleFavoriteChannel(channelId: string): Promise<SavedChannel | undefined>
  removeSavedChannel(channelId: string): Promise<void>

  getChannelFolders(): Promise<ChannelFolder[]>
  createChannelFolder(name: string): Promise<ChannelFolder>
  renameChannelFolder(id: string, name: string): Promise<void>
  deleteChannelFolder(id: string): Promise<void>

  /**
   * Recent uploads across the given channels. `requestId` tags every
   * `onFeedProgress` event for this call, so a stale progress bar from an
   * earlier request can never be attributed to the current one.
   */
  getSavedChannelsFeed(
    channelIds: string[],
    maxAgeDays?: number,
    requestId?: string
  ): Promise<VideoSummary[]>

  /**
   * Channel pictures for browse ids, used to fill in the avatars YouTube omits
   * from playlist and music search results. Ids with no resolvable picture map
   * to `null` so callers can cache the negative answer too.
   */
  getChannelAvatars(ids: string[]): Promise<Record<string, string | null>>

  /**
   * Subscribe to fetch progress for one `getSavedChannelsFeed` call. Pass the
   * same `requestId` you used on the call. Returns an unsubscribe function.
   */
  onFeedProgress(
    requestId: string,
    onProgress: (done: number, total: number) => void
  ): () => void

  getSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<Settings>

  getHistory(): Promise<HistoryEntry[]>
  addHistory(entry: HistoryEntry): Promise<void>
  updateHistoryPosition(videoId: string, position: number): Promise<void>
  removeHistory(videoId: string): Promise<void>
  clearHistory(): Promise<void>

  getSearchHistory(): Promise<SearchHistoryEntry[]>
  addSearchHistory(query: string): Promise<void>
  removeSearchHistory(query: string): Promise<void>
  clearSearchHistory(): Promise<void>

  getPlaylists(): Promise<Playlist[]>
  createPlaylist(name: string, source?: PlaylistSource): Promise<Playlist>
  renamePlaylist(id: string, name: string): Promise<void>
  deletePlaylist(id: string): Promise<void>
  addToPlaylist(id: string, video: PlaylistVideo): Promise<Playlist>
  removeFromPlaylist(id: string, videoId: string): Promise<Playlist>
  movePlaylistItem(id: string, from: number, to: number): Promise<Playlist>

  openExternal(url: string): Promise<void>
  exportData(): Promise<string>
  importData(json: string): Promise<DataImportResult>

  checkForUpdates(): Promise<UpdaterStatus>
  installUpdate(): Promise<void>
  getUpdaterStatus(): Promise<UpdaterStatus>
  onUpdaterStatus(callback: (status: UpdaterStatus) => void): () => void

  windowMinimize?: () => Promise<void>
  windowToggleMaximize?: () => Promise<boolean>
  windowClose?: () => Promise<void>
  isWindowMaximized?: () => Promise<boolean>
  onWindowMaximizedChange?: (callback: (maximized: boolean) => void) => () => void

  platform: 'win32' | 'darwin' | 'linux' | string
}

export interface DataImportResult {
  success: boolean
  error?: string
  stats?: {
    playlists: number
    savedChannels: number
    history: number
  }
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface UpdateProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export interface UpdaterStatus {
  state: UpdateState
  currentVersion: string
  availableVersion?: string
  releaseDate?: string
  releaseNotes?: string
  progress?: UpdateProgress
  error?: string
}
