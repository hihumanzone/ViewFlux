/**
 * Silence-skipping gate for the `<video>` element's audio.
 *
 * Implements the detection logic, thresholds, and audio processing from ExoPlayer
 * and AndroidX Media3's `SilenceSkippingAudioProcessor` (the engine used by NewPipe
 * and LibreTube Android).
 *
 * Key parameters ported directly from ExoPlayer / Media3:
 *  - DEFAULT_SILENCE_THRESHOLD_LEVEL = 1024 (16-bit PCM) -> 1024 / 32768 = 0.03125
 *    (~ -30.1 dBFS).
 *  - DEFAULT_MINIMUM_SILENCE_DURATION_US = 150_000 (150 ms): sustained silence must
 *    persist for at least 150 ms before being classified as skippable silence. Natural
 *    speech pauses between words (< 150 ms) are passed through 100% untouched.
 *  - DEFAULT_PADDING_SILENCE_US = 25_000 (25 ms): audio padding preserved before and
 *    after each skipped segment. Word endings and beginnings have complete trailing/leading
 *    padding with smooth cosine fade transitions, preventing clipped speech onsets.
 *  - DEFAULT_MIN_VOLUME_TO_KEEP_PERCENTAGE = 10 (10% volume, -20 dB): kept during
 *    the fast-forwarded silence to maintain realistic room presence rather than
 *    abrupt digital silence.
 *  - Lookahead ring buffer + gain buffer: introduces a fixed 50 ms FIFO delay line
 *    (25 ms padding + 25 ms IPC & resampler settle time).
 *    When speech resumes at the input:
 *      1. The main thread is signaled IMMEDIATELY to restore normal 1.0x playback rate.
 *      2. A smooth cosine S-curve fade-in is retroactively applied across the 25 ms
 *         padding window preceding the speech onset.
 *      3. When the speech exits the buffer, volume has already smoothly ramped to 100%
 *         and media playback is already back to normal rate.
 *    This completely eliminates clipped word onsets, volume jumps, and resampler clicks.
 */

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const MEDIA3_SILENCE_THRESHOLD = 1024 / 32768; // 0.03125 (~ -30.1 dBFS)
const MEDIA3_MIN_VOLUME_PERCENT = 10; // DEFAULT_MIN_VOLUME_TO_KEEP_PERCENTAGE
const MIN_SILENCE_SECONDS = 0.15; // DEFAULT_MINIMUM_SILENCE_DURATION_US = 150 ms
const PADDING_SECONDS = 0.025; // 25 ms audio padding window
const LEAD_MARGIN_SECONDS = 0.025; // 25 ms lead time for main thread IPC & decoder settle

const STATE_NOISY = 0;       // Audio active / speech playing. Gain = 1.0.
const STATE_FADING_OUT = 1;  // Silence confirmed (> 150ms). Fading 100% -> 10% over padding.
const STATE_SILENT = 2;      // Sustained silence. Gain = 10%, video fast-forwarding.

/** Smooth S-curve (cosine) fade out from 1.0 down to minGain. */
function fadeOutGain(pos, len, minGain) {
  if (pos <= 0) return 1.0;
  if (pos >= len) return minGain;
  const ratio = 0.5 * (1 + Math.cos((Math.PI * pos) / len)); // 1.0 -> 0.0
  return minGain + (1 - minGain) * ratio;
}

/** Smooth S-curve (cosine) fade in from minGain up to 1.0. */
function fadeInGain(pos, len, minGain) {
  if (pos <= 0) return minGain;
  if (pos >= len) return 1.0;
  const ratio = 0.5 * (1 - Math.cos((Math.PI * pos) / len)); // 0.0 -> 1.0
  return minGain + (1 - minGain) * ratio;
}

class SilenceSkippingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.threshold = typeof opts.threshold === 'number' ? opts.threshold : MEDIA3_SILENCE_THRESHOLD;
    this.enabled = opts.enabled === true;
    this.minGain = MEDIA3_MIN_VOLUME_PERCENT / 100;

    const sr = typeof sampleRate === 'number' ? sampleRate : 48000;
    this.minSilenceFrames = Math.max(1, Math.round(sr * MIN_SILENCE_SECONDS));
    this.paddingFrames = Math.max(1, Math.round(sr * PADDING_SECONDS));
    this.delayFrames = Math.max(1, Math.round(sr * (PADDING_SECONDS + LEAD_MARGIN_SECONDS)));

    // Ring buffer capacity (power of 2 >= delayFrames + 1024)
    this.bufferCapacity = 16384;
    this.bufferMask = this.bufferCapacity - 1;
    this.bufferChannels = 0;
    this.ringBuffers = [];
    this.gainRingBuffer = new Float32Array(this.bufferCapacity);
    this.gainRingBuffer.fill(1.0);
    this.writePos = 0;

    // Highpass DC-blocking filter state to ignore DC offset and low-frequency rumble in detector
    this.dcPrevIn = new Float32Array(2);
    this.dcPrevOut = new Float32Array(2);

    this.state = STATE_NOISY;
    this.silenceFrames = 0;
    this.fadePos = 0;
    this.boosting = false;

    this.initBuffers(2);
    this.port.onmessage = (event) => this.onMessage(event && event.data);
  }

  initBuffers(channelCount) {
    this.ringBuffers = [];
    for (let c = 0; c < channelCount; c++) {
      this.ringBuffers.push(new Float32Array(this.bufferCapacity));
    }
    this.bufferChannels = channelCount;
    this.writePos = 0;
    this.dcPrevIn = new Float32Array(channelCount);
    this.dcPrevOut = new Float32Array(channelCount);
  }

  onMessage(message) {
    if (!message) return;
    if (message.type === 'enabled') {
      const next = !!message.value;
      if (next !== this.enabled) {
        this.enabled = next;
        this.reset();
      }
    } else if (message.type === 'flush') {
      this.reset();
    }
  }

  reset() {
    const wasBoosting = this.boosting;

    this.state = STATE_NOISY;
    this.silenceFrames = 0;
    this.fadePos = 0;
    this.boosting = false;

    for (let c = 0; c < this.ringBuffers.length; c++) {
      this.ringBuffers[c].fill(0);
    }
    this.gainRingBuffer.fill(1.0);
    this.writePos = 0;
    this.dcPrevIn.fill(0);
    this.dcPrevOut.fill(0);

    if (wasBoosting) this.post('boost', false);
  }

  post(type, value) {
    this.port.postMessage({ type, value });
  }

  setBoosting(on) {
    if (this.boosting === on) return;
    this.boosting = on;
    this.post('boost', on);
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const input = inputs[0];
    const frames = output[0].length;
    const channels = output.length;

    if (!input || input.length === 0) {
      for (let c = 0; c < channels; c++) output[c].fill(0);
      if (this.boosting) this.reset();
      return true;
    }

    if (!this.enabled) {
      // Pure pass-through when disabled
      for (let c = 0; c < channels; c++) {
        const src = c < input.length ? input[c] : input[0];
        output[c].set(src);
      }
      if (this.boosting) this.reset();
      return true;
    }

    if (this.bufferChannels < channels) {
      this.initBuffers(channels);
    }

    const minGain = this.minGain;
    const threshold = this.threshold;
    const paddingFrames = this.paddingFrames;
    const minSilenceFrames = this.minSilenceFrames;
    const delayFrames = this.delayFrames;
    const bufferCapacity = this.bufferCapacity;
    const bufferMask = this.bufferMask;
    const ringBuffers = this.ringBuffers;
    const gainRingBuffer = this.gainRingBuffer;

    for (let i = 0; i < frames; i++) {
      // 1. Write incoming sample to ring buffer and detect noise with DC blocker
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        const src = c < input.length ? input[c] : input[0];
        const rawSample = src[i];
        ringBuffers[c][this.writePos] = rawSample;

        // High-pass filter (cutoff ~35Hz) for noise detector to eliminate DC offset and sub-rumble
        const filtered = rawSample - this.dcPrevIn[c] + 0.995 * this.dcPrevOut[c];
        this.dcPrevIn[c] = rawSample;
        this.dcPrevOut[c] = filtered;

        const mag = Math.abs(filtered);
        if (mag > peak) peak = mag;
      }

      // Detection with hysteresis: in silent or fade-out state, use higher sensitivity (0.65x threshold)
      // to capture soft acoustic onsets (plosives, whispers, breaths, consonants) before they build amplitude.
      const isNoisy = (this.state === STATE_SILENT || this.state === STATE_FADING_OUT)
        ? peak > threshold * 0.65
        : peak > threshold;

      // 2. State machine (ExoPlayer SilenceSkippingAudioProcessor logic)
      if (this.state === STATE_NOISY) {
        if (isNoisy) {
          this.silenceFrames = 0;
        } else {
          this.silenceFrames++;
          if (this.silenceFrames >= minSilenceFrames) {
            // Sustained silence confirmed (> 150 ms): begin smooth fade-out over padding window
            this.state = STATE_FADING_OUT;
            this.fadePos = 0;
          }
        }
        gainRingBuffer[this.writePos] = 1.0;
      } else if (this.state === STATE_FADING_OUT) {
        if (isNoisy) {
          // Speech returned during fade-out: smoothly ramp the interrupted fade back to 1.0
          this.state = STATE_NOISY;
          this.silenceFrames = 0;
          const restoreLen = Math.min(this.fadePos, paddingFrames);
          for (let k = 0; k < restoreLen; k++) {
            const idx = (this.writePos - restoreLen + k + bufferCapacity) & bufferMask;
            gainRingBuffer[idx] = fadeInGain(k, restoreLen, gainRingBuffer[idx]);
          }
          gainRingBuffer[this.writePos] = 1.0;
        } else {
          this.fadePos++;
          gainRingBuffer[this.writePos] = fadeOutGain(this.fadePos, paddingFrames, minGain);
          if (this.fadePos >= paddingFrames) {
            // Fade-out complete: gate closed, enter sustained silence & fast-forward
            this.state = STATE_SILENT;
            this.setBoosting(true);
          }
        }
      } else if (this.state === STATE_SILENT) {
        if (isNoisy) {
          // SPEECH ONSET DETECTED!
          // 1. Immediately notify main thread to restore 1.0x playback rate.
          //    Because the speech is delayed by delayFrames (50 ms), the video element
          //    and Chromium's WSOLA resampler settle back to normal speed well before
          //    the speech audio exits the buffer.
          this.setBoosting(false);
          this.state = STATE_NOISY;
          this.silenceFrames = 0;

          // 2. Retroactively apply smooth cosine fade-in over the padding window
          //    immediately preceding this speech onset. This preserves 100% of the soft
          //    consonant/acoustic attack and ramps in naturally with ZERO abrupt volume jumps.
          for (let k = 0; k < paddingFrames; k++) {
            const idx = (this.writePos - paddingFrames + k + bufferCapacity) & bufferMask;
            gainRingBuffer[idx] = fadeInGain(k, paddingFrames, minGain);
          }
          gainRingBuffer[this.writePos] = 1.0;
        } else {
          gainRingBuffer[this.writePos] = minGain;
        }
      }

      // 3. Read delayed sample from lookahead buffer and apply its gain
      const readPos = (this.writePos - delayFrames + bufferCapacity) & bufferMask;
      const gain = gainRingBuffer[readPos];
      for (let c = 0; c < channels; c++) {
        output[c][i] = ringBuffers[c][readPos] * gain;
      }

      this.writePos = (this.writePos + 1) & bufferMask;
    }

    return true;
  }
}

registerProcessor('silence-skipping-processor', SilenceSkippingProcessor);
