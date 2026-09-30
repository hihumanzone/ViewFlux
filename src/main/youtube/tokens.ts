import { randomUUID } from 'node:crypto'
import type { ContinuationEntry } from './types'

export class TokenStore {
  private readonly continuations = new Map<string, ContinuationEntry>()

  set(entry: ContinuationEntry): string {
    const token = randomUUID()
    this.continuations.set(token, entry)
    this.prune()
    return token
  }

  get(token: string): ContinuationEntry | undefined {
    return this.continuations.get(token)
  }

  delete(token: string): boolean {
    return this.continuations.delete(token)
  }

  private prune(): void {
    while (this.continuations.size > 60) {
      const first = this.continuations.keys().next().value
      if (!first) break
      this.continuations.delete(first)
    }
  }
}

export function pruneMap<K, V>(map: Map<K, V>, max = 100): void {
  while (map.size > max) {
    const first = map.keys().next().value
    if (!first) break
    map.delete(first)
  }
}
