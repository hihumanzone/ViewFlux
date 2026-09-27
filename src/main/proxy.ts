import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { isAudioItagUrl } from '../shared/media'
import { ORIGIN, REFERER, USER_AGENT } from './http'

const ALLOWED_HOST_SUFFIXES = [
  'googlevideo.com',
  'youtube.com',
  'ytimg.com',
  'googleusercontent.com',
  'ggpht.com'
]

function isAllowed(target: URL): boolean {
  if (target.protocol !== 'https:') return false
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => target.hostname === suffix || target.hostname.endsWith(`.${suffix}`)
  )
}

const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
  'cache-control'
]

const PLAYLIST_MAGIC = '#EXTM3U'

/** Bytes read ahead of the playlist decision — enough for any magic string. */
const SNIFF_LIMIT = 64

interface Sniffed {
  /** Full playlist text when the body really is HLS, otherwise null. */
  playlist: string | null
  /** Bytes already consumed from the body (replayed verbatim when binary). */
  prefix: Uint8Array
  /** Reader for whatever is left of the body. */
  reader: ReadableStreamDefaultReader<Uint8Array>
}

function isPlaylistPrefix(bytes: Uint8Array): boolean {
  let i = 0
  // RFC 8216 §4.1: a playlist starts with `#EXTM3U`, optionally behind a BOM.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3
  while (
    i < bytes.length &&
    (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)
  ) {
    i++
  }
  if (i + PLAYLIST_MAGIC.length > bytes.length) return false
  for (let k = 0; k < PLAYLIST_MAGIC.length; k++) {
    if (bytes[i + k] !== PLAYLIST_MAGIC.charCodeAt(k)) return false
  }
  return true
}

/**
 * Consumes at most `SNIFF_LIMIT` bytes of an upstream body to decide whether it
 * is an HLS playlist. If it is, the rest of the body is drained as text;
 * otherwise the caller replays the prefix and streams the remainder untouched.
 */
async function sniffBody(body: ReadableStream<Uint8Array>): Promise<Sniffed> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < SNIFF_LIMIT) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      size += value.byteLength
    }
  }
  const prefix = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
  if (!isPlaylistPrefix(prefix)) return { playlist: null, prefix, reader }

  const decoder = new TextDecoder('utf-8')
  let text = decoder.decode(prefix, { stream: true })
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) text += decoder.decode(value, { stream: true })
  }
  return { playlist: text + decoder.decode(), prefix, reader }
}

/** Re-emits already-sniffed bytes followed by the rest of the body, unchanged. */
async function* replay(sniffed: Sniffed): AsyncGenerator<Buffer> {
  try {
    if (sniffed.prefix.byteLength > 0) yield Buffer.from(sniffed.prefix)
    for (;;) {
      const { done, value } = await sniffed.reader.read()
      if (done) break
      if (value) yield Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    }
  } finally {
    void sniffed.reader.cancel().catch(() => undefined)
  }
}

export interface MediaProxyOptions {
  /** Returns a DASH manifest (already rewritten to proxy URLs) for a video. */
  getManifest: (videoId: string, force?: boolean) => Promise<string | null>
}

/**
 * A minimal localhost reverse proxy for YouTube media. It exists for three reasons:
 *  1. googlevideo URLs are bound to a matching Origin/Referer/User-Agent — the proxy supplies them.
 *  2. HTTP Range requests must pass through unchanged to keep adaptive seeking fast.
 *  3. Only allow-listed YouTube domains can be requested, so the proxy can't be abused.
 */
export class MediaProxy {
  private server: Server | null = null
  private port = 0

  constructor(private readonly options: MediaProxyOptions) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** Wraps an upstream media URL so the renderer requests it through this proxy. */
  mediaUrl(target: string): string {
    return `${this.baseUrl}/media?u=${encodeURIComponent(target)}`
  }

  /** Proxied, VTT-converted URL for a YouTube timedtext caption track. */
  captionUrl(baseUrl: string, languageCode: string): string {
    return `${this.baseUrl}/captions?lang=${encodeURIComponent(languageCode)}&u=${encodeURIComponent(baseUrl)}`
  }

