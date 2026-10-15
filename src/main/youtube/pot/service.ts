import type {
  CachedPoToken,
  BotGuardChallenge,
  PoTokenMode,
  PoTokenOptions,
  PoTokenStatus
} from './types'
import { createColdStartToken } from './coldStart'
import { ElectronPoMinter } from './electronMinter'
import { ExternalPoProvider } from './externalProvider'
import { emitPlayerDebugLog } from '../../debugLogger'

const TOKEN_CACHE_TTL_MS = 6 * 3600 * 1000 // 6 hours per video token
const MAX_CACHE_SIZE = 150

export class PoTokenService {
  private mode: PoTokenMode = 'auto'
  private externalUrl = 'http://127.0.0.1:4416'
  private manualToken = ''
  private manualVisitorData = ''

  private readonly tokenCache = new Map<string, CachedPoToken>()
  private readonly electronMinter = new ElectronPoMinter()
  private externalProvider = new ExternalPoProvider(this.externalUrl)

  private challengeFetcher: (() => Promise<BotGuardChallenge>) | null = null
  private mintedCount = 0
  private lastMintedAt: number | null = null
  private lastError: string | null = null

  setOptions(options: Partial<PoTokenOptions>): void {
    if (options.mode !== undefined) this.mode = options.mode
    if (options.externalUrl !== undefined && options.externalUrl !== this.externalUrl) {
      this.externalUrl = options.externalUrl
      this.externalProvider = new ExternalPoProvider(this.externalUrl)
    }
    if (options.manualToken !== undefined) this.manualToken = options.manualToken.trim()
    if (options.manualVisitorData !== undefined) {
      this.manualVisitorData = options.manualVisitorData.trim()
    }
  }

  setChallengeFetcher(fetcher: () => Promise<BotGuardChallenge>): void {
    this.challengeFetcher = fetcher
    // Warm up native minter in background if in auto mode
    if (this.mode === 'auto') {
      void this.electronMinter.initialize(fetcher).catch(() => {})
    }
  }

  async refresh(): Promise<boolean> {
    if (!this.challengeFetcher) return false
    this.tokenCache.clear()
    return this.electronMinter.initialize(this.challengeFetcher, true)
  }

  /**
   * Retrieves a valid Proof of Origin token bound to the requested video ID.
   */
  async getTokenForVideo(videoId: string): Promise<string | null> {
    if (this.mode === 'disabled') return null

    // Check existing valid cache entry
    const cached = this.tokenCache.get(videoId)
    if (cached && Date.now() < cached.expiresAt) {
      // Refresh LRU recency
      this.tokenCache.delete(videoId)
      this.tokenCache.set(videoId, cached)
      emitPlayerDebugLog({
        level: 'debug',
        subsystem: 'POTOKEN',
        action: 'TOKEN_CACHE_HIT',
        message: `Reusing cached PO token for video=${videoId} (source=${cached.source})`,
        data: { videoId, source: cached.source }
      })
      return cached.token
    }

    // 1. Manual override
    if (this.mode === 'manual' && this.manualToken) {
      this.cacheToken(videoId, this.manualToken, 'manual')
      return this.manualToken
    }

    // 2. External Provider mode
    if (this.mode === 'external') {
      const extToken = await this.externalProvider.getPoToken(videoId)
      if (extToken) {
        this.cacheToken(videoId, extToken, 'external')
        return extToken
      }
      emitPlayerDebugLog({
        level: 'warn',
        subsystem: 'POTOKEN',
        action: 'EXTERNAL_PROVIDER_FAILED',
        message: `External PO token provider failed for video=${videoId}; falling back to cold-start`,
        nextStep: 'Falling back to cold-start token'
      })
    }

    // 3. Automatic Mode: Native BotGuard Minter
    if (this.mode === 'auto' && this.challengeFetcher) {
      if (this.electronMinter.isHealthy) {
        try {
          const startTime = Date.now()
          const token = await this.electronMinter.mint(videoId)
          const duration = Date.now() - startTime

          this.cacheToken(videoId, token, 'botguard')
          emitPlayerDebugLog({
            level: 'info',
            subsystem: 'POTOKEN',
            action: 'TOKEN_MINT_SUCCESS',
            message: `Minted BotGuard PO token for video=${videoId} in ${duration}ms`,
            data: { videoId, durationMs: duration, tokenLength: token.length }
          })
          return token
        } catch (err) {
          this.lastError = (err as Error).message
          emitPlayerDebugLog({
            level: 'warn',
            subsystem: 'POTOKEN',
            action: 'TOKEN_MINT_ERROR',
            message: `Native minting failed: ${(err as Error).message}; falling back to cold-start`,
            rawError: (err as Error).stack ?? String(err)
          })
        }
      } else {
        // Trigger background initialization if not already underway
        void this.electronMinter.initialize(this.challengeFetcher).catch(() => {})
      }
    }

    // 4. Cold-Start Fallback Generator (Instantaneous zero-lag fallback)
    const coldToken = createColdStartToken(videoId)
    // Cold start tokens have a shorter cache life (1 hour) to encourage upgrading to full tokens
    this.cacheToken(videoId, coldToken, 'coldstart', 3600 * 1000)

    emitPlayerDebugLog({
      level: 'info',
      subsystem: 'POTOKEN',
      action: 'COLD_START_TOKEN_GENERATED',
      message: `Generated Cold Start PO token for video=${videoId}`,
      data: { videoId, tokenLength: coldToken.length }
    })

    return coldToken
  }

