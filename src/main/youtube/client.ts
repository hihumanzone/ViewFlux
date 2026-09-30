import type { Innertube } from 'youtubei.js'

/**
 * We use YouTube's internal VISIONOS client. Unlike WEB it needs no PO-token /
 * BotGuard dance, and unlike IOS it does not restrict arbitrary HTTP Range
 * requests or seeking on googlevideo media URLs.
 *
 * `retrieve_player: true` downloads the player JS so youtubei.js can decipher
 * the `n`/`sig` parameters on stream URLs (the same approach NewPipe takes
 * with its JavaScript extractor and FreeTube takes via youtubei.js).
 * The interpreter runs through `Platform.shim.eval` below (plain Function in
 * the main process — no extra dependencies).
 */
export const CLIENT = 'VISIONOS' as const

let ytInstance: Innertube | null = null
let initPromise: Promise<Innertube> | null = null

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
      const yt = await Innertube.create({
        retrieve_player: true,
        lang: 'en',
        location: 'US'
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
