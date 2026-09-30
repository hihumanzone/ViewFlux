import type { Innertube } from 'youtubei.js'
import type { CaptionTrack, Chapter, VideoDetails } from '../../shared/types'
import { CLIENT, getClient } from './client'
import { extractVideoChapters, normalizeThumbs, pickThumbnail, text } from './parsers'
import { pruneMap } from './tokens'
import type { CachedInfo, TextLike, ThumbLike } from './types'

const INFO_TTL_MS = 10 * 60 * 1000

export class VideoService {
  private readonly infoCache = new Map<string, CachedInfo>()
  private readonly inFlightInfo = new Map<string, Promise<any>>()
  private proxyBase = ''

  setProxyBase(base: string): void {
    this.proxyBase = base
  }

  async getInfo(videoId: string): Promise<Awaited<ReturnType<Innertube['getInfo']>>> {
    const cached = this.infoCache.get(videoId)
    if (cached && Date.now() - cached.fetchedAt < INFO_TTL_MS) {
      this.infoCache.delete(videoId)
      this.infoCache.set(videoId, cached)
      return cached.info
    }
    const pending = this.inFlightInfo.get(videoId)
    if (pending) return pending

    const promise = (async () => {
      const yt = await getClient()
      let info: Awaited<ReturnType<Innertube['getInfo']>>
      try {
        info = await yt.getInfo(videoId, { client: CLIENT })
      } catch {
        info = (await yt.getBasicInfo(videoId, { client: CLIENT })) as any
      }
      this.infoCache.set(videoId, { info, fetchedAt: Date.now() })
      pruneMap(this.infoCache, 50)
      return info
    })().finally(() => {
      this.inFlightInfo.delete(videoId)
    })

    this.inFlightInfo.set(videoId, promise)
    return promise
  }

  clearInfoCache(videoId: string): void {
    this.infoCache.delete(videoId)
  }

  /**
   * Language of the video's original audio track, resolved exactly the way
   * NewPipe does: the player response marks one audio format via
   * `audioTrack.audioIsDefault`, and the `acont` xtag marks originals
   * (`Format.is_original`, excluding Stable-Volume/voice-boost variants).
   */
  defaultAudioLanguage(
    info: Awaited<ReturnType<VideoService['getInfo']>>
  ): string | null {
    const adaptive = info.streaming_data?.adaptive_formats as
      | {
          has_audio?: boolean
          language?: string | null
          audio_track?: { audio_is_default?: boolean }
          is_original?: boolean
          is_drc?: boolean
        }[]
      | undefined
    if (!adaptive) return null
    const audio = adaptive.filter((f) => f?.has_audio && f.language)
    if (audio.length === 0) return null
    const marked =
      audio.find((f) => f.audio_track?.audio_is_default && f.language) ??
      audio.find((f) => f.is_original && !f.is_drc && f.language)
    return (marked?.language ?? null) as string | null
  }

  private buildCaptions(
    raw: { base_url: string; language_code: string; name?: TextLike; kind?: string; is_translatable?: boolean }[] | undefined
  ): CaptionTrack[] {
    if (!raw) return []
    return raw.map((track) => ({
      languageCode: track.language_code,
      name: text(track.name) || track.language_code,
      kind: track.kind ?? null,
      isTranslatable: Boolean(track.is_translatable),
      isAutomatic: track.kind === 'asr',
      url: this.proxyBase
        ? `${this.proxyBase}/captions?lang=${encodeURIComponent(track.language_code)}&u=${encodeURIComponent(track.base_url)}`
        : ''
    }))
  }

  private extractChapters(
    info: Awaited<ReturnType<VideoService['getInfo']>>,
    duration: number,
    description: string
  ): Chapter[] {
    return extractVideoChapters(info, duration, description)
  }

  async getVideo(videoId: string): Promise<VideoDetails> {
    const info = await this.getInfo(videoId)
    const basic = info.basic_info
    const status = info.playability_status
    const playable = status?.status === 'OK' && Boolean(info.streaming_data)
    const thumbs = normalizeThumbs(basic.thumbnail)
    const duration = basic.duration ?? 0
    const description =
      text(info.secondary_info?.description) || basic.short_description || ''
    const authorThumb =
      pickThumbnail(
        (info.secondary_info as unknown as { owner?: { author?: { thumbnails?: ThumbLike[] } } })?.owner?.author?.thumbnails,
        176
      ) || null
    const chapters = this.extractChapters(info, duration, description)

    return {
      videoId: basic.id ?? videoId,
      title: basic.title ?? '',
      author: basic.channel?.name ?? basic.author ?? '',
      authorId: basic.channel?.id ?? basic.channel_id ?? null,
      authorThumbnail: authorThumb,
      duration,
      viewCount: basic.view_count ?? null,
      likeCount: basic.like_count ?? null,
      publishDate: info.primary_info?.published ? text(info.primary_info.published) || null : null,
      description,
      thumbnails: thumbs,
      isLive: Boolean(basic.is_live),
      playable,
      reason: playable ? null : (status?.reason ?? 'This video is not available'),
      manifestUrl: playable && this.proxyBase ? `${this.proxyBase}/manifest?id=${videoId}` : null,
      defaultAudioLanguage: this.defaultAudioLanguage(info),
      captions: this.buildCaptions(info.captions?.caption_tracks),
      keywords: basic.keywords ?? [],
      chapters
    }
  }

  /**
   * Direct progressive (single-file, audio+video) stream URL through the proxy.
   */
  async getProgressiveUrl(videoId: string): Promise<string | null> {
    try {
      const yt = await getClient()
      const info = await yt.getBasicInfo(videoId, { client: CLIENT })
      if (info.playability_status?.status !== 'OK' || !info.streaming_data || !this.proxyBase) {
        return null
      }
      const muxed = (info.streaming_data.formats ?? []).filter(
        (f) => f?.has_video && f?.has_audio && f.url
      )
      if (muxed.length === 0) return null
      muxed.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
      const best = muxed[0]
      return best?.url
        ? `${this.proxyBase}/media?u=${encodeURIComponent(best.url)}`
        : null
    } catch {
      return null
    }
  }
}
