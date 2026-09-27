/**
 * Main-thread bridge for the silence-skipping feature.
 *
 * `public/silence-skipping-worklet.js` ports ExoPlayer and AndroidX Media3's
 * `SilenceSkippingAudioProcessor` (the engine used by NewPipe and LibreTube Android).
 *
 * It uses:
 *  - 1024 / 32768 (~ -30.1 dBFS) silence threshold level.
 *  - 150 ms minimum silence duration before activation (inter-word pauses are untouched).
 *  - 25 ms lead-in and lead-out audio padding across skipped segments with cosine S-curve fades.
 *  - 10% soft room presence volume retention during silence.
 *  - A 50 ms lookahead ring buffer delay line in the worklet thread, which signals the
 *    main thread to restore normal playback rate BEFORE speech exits the buffer and
 *    retroactively applies the 25 ms padding fade-in, eliminating cut-off words,
 *    volume jumps, and buffering/resampler artifacts.
 */

/** Default speed factor applied to media during sustained silence. */
export const SILENCE_SKIP_MULTIPLIER = 2.25

const WORKLET_FILE = 'silence-skipping-worklet.js'
const PROCESSOR_NAME = 'silence-skipping-processor'

export type SilenceSkipperOptions = {
  /** Safe moment to speed the media element up / restore normal rate. */
  onBoostChange: (boost: boolean) => void
  /** Optional callback if silence skipping state changes. */
  onSkippingChange?: (skipping: boolean) => void
}

export type SilenceSkipper = {
  readonly node: AudioWorkletNode
  setEnabled: (enabled: boolean) => void
  /** Drops the detector and delay-line state, e.g. after a seek or a buffering stall. */
  flush: () => void
  dispose: () => void
}

/**
 * Registers the worklet module on `ctx` and creates the node.
 *
 * The module is loaded from `document.baseURI` to comply with CSP and same-origin rules
 * in Electron production (`file://`) and Vite development modes.
 */
export async function createSilenceSkipper(
  ctx: AudioContext,
  options: SilenceSkipperOptions
): Promise<SilenceSkipper | null> {
  let node: AudioWorkletNode
  try {
    await ctx.audioWorklet.addModule(new URL(WORKLET_FILE, document.baseURI).href)
    node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2]
    })
  } catch (err) {
    console.warn('[silence-skip] AudioWorklet unavailable, skip-silence disabled', err)
    return null
  }

  let enabled = false
  node.port.onmessage = (event: MessageEvent<{ type?: string; value?: boolean }>) => {
    const data = event.data
    if (!data) return
    if (data.type === 'boost') options.onBoostChange(data.value === true)
    else if (data.type === 'skipping') options.onSkippingChange?.(data.value === true)
  }

  return {
    node,
    setEnabled(next: boolean) {
      if (next === enabled) return
      enabled = next
      node.port.postMessage({ type: 'enabled', value: next })
    },
    flush() {
      node.port.postMessage({ type: 'flush' })
    },
    dispose() {
      enabled = false
      node.port.onmessage = null
      try {
        node.disconnect()
      } catch {
        // Already detached along with a torn-down AudioContext.
      }
    }
  }
}