  /**
   * Retrieves a session-level PO token for Innertube creation.
   */
  async getSessionToken(): Promise<string | null> {
    if (this.mode === 'disabled') return null
    if (this.manualToken) return this.manualToken

    // When the BotGuard VM is healthy, mint an authentic session token (unbound)
    if (this.mode === 'auto' && this.electronMinter.isHealthy) {
      try {
        const token = await this.electronMinter.mint('')
        if (token) return token
      } catch {
        // Fall through to instant cold-start generator
      }
    }

    return createColdStartToken('VIEWFLUX_SESSION')
  }

  getVisitorData(): string | null {
    return this.manualVisitorData || null
  }

  /**
   * Invalidates a token (e.g. upon receiving an upstream 403 on googlevideo.com).
   */
  invalidateToken(videoId: string): void {
    this.tokenCache.delete(videoId)
    emitPlayerDebugLog({
      level: 'warn',
      subsystem: 'POTOKEN',
      action: 'TOKEN_INVALIDATED',
      message: `Invalidated PO token for video=${videoId}`,
      trigger: '403 Forbidden or manual refresh'
    })
  }

  private cacheToken(
    videoId: string,
    token: string,
    source: CachedPoToken['source'],
    ttl = TOKEN_CACHE_TTL_MS
  ): void {
    this.tokenCache.set(videoId, {
      token,
      source,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl
    })
    this.mintedCount++
    this.lastMintedAt = Date.now()

    // Prune oldest entries when cache exceeds capacity
    while (this.tokenCache.size > MAX_CACHE_SIZE) {
      const first = this.tokenCache.keys().next().value
      if (!first) break
      this.tokenCache.delete(first)
    }
  }

  getStatus(): PoTokenStatus {
    const hasIntegrity = this.mode !== 'disabled' && this.electronMinter.isHealthy
    let activeProvider = 'None'
    let healthy = false

    if (this.mode === 'auto') {
      activeProvider = hasIntegrity ? 'Native Chromium BotGuard' : 'Cold-Start Fallback (Minter Warming)'
      healthy = true
    } else if (this.mode === 'external') {
      activeProvider = `External (${this.externalUrl})`
      healthy = true
    } else if (this.mode === 'manual') {
      activeProvider = 'Manual Override'
      healthy = Boolean(this.manualToken)
    } else if (this.mode === 'disabled') {
      activeProvider = 'Disabled'
      healthy = false
    }

    return {
      mode: this.mode,
      healthy,
      activeProvider,
      hasIntegrityToken: hasIntegrity,
      expiresAt: hasIntegrity ? (this.electronMinter.expiresAt || null) : null,
      mintedCount: this.mintedCount,
      lastMintedAt: this.lastMintedAt,
      lastError: this.mode === 'disabled' ? null : (this.lastError ?? this.electronMinter.lastError)
    }
  }

  async testMint(videoId = 'dQw4w9WgXcQ'): Promise<{
    token: string
    source: string
    durationMs: number
  }> {
    const start = Date.now()
    this.tokenCache.delete(videoId)
    const token = (await this.getTokenForVideo(videoId)) ?? ''
    const entry = this.tokenCache.get(videoId)
    return {
      token,
      source: entry?.source ?? 'unknown',
      durationMs: Date.now() - start
    }
  }

  destroy(): void {
    this.electronMinter.destroy()
    this.tokenCache.clear()
  }
}

export const poTokenService = new PoTokenService()