  async start(): Promise<string> {
    if (this.server) return this.baseUrl
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('[proxy] unhandled error', err)
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address()
        if (address && typeof address === 'object') this.port = address.port
        resolve()
      })
    })
    return this.baseUrl
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  private setCors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization, X-Client-Data, Accept, If-Range, If-None-Match, If-Modified-Since')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Date, ETag')
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', this.baseUrl)

    if (url.pathname === '/manifest') {
      const videoId = url.searchParams.get('id')
      if (!videoId) {
        res.writeHead(400)
        res.end('missing id')
        return
      }
      const manifest = await this.options.getManifest(videoId, url.searchParams.get('refresh') === '1')
      if (!manifest) {
        res.writeHead(404)
        res.end('manifest unavailable')
        return
      }
      // Live streams served from YouTube's HLS playlist come back as m3u8;
      // everything else is a DASH MPD.
      const isHls = manifest.trimStart().startsWith('#EXTM3U')
      res.writeHead(200, {
        'Content-Type': isHls ? 'application/vnd.apple.mpegurl' : 'application/dash+xml',
        'Cache-Control': 'no-store'
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end(manifest)
      return
    }

    if (url.pathname === '/captions') {
      await this.handleCaptions(req, url, res)
      return
    }

    if (
      url.pathname === '/media' ||
      url.pathname === '/media.ts' ||
      url.pathname === '/media.aac' ||
      url.pathname === '/media.m3u8'
    ) {
      await this.handleMedia(req, url, res)
      return
    }

    res.writeHead(404)
    res.end('not found')
  }

  private async handleMedia(
    req: IncomingMessage,
    url: URL,
    res: ServerResponse
  ): Promise<void> {
    const raw = url.searchParams.get('u')
    if (!raw) {
      res.writeHead(400)
      res.end('missing u')
      return
    }
    let target: URL
    try {
      target = new URL(raw)
    } catch {
      res.writeHead(400)
      res.end('invalid url')
      return
    }
    if (!isAllowed(target)) {
      res.writeHead(403)
      res.end('host not allowed')
      return
    }

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Referer: REFERER,
      Origin: ORIGIN,
      'Accept-Encoding': 'identity'
    }
    if (req.headers.range) headers.Range = req.headers.range
    if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'] as string

    const controller = new AbortController()
    let clientClosed = false
    req.on('close', () => {
      clientClosed = true
      controller.abort()
    })

    let upstream: Response | null = null
    let lastStatus = 0
    for (let attempt = 0; attempt < 3; attempt++) {
      if (clientClosed) return
      try {
        const resp = await fetch(target, {
          headers,
          redirect: 'follow',
          signal: controller.signal
        })
        lastStatus = resp.status
        if (resp.status >= 500) {
          await resp.body?.cancel().catch(() => undefined)
          if (attempt < 2 && !clientClosed) {
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt))
            continue
          }
        }
        upstream = resp
        break
      } catch (err) {
        if (clientClosed) return
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt))
          continue
        }
        console.error('[proxy] upstream media fetch failed', err)
        break
      }
    }

    if (!upstream) {
      if (!res.headersSent && !clientClosed) {
        res.writeHead(502, { 'Cache-Control': 'no-store' })
        res.end(`upstream unavailable (status ${lastStatus})`)
      }
      return
    }

    if (req.method === 'HEAD' || !upstream.body) {
      for (const name of PASSTHROUGH_HEADERS) {
        const value = upstream.headers.get(name)
        if (value) res.setHeader(name, value)
      }
      if (upstream.body) {
        void upstream.body.cancel().catch(() => undefined)
      }
      res.writeHead(upstream.status)
      res.end()
      return
    }

    // Never decide "this is a playlist" from the URL alone: YouTube serves
    // live MPEG-TS *segments* from `/api/manifest/playlist/index.m3u8/sq/...`,
    // so a path heuristic text-decodes binary media and hands the player
    // corrupted bytes (Shaka stalls with no error). Suspected playlists are
    // therefore confirmed by their own `#EXTM3U` magic (RFC 8216 §4.1) before
    // a single byte is reinterpreted; everything else streams through verbatim.
    const contentType = upstream.headers.get('content-type') ?? ''
    const maybePlaylist =
      contentType.includes('mpegurl') ||
      target.pathname.endsWith('.m3u8') ||
      target.pathname.includes('/playlist/') ||
      target.pathname.includes('/hls_playlist/')

    let sniffed: Sniffed | null = null
    if (upstream.status === 200 && maybePlaylist) {
      try {
        sniffed = await sniffBody(upstream.body)
        if (sniffed.playlist !== null) {
          const rewritten = rewriteHls(sniffed.playlist, this.baseUrl, target)
          const buffer = Buffer.from(rewritten, 'utf-8')
          res.setHeader('content-type', 'application/vnd.apple.mpegurl')
          res.setHeader('content-length', String(buffer.byteLength))
          res.setHeader('cache-control', 'no-cache, no-store, must-revalidate')
          res.writeHead(upstream.status)
          res.end(buffer)
          return
        }
      } catch (err) {
        // Client navigations abort in-flight playlist fetches constantly
        // (Shaka re-requests variant playlists every few seconds and drops
        // the old one) — an AbortError here is routine, not a failure.
        const aborted =
          clientClosed ||
          (err instanceof DOMException && err.name === 'AbortError') ||
          (err as { name?: string })?.name === 'AbortError'
        if (!aborted) {
          console.error('[proxy] failed to process HLS playlist', err)
        }
        if (!res.headersSent && !clientClosed) {
          res.writeHead(502, { 'Cache-Control': 'no-store' })
          res.end('hls processing error')
        }
        return
      }
    }

    const isAac =
      url.pathname.endsWith('.aac') || isAudioItagUrl(target.href)

    const isTsSegment =
      !isAac &&
      (url.pathname.endsWith('.ts') ||
        target.pathname.endsWith('.ts') ||
        target.pathname.includes('/seg.ts') ||
        target.pathname.includes('/sq/'))

    for (const name of PASSTHROUGH_HEADERS) {
      let value = upstream.headers.get(name)
      if (name === 'content-type' && (!value || value.includes('octet-stream'))) {
        if (isAac) value = 'audio/aac'
        else if (isTsSegment) value = 'video/mp2t'
      }
      if (value) res.setHeader(name, value)
    }
    if (isAac && (!res.getHeader('content-type') || res.getHeader('content-type') === 'application/octet-stream')) {
      res.setHeader('content-type', 'audio/aac')
    } else if (isTsSegment && (!res.getHeader('content-type') || res.getHeader('content-type') === 'application/octet-stream')) {
      res.setHeader('content-type', 'video/mp2t')
    }
    res.writeHead(upstream.status)

    // `sniffed.prefix` holds bytes already pulled off the wire; replay them in
    // front of the rest of the body so the response stays byte-identical.
    const stream = sniffed
      ? Readable.from(replay(sniffed))
      : Readable.fromWeb(upstream.body as unknown as import('stream/web').ReadableStream)
    stream.on('error', () => {
      res.destroy()
    })
    stream.pipe(res)
    const onStreamClose = (): void => {
      stream.destroy()
    }
    req.on('close', onStreamClose)
    res.on('close', onStreamClose)
  }

  private async handleCaptions(
    req: IncomingMessage,
    url: URL,
    res: ServerResponse
  ): Promise<void> {
    const raw = url.searchParams.get('u')
    const lang = url.searchParams.get('lang') ?? 'en'
    if (!raw) {
      res.writeHead(400)
      res.end('missing u')
      return
    }
    let target: URL
    try {
      target = new URL(raw)
    } catch {
      res.writeHead(400)
      res.end('invalid url')
      return
    }
    if (!isAllowed(target)) {
      res.writeHead(403)
      res.end('host not allowed')
      return
    }
    target.searchParams.set('fmt', 'json3')

    try {
      const upstream = await fetch(target, {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: REFERER,
          'Accept-Encoding': 'identity'
        },
        redirect: 'follow'
      })
      if (!upstream.ok) {
        res.writeHead(404)
        res.end('captions unavailable')
        return
      }
      const json = (await upstream.json()) as CaptionJson
      const vtt = json3ToVtt(json)
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end(vtt)
    } catch (err) {
      console.error('[proxy] caption fetch failed', err)
      res.writeHead(502)
      res.end('caption error')
    }
    void lang
  }
}

