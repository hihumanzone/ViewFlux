import { BrowserWindow } from 'electron'
import type { BotGuardChallenge, PoMinter } from './types'
import { emitPlayerDebugLog } from '../../debugLogger'

const WAA_REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo'
const WAA_GENERATE_IT_URL = 'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT'
const GOOGLE_API_KEY = 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw'

export class ElectronPoMinter implements PoMinter {
  private window: BrowserWindow | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private initPromise: Promise<boolean> | null = null
  private _expiresAt = 0
  private _isHealthy = false
  private _lastError: string | null = null

  get expiresAt(): number {
    return this._expiresAt
  }

  get isHealthy(): boolean {
    return this._isHealthy && Date.now() < this._expiresAt
  }

  get lastError(): string | null {
    return this._lastError
  }

  /**
   * Initializes or returns the existing offscreen background window.
   */
  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }

    const win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      skipTaskbar: true,
      focusable: false,
      title: 'ViewFlux BotGuard Runtime',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: false, // Required for executing script within window scope
        sandbox: false,
        backgroundThrottling: false
      }
    })

    // Load lightweight origin on youtube.com without pulling heavy front-page bundles
    try {
      await win.loadURL('https://www.youtube.com/robots.txt')
    } catch {
      // Aborts/redirects on robots.txt still establish the youtube.com origin
    }

    this.window = win
    return win
  }

  /**
   * Warms up and initializes the BotGuard minter with a fresh challenge.
   */
  async initialize(
    getChallenge: () => Promise<BotGuardChallenge>,
    force = false
  ): Promise<boolean> {
    if (!force && this.isHealthy) return true
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      this._lastError = null

      emitPlayerDebugLog({
        level: 'info',
        subsystem: 'POTOKEN',
        action: 'MINTER_INIT_START',
        message: 'Initializing native Electron BotGuard minter runtime',
        trigger: 'PoTokenService startup or refresh'
      })

      try {
        const win = await this.ensureWindow()
        const challenge = await getChallenge()

        const scriptUrl = challenge.interpreterUrl.startsWith('http')
          ? challenge.interpreterUrl
          : `https:${challenge.interpreterUrl}`

        const scriptRes = await fetch(scriptUrl, {
          signal: AbortSignal.timeout(10_000)
        })
        if (!scriptRes.ok) {
          throw new Error(`Failed to fetch BotGuard interpreter script: HTTP ${scriptRes.status}`)
        }
        const interpreterJs = await scriptRes.text()

        const payload = {
          interpreterJs,
          globalName: challenge.globalName,
          program: challenge.program,
          requestKey: WAA_REQUEST_KEY,
          generateItUrl: WAA_GENERATE_IT_URL,
          apiKey: GOOGLE_API_KEY
        }

        const setupResult = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              const p = ${JSON.stringify(payload)};
              
              // Execute the interpreter script to expose the global VM
              new Function(p.interpreterJs)();
              
              const vm = window[p.globalName];
              if (!vm || typeof vm.a !== 'function') {
                return { error: 'BotGuard VM or vm.a function not found on window' };
              }
              
              // Run the VM program
              const ret = await vm.a(
                p.program,
                () => {},
                true,
                undefined,
                () => {},
                [[], []],
                undefined,
                false,
                [() => {}, () => {}, () => {}, () => {}, () => {}]
              );
              
              if (!ret || typeof ret[0] !== 'function') {
                return { error: 'BotGuard snapshot function not returned by VM' };
              }
              
              const snapshotFn = ret[0];
              const webPoSignalOutput = [];
              const botguardResponse = await snapshotFn([
                undefined,
                undefined,
                webPoSignalOutput,
                undefined
              ]);
              
              if (!botguardResponse || typeof botguardResponse !== 'string') {
                return { error: 'Failed to generate BotGuard snapshot string' };
              }
              
              // Request integrity token from Google WAA
              const itRes = await fetch(p.generateItUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json+protobuf',
                  'x-goog-api-key': p.apiKey,
                  'x-user-agent': 'grpc-web-javascript/0.1'
                },
                body: JSON.stringify([p.requestKey, botguardResponse])
              });
              
              if (!itRes.ok) {
                return { error: 'WAA GenerateIT request failed with status ' + itRes.status };
              }
              
              const itJson = await itRes.json();
              const integrityToken = itJson[0];
              const ttlSecs = typeof itJson[1] === 'number' ? itJson[1] : 43200;
              
              if (!integrityToken) {
                return { error: 'No integrityToken returned in WAA response' };
              }
              
              // Decode base64 integrity token to Uint8Array bytes
              const binStr = atob(integrityToken);
              const itBytes = new Uint8Array(binStr.length);
              for (let i = 0; i < binStr.length; i++) {
                itBytes[i] = binStr.charCodeAt(i);
              }
              
              // Obtain the minter callback from the signal output
              const getMinter = webPoSignalOutput[0];
              if (typeof getMinter !== 'function') {
                return { error: 'getMinter is not a function in webPoSignalOutput' };
              }
              
              const mintCallback = await getMinter(itBytes);
              if (typeof mintCallback !== 'function') {
                return { error: 'mintCallback is not a function' };
              }
              
              // Store mintCallback globally on window for fast subsequent calls
              window.__viewflux_mint = mintCallback;
              
              return {
                success: true,
                ttlSecs
              };
            } catch (err) {
              return { error: err.message || String(err) };
            }
          })()
        `)

        if (!setupResult?.success) {
          throw new Error(setupResult?.error ?? 'Unknown error initializing BotGuard in Chromium')
        }

        const ttlMs = (setupResult.ttlSecs ?? 43200) * 1000
        this._expiresAt = Date.now() + ttlMs
        this._isHealthy = true

        emitPlayerDebugLog({
          level: 'info',
          subsystem: 'POTOKEN',
          action: 'MINTER_INIT_SUCCESS',
          message: `BotGuard minter initialized successfully (TTL: ${Math.round(ttlMs / 3600000)}h)`,
          data: { expiresAt: new Date(this._expiresAt).toISOString() }
        })

        // Schedule proactive refresh 2 hours before expiration (or halfway if TTL < 4h)
        const refreshDelay = Math.max(60_000, ttlMs - 2 * 3600 * 1000)
        if (this.refreshTimer) clearTimeout(this.refreshTimer)
        this.refreshTimer = setTimeout(() => {
          void this.initialize(getChallenge, true)
        }, refreshDelay)
        this.refreshTimer.unref?.()

        return true
      } catch (err) {
        const msg = (err as Error).message
        this._lastError = msg
        this._isHealthy = false
        emitPlayerDebugLog({
          level: 'error',
          subsystem: 'POTOKEN',
          action: 'MINTER_INIT_ERROR',
          message: `Failed to initialize BotGuard minter: ${msg}`,
          rawError: (err as Error).stack ?? String(err)
        })
        return false
      } finally {
        this.initPromise = null
      }
    })()

    return this.initPromise
  }

  /**
   * Mints a video-bound PO token for the given video ID in sub-millisecond execution.
   */
  async mint(contentBinding: string): Promise<string> {
    if (!this.window || this.window.isDestroyed() || !this.isHealthy) {
      throw new Error('BotGuard minter is not ready')
    }

    try {
      const script = `
        (async () => {
          if (typeof window.__viewflux_mint !== 'function') {
            throw new Error('mintCallback not available on window');
          }
          const vidBytes = new TextEncoder().encode(${JSON.stringify(contentBinding)});
          const mintedBytes = await window.__viewflux_mint(vidBytes);
          
          let binary = '';
          const chunk = 8192;
          for (let i = 0; i < mintedBytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, mintedBytes.subarray(i, i + chunk));
          }
          return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
        })()
      `

      const token = (await this.window.webContents.executeJavaScript(script)) as string
      if (!token || typeof token !== 'string') {
        throw new Error('Invalid token returned by minter')
      }
      return token
    } catch (err) {
      if (this.window?.isDestroyed() || this.window?.webContents?.isCrashed?.()) {
        this._isHealthy = false
        this.window = null
      }
      throw err
    }
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
      this.window = null
    }
    this._isHealthy = false
  }
}
