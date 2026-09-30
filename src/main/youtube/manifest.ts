import { ORIGIN, REFERER, USER_AGENT } from '../http'
import { rewriteDash, rewriteHls } from '../proxy'
import { CLIENT, getClient } from './client'
import { pruneMap } from './tokens'
import type { CachedManifest } from './types'
import type { VideoService } from './video'

const MANIFEST_TTL_MS = 3 * 60 * 1000
const LIVE_TTL_MS = 60 * 1000

export class ManifestService {
  private readonly manifestCache = new Map<string, CachedManifest>()
  private proxyBase = ''

  constructor(private readonly videoService: VideoService) {}

  setProxyBase(base: string): void {
    this.proxyBase = base
  }

  async getManifest(videoId: string, force = false): Promise<string | null> {
    if (force) {
      this.videoService.clearInfoCache(videoId)
      this.manifestCache.delete(videoId)
    } else {
      const cached = this.manifestCache.get(videoId)
      if (cached && Date.now() - cached.fetchedAt < cached.ttl) {
        this.manifestCache.delete(videoId)
        this.manifestCache.set(videoId, cached)
        return cached.xml
      }
    }

    const yt = await getClient()
    const info = await yt.getBasicInfo(videoId, { client: CLIENT })
    if (info.playability_status?.status !== 'OK' || !info.streaming_data) return null

    const sd = info.streaming_data as unknown as {
      dash_manifest_url?: string
      hls_manifest_url?: string
    }

    const providedManifest = sd.hls_manifest_url ?? sd.dash_manifest_url
    const isLive = Boolean(info.basic_info?.is_live)

    if (isLive) {
      const xml =
        (providedManifest ? await this.fetchLiveManifest(providedManifest) : null) ??
        (await this.liveFallbackManifest(videoId))
      if (xml) {
        this.manifestCache.set(videoId, { xml, fetchedAt: Date.now(), ttl: LIVE_TTL_MS })
        pruneMap(this.manifestCache, 30)
        return xml
      }
      return null
    }

    try {
      const xml = await info.toDash({
        url_transformer: (url: URL) =>
          new URL(`${this.proxyBase}/media?u=${encodeURIComponent(url.toString())}`)
      })
      this.manifestCache.set(videoId, { xml, fetchedAt: Date.now(), ttl: MANIFEST_TTL_MS })
      pruneMap(this.manifestCache, 30)
      return xml
    } catch {
      const xml =
        (providedManifest ? await this.fetchLiveManifest(providedManifest) : null) ??
        (await this.liveFallbackManifest(videoId))
      if (xml) {
        this.manifestCache.set(videoId, { xml, fetchedAt: Date.now(), ttl: LIVE_TTL_MS })
        pruneMap(this.manifestCache, 30)
        return xml
      }
      return null
    }
  }

  private async liveFallbackManifest(videoId: string): Promise<string | null> {
    const yt = await getClient()
    for (const client of ['VISIONOS', 'ANDROID', 'ANDROID_VR'] as const) {
      try {
        const info = await yt.getBasicInfo(videoId, { client })
        if (info.playability_status?.status !== 'OK' || !info.streaming_data) continue
        const sd = info.streaming_data as unknown as {
          dash_manifest_url?: string
          hls_manifest_url?: string
        }
        const provided = sd.hls_manifest_url ?? sd.dash_manifest_url
        if (!provided) continue
        const xml = await this.fetchLiveManifest(provided)
        if (xml) return xml
      } catch {
        /* try next client */
      }
    }
    return null
  }

  private async fetchLiveManifest(manifestUrl: string): Promise<string | null> {
    let target = manifestUrl
    try {
      const decipher = (await getClient()).session.player
      if (decipher) target = (await decipher.decipher(manifestUrl)) ?? manifestUrl
    } catch {
      /* play undeciphered URL */
    }

    try {
      const res = await fetch(target, {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: REFERER,
          Origin: ORIGIN
        }
      })
      if (!res.ok) return null
      const body = await res.text()
      if (!this.proxyBase) return body
      if (body.trimStart().startsWith('#EXTM3U')) {
        try {
          return rewriteHls(body, this.proxyBase, new URL(target))
        } catch {
          // fallback to regex
        }
      }
      try {
        return rewriteDash(body, this.proxyBase, new URL(target))
      } catch {
        // fall through
      }
      return body.replace(/https:\/\/[^\s"'<>\]]+/g, (url) =>
        url.includes('.googlevideo.com') || url.includes('.youtube.com')
          ? `${this.proxyBase}/media?u=${encodeURIComponent(url)}`
          : url
      )
    } catch {
      return null
    }
  }
}
