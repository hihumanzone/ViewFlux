export type PoTokenMode = 'auto' | 'external' | 'manual' | 'disabled'

export interface PoTokenOptions {
  mode: PoTokenMode
  externalUrl?: string
  manualToken?: string
  manualVisitorData?: string
}

export interface PoTokenStatus {
  mode: PoTokenMode
  healthy: boolean
  activeProvider: string
  hasIntegrityToken: boolean
  expiresAt: number | null
  mintedCount: number
  lastMintedAt: number | null
  lastError: string | null
}

export interface CachedPoToken {
  token: string
  source: 'botguard' | 'external' | 'manual' | 'coldstart'
  createdAt: number
  expiresAt: number
}

export interface BotGuardChallenge {
  interpreterUrl: string
  interpreterHash: string
  program: string
  globalName: string
  clientExperimentsStateBlob?: string
}

export interface PoMinter {
  mint(contentBinding: string): Promise<string>
  readonly expiresAt: number
  readonly isHealthy: boolean
}
