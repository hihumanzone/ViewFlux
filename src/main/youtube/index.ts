import type {
  AboutInfo,
  ChannelInfo,
  ChannelSort,
  ChannelVideosPage,
  PlaylistSummary,
  RemotePlaylist,
  SearchFilter,
  SearchPage,
  VideoDetails,
  VideoSummary
} from '../../shared/types'
import { ChannelService } from './channel'
import { ManifestService } from './manifest'
import { PlaylistService } from './playlist'
import { SearchService } from './search'
import { TokenStore } from './tokens'
import { VideoService } from './video'

export class YoutubeService {
  private readonly tokens = new TokenStore()
  private readonly searchService: SearchService
  private readonly channelService: ChannelService
  private readonly playlistService: PlaylistService
  private readonly videoService: VideoService
  private readonly manifestService: ManifestService

  constructor() {
    this.searchService = new SearchService(this.tokens)
    this.channelService = new ChannelService(this.tokens)
    this.playlistService = new PlaylistService(this.tokens)
    this.videoService = new VideoService()
    this.manifestService = new ManifestService(this.videoService)
  }

  setProxyBase(base: string): void {
    this.videoService.setProxyBase(base)
    this.manifestService.setProxyBase(base)
  }

  // ---- Search ----
  search(query: string, filter: SearchFilter = 'all'): Promise<SearchPage> {
    return this.searchService.search(query, filter)
  }

  searchMore(token: string): Promise<SearchPage> {
    return this.searchService.searchMore(token)
  }

  suggestions(query: string): Promise<string[]> {
    return this.searchService.suggestions(query)
  }

  // ---- Channels ----
  getChannelInfo(id: string): Promise<ChannelInfo> {
    return this.channelService.getChannelInfo(id)
  }

  getChannelVideos(id: string, sort: ChannelSort): Promise<ChannelVideosPage> {
    return this.channelService.getChannelVideos(id, sort)
  }

  channelVideosMore(token: string): Promise<ChannelVideosPage> {
    return this.channelService.channelVideosMore(token)
  }

  getChannelPlaylists(id: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    return this.channelService.getChannelPlaylists(id)
  }

  channelPlaylistsMore(token: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    return this.channelService.channelPlaylistsMore(token)
  }

  getChannelReleases(id: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    return this.channelService.getChannelReleases(id)
  }

  channelReleasesMore(token: string): Promise<{ items: PlaylistSummary[]; continuation: string | null }> {
    return this.channelService.channelReleasesMore(token)
  }

  getChannelAbout(id: string): Promise<AboutInfo> {
    return this.channelService.getChannelAbout(id)
  }

  getChannelAvatars(ids: string[]): Promise<Record<string, string | null>> {
    return this.channelService.getChannelAvatars(ids)
  }

  getSavedChannelsFeed(
    channelIds: string[],
    maxAgeDays?: number,
    onProgress?: (done: number, total: number) => void
  ): Promise<VideoSummary[]> {
    return this.channelService.getSavedChannelsFeed(channelIds, maxAgeDays, onProgress)
  }

  // ---- Remote Playlists ----
  getRemotePlaylist(id: string): Promise<RemotePlaylist> {
    return this.playlistService.getRemotePlaylist(id)
  }

  remotePlaylistMore(token: string): Promise<RemotePlaylist> {
    return this.playlistService.remotePlaylistMore(token)
  }

  // ---- Videos & Streams ----
  getVideo(videoId: string): Promise<VideoDetails> {
    return this.videoService.getVideo(videoId)
  }

  getProgressiveUrl(videoId: string): Promise<string | null> {
    return this.videoService.getProgressiveUrl(videoId)
  }

  getManifest(videoId: string, force = false): Promise<string | null> {
    return this.manifestService.getManifest(videoId, force)
  }
}
