import type { Innertube } from 'youtubei.js'
import { poTokenService } from './pot'

/**
 * We use YouTube's internal VISIONOS client as our primary desktop client profile,
 * combined with Proof of Origin (PO) Token support for guaranteed playback integrity.
 *
 * `retrieve_player: true` downloads the player JS so youtubei.js can decipher
 * the `n`/`sig` parameters on stream URLs.
 * The interpreter runs through `Platform.shim.eval` below (plain Function in
 * the main process — no extra dependencies).
 */
export const CLIENT = 'VISIONOS' as const

let ytInstance: Innertube | null = null
let initPromise: Promise<Innertube> | null = null

export async function resetClient(): Promise<void> {
  ytInstance = null
  initPromise = null
}

export async function getClient(): Promise<Innertube> {
  if (ytInstance) return ytInstance
  if (!initPromise) {
    initPromise = (async () => {
      const { Innertube, Log, Parser, Platform } = await import('youtubei.js')
      Log.setLevel(Log.Level.NONE)
      // youtubei.js hands every unparseable node to a global reporter that
      // interpolates `packageInfo.bugs.url` into its "please report this"
      // text. electron-builder rewrites a dependency's package.json when it
      // packs it into app.asar and drops `bugs`, so in an installed build
      // `packageInfo.bugs` is undefined and the reporter itself throws
      // `TypeError: Cannot read properties of undefined (reading 'url')`.
      // That escapes the try/catch wrapping the node parse, so one unknown
      // renderer (which mixed "All" search surfaces constantly) took down the
      // whole request — packaged builds only, since `npm run dev` reads the
      // intact package.json off disk. `parseItem` already drops nodes it
      // cannot build, so a silent reporter restores the dev behaviour.
      Parser.setParserErrorHandler(() => {})
      // Lets youtubei.js execute YouTube's decipher function (base.js) in
      // the main process. `data.output` is a function body ending with
      // `return process(...)`, so wrapping it in `new Function` and calling
      // it yields the deciphered `{ sig, n }` object.
      Platform.shim.eval = (async (data: { output: string }) =>
        new Function(data.output)()) as typeof Platform.shim.eval

      const sessionToken = (await poTokenService.getSessionToken()) ?? undefined
      const visitorData = poTokenService.getVisitorData() ?? undefined

      const yt = await Innertube.create({
        retrieve_player: true,
        lang: 'en',
        location: 'US',
        po_token: sessionToken,
        visitor_data: visitorData
      })

      // Wire challenge fetcher so PoTokenService can request attestation challenges
      poTokenService.setChallengeFetcher(async () => {
        const challenge = await yt.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND')
        if (!challenge.bg_challenge) {
          throw new Error('No bg_challenge in attestation response')
        }
        const bg = challenge.bg_challenge as {
          interpreter_url?: { private_do_not_access_or_else_trusted_resource_url_wrapped_value?: string }
          interpreter_hash?: string
          program?: string
          global_name?: string
          client_experiments_state_blob?: unknown
        }
        const interpreterUrl = bg.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value
        if (!interpreterUrl) {
          throw new Error('No interpreter_url in bg_challenge')
        }
        return {
          interpreterUrl,
          interpreterHash: bg.interpreter_hash ?? '',
          program: bg.program ?? '',
          globalName: bg.global_name ?? '',
          clientExperimentsStateBlob: typeof bg.client_experiments_state_blob === 'string'
            ? bg.client_experiments_state_blob
            : JSON.stringify(bg.client_experiments_state_blob)
        }
      })

      ytInstance = yt
      return yt
    })().catch((err) => {
      initPromise = null
      throw err
    })
  }
  return initPromise
}
