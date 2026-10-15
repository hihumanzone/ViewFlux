export interface ExternalPotResponse {
  po_token?: string
  poToken?: string
  token?: string
  error?: string
}

export class ExternalPoProvider {
  constructor(private readonly baseUrl: string = 'http://127.0.0.1:4416') {}

  get url(): string {
    return this.baseUrl.replace(/\/+$/, '')
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/ping`, {
        signal: AbortSignal.timeout(2000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  async getPoToken(contentBinding: string): Promise<string | null> {
    try {
      const endpoints = [
        `${this.url}/get_pot`,
        `${this.url}/token`,
        `${this.url}/`
      ]

      for (const endpoint of endpoints) {
        // 1. Try POST with JSON payload first
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              content_binding: contentBinding,
              video_id: contentBinding
            }),
            signal: AbortSignal.timeout(4000)
          })

          if (res.ok) {
            const data = (await res.json()) as ExternalPotResponse
            const token = data.po_token ?? data.poToken ?? data.token
            if (token && typeof token === 'string') {
              return token
            }
          }
        } catch {
          // Fall through to GET attempt
        }

        // 2. Try GET with query parameters (common in simple servers)
        try {
          const getUrl = new URL(endpoint)
          getUrl.searchParams.set('content_binding', contentBinding)
          getUrl.searchParams.set('video_id', contentBinding)

          const res = await fetch(getUrl.toString(), {
            method: 'GET',
            headers: {
              Accept: 'application/json'
            },
            signal: AbortSignal.timeout(4000)
          })

          if (res.ok) {
            const data = (await res.json()) as ExternalPotResponse
            const token = data.po_token ?? data.poToken ?? data.token
            if (token && typeof token === 'string') {
              return token
            }
          }
        } catch {
          // Try next endpoint
        }
      }
      return null
    } catch {
      return null
    }
  }
}