interface CaptionJson {
  events?: {
    tStartMs?: number
    dDurationMs?: number
    segs?: { utf8?: string }[]
  }[]
}

function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000)
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`
}

function json3ToVtt(json: CaptionJson): string {
  const lines: string[] = ['WEBVTT', '']
  for (const event of json.events ?? []) {
    if (event.tStartMs == null || !event.segs) continue
    const text = event.segs
      .map((seg) => seg.utf8 ?? '')
      .join('')
      .replace(/\r?\n/g, ' ')
      .trim()
    if (!text) continue
    const start = event.tStartMs / 1000
    const end = start + (event.dDurationMs ?? 2000) / 1000
    lines.push(`${formatTimestamp(start)} --> ${formatTimestamp(end)}`)
    lines.push(text)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Rewrites an HLS playlist (master or variant) so all URI references
 * (segment URLs, sub-playlist URLs, initialization maps, keys, media tags)
 * route through our local reverse proxy.
 */
export function rewriteHls(content: string, proxyBase: string, targetUrl: URL): string {
  const lines = content.split(/\r?\n/)
  const out: string[] = []

  const isAudioPlaylist = isAudioItagUrl(targetUrl.href)

  const wrap = (rawUri: string, forceAudio = false): string => {
    const trimmed = rawUri.trim()
    if (!trimmed || trimmed.startsWith(proxyBase) || trimmed.startsWith('/media')) {
      return trimmed
    }
    try {
      const resolved = new URL(trimmed, targetUrl).toString()
      const isAudio = forceAudio || isAudioPlaylist || isAudioItagUrl(resolved)

      let ext = ''
      if (resolved.includes('.m3u8')) {
        ext = '.m3u8'
      } else if (isAudio) {
        ext = '.aac'
      } else if (resolved.includes('.ts') || resolved.includes('/seg.ts') || resolved.includes('/sq/')) {
        ext = '.ts'
      }
      return `${proxyBase}/media${ext}?u=${encodeURIComponent(resolved)}`
    } catch {
      return trimmed
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      out.push(line)
      continue
    }

    if (trimmed.startsWith('#')) {
      // Tags like #EXT-X-MEDIA, #EXT-X-MAP, #EXT-X-KEY can contain URI="..."
      if (trimmed.includes('URI=')) {
        const isAudioTag = trimmed.includes('TYPE=AUDIO')
        const rewrittenTag = line.replace(/URI=(["'])(.*?)\1/g, (_match, quote, uri) => {
          return `URI=${quote}${wrap(uri, isAudioTag)}${quote}`
        })
        out.push(rewrittenTag)
      } else {
        out.push(line)
      }
      continue
    }

    // Segment or sub-playlist URI line
    out.push(wrap(trimmed))
  }

  return out.join('\n')
}

