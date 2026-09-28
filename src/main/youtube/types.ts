import type { Innertube } from 'youtubei.js'

export interface TextLike {
  text?: string
  runs?: { text?: string }[]
  endpoint?: { payload?: { browseId?: string } }
  toString?: () => string
}

export interface ThumbLike {
  url: string
  width: number
  height: number
}

export interface LockupViewNode {
  type: 'LockupView'
  content_id: string
  content_type: string
  content_image: {
    image?: ThumbLike[]
    primary_thumbnail?: { image?: ThumbLike[]; overlays?: unknown[] }
    overlays?: unknown[]
  }
  metadata: {
    title?: TextLike
    image?: {
      image?: ThumbLike[]
      sources?: ThumbLike[]
      decoratedAvatarViewModel?: { avatar?: { image?: ThumbLike[]; sources?: ThumbLike[] } }
      renderer_context?: { command_context?: { on_tap?: { payload?: { browseId?: string } } } }
      avatar?: { endpoint?: { payload?: { browseId?: string } }; image?: ThumbLike[]; sources?: ThumbLike[] }
      endpoint?: { payload?: { browseId?: string } }
      on_tap_endpoint?: { payload?: { browseId?: string } }
    }
    metadata?: {
      metadata_rows?: {
        metadata_parts?: {
          text?: TextLike
          endpoint?: { payload?: { browseId?: string }; browseEndpoint?: { browseId?: string }; browseId?: string }
        }[]
      }[]
    }
  } | null
}

/** Any feed object that can be continued (search, channel tabs, playlists…). */
export interface Continuable {
  has_continuation?: boolean
  getContinuation(): Promise<unknown>
}

/**
 * The per-type node index youtubei.js builds while parsing (`Memo extends Map`).
 * Populated from `Parser.parseResponse`'s `*_memo` fields.
 */
export type NodeMemo = Map<string, unknown[]>

/**
 * A feed that lists playlists. Either a youtubei.js `Feed` or a raw `browse`
 * response adapted to the same shape, so both feed the same mappers.
 */
export interface PlaylistFeed extends Continuable {
  playlists?: unknown[]
  results?: unknown[]
}

export interface ContinuationEntry {
  kind:
    | 'search:all'
    | 'search:videos'
    | 'search:channels'
    | 'search:playlists'
    | 'search:music'
    | 'channel:videos'
    | 'channel:playlists'
    | 'channel:releases'
    | 'remote:playlist'
  feed: Continuable
  ctx?: Record<string, unknown>
}

export interface CachedInfo {
  info: Awaited<ReturnType<Innertube['getInfo']>>
  fetchedAt: number
}

export interface CachedManifest {
  xml: string
  fetchedAt: number
  /** Live manifests rotate fast — they expire sooner than VOD DASH. */
  ttl: number
}

export interface CachedChannel {
  channel: unknown
  fetchedAt: number
}
