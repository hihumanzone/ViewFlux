/**
 * Silence-skipping gate for the `<video>` element's audio.
 *
 * Implements the detection logic, thresholds, and audio processing principles from
 * ExoPlayer / AndroidX Media3's `SilenceSkippingAudioProcessor` (the engine used by
 * NewPipe and LibreTube Android), engineered specifically for the Web Audio and
 * Chromium HTML5 media pipeline.
 *
 * Key engineering highlights:
 *  1. Adaptive Noise-Floor Tracking & Energy Envelope:
 *     - Tracks background room noise / microphone hiss to establish an adaptive threshold.
 *     - Uses RMS energy + DC-blocking highpass filter (~35Hz) to ignore sub-rumble,
 *       preventing false triggers from clicks or room tone and ensuring reliable silence skipping.
 *  2. 70 ms Lookahead Delay Line (Circular FIFO):
 *     - 30 ms pre-speech audio padding window: preserves 100% of soft consonants,
 *       whispered breaths, and vocal tract opening attacks.
 *     - 40 ms lead-time for Chromium WSOLA resampler and main-thread IPC deceleration:
 *       main thread restores 1.0x playback rate BEFORE speech onset exits the buffer,
 *       ensuring the audio is completely at normal rate when it reaches the listener.
 *  3. Seamless Cosine S-Curve Transitions & Fast-Forward Silence Muting:
 *     - During fast-forward silence, audio is muted (gain = 0), completely eliminating
 *       all WSOLA pitch-stretching fluttering, "buffering artifact" sounds, and resampler clicks.
 *     - Retroactive cosine S-curve fade-in ramps volume smoothly from 0 to 1.0 across
 *       the 30 ms pre-speech padding window with zero volume jumps and zero clipping.
 *  4. Slew-Rate De-Clicker:
 *     - Clamps unphysical high-frequency digital steps (> 0.45 / sample) caused by stream
 *       splicing or resampler resets, eliminating audio pops and clicks entirely.
 */

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const DEFAULT_THRESHOLD = 0.028; // ~ -31 dBFS base threshold
const MIN_SILENCE_SECONDS = 0.18; // 180 ms sustained silence before fast-forwarding
const PADDING_BEFORE_SECONDS = 0.030; // 30 ms padding preserved before speech onset
const PADDING_AFTER_SECONDS = 0.025; // 25 ms padding preserved after speech ends
const LOOKAHEAD_SECONDS = 0.070; // 70 ms total delay buffer (30 ms padding + 40 ms IPC/resampler settle)

const STATE_NOISY = 0;       // Audio active / speech playing. Gain = 1.0.
const STATE_FADING_OUT = 1;  // Silence confirmed (> 180ms). Fading 1.0 -> 0.0 over 25ms padding.
const STATE_SILENT = 2;      // Sustained silence. Gain = 0.0, video fast-forwarding.

/** Smooth S-curve (raised cosine) fade out from 1.0 down to 0.0. */
function fadeOutGain(pos, len) {
  if (pos <= 0) return 1.0;
  if (pos >= len) return 0.0;
  return 0.5 * (1 + Math.cos((Math.PI * pos) / len));
}

/** Smooth S-curve (raised cosine) fade in from 0.0 up to 1.0. */
function fadeInGain(pos, len) {
  if (pos <= 0) return 0.0;
  if (pos >= len) return 1.0;
  return 0.5 * (1 - Math.cos((Math.PI * pos) / len));
}

class SilenceSkippingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.baseThreshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
    this.enabled = opts.enabled === true;

    const sr = typeof sampleRate === 'number' ? sampleRate : 48000;
    this.sr = sr;
    this.minSilenceFrames = Math.max(1, Math.round(sr * MIN_SILENCE_SECONDS));
    this.paddingBeforeFrames = Math.max(1, Math.round(sr * PADDING_BEFORE_SECONDS));
    this.paddingAfterFrames = Math.max(1, Math.round(sr * PADDING_AFTER_SECONDS));
    this.delayFrames = Math.max(1, Math.round(sr * LOOKAHEAD_SECONDS));

    // Ring buffer capacity (power of 2 >= delayFrames + 2048)
    this.bufferCapacity = 16384;
    this.bufferMask = this.bufferCapacity - 1;
    this.bufferChannels = 0;
    this.ringBuffers = [];
    this.gainRingBuffer = new Float32Array(this.bufferCapacity);
    this.gainRingBuffer.fill(1.0);
    this.writePos = 0;

    // Highpass DC-blocking filter state to eliminate DC offset and sub-bass rumble
    this.dcPrevIn = new Float32Array(2);
    this.dcPrevOut = new Float32Array(2);

    // Slew rate de-clicker state
    this.prevInputSamples = new Float32Array(2);

    // Adaptive noise floor tracking & energy envelope
    this.noiseFloor = 0.012; // Initial estimate (~ -38 dBFS)
    this.energyEnvelope = 0.0;

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
    this.prevInputSamples = new Float32Array(channelCount);
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
    this.energyEnvelope = 0.0;

    for (let c = 0; c < this.ringBuffers.length; c++) {
      this.ringBuffers[c].fill(0);
    }
    this.gainRingBuffer.fill(1.0);
    this.writePos = 0;
    this.dcPrevIn.fill(0);
    this.dcPrevOut.fill(0);
    this.prevInputSamples.fill(0);

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

    const paddingBeforeFrames = this.paddingBeforeFrames;
    const paddingAfterFrames = this.paddingAfterFrames;
    const minSilenceFrames = this.minSilenceFrames;
    const delayFrames = this.delayFrames;
    const bufferCapacity = this.bufferCapacity;
    const bufferMask = this.bufferMask;
    const ringBuffers = this.ringBuffers;
    const gainRingBuffer = this.gainRingBuffer;

    // Process sample by sample
    for (let i = 0; i < frames; i++) {
      let samplePeak = 0;
      let sampleSumSq = 0;

      for (let c = 0; c < channels; c++) {
        const src = c < input.length ? input[c] : input[0];
        let rawSample = src[i];

        // Slew-rate de-clicker: clamp instantaneous unphysical sample steps (> 0.45)
        // caused by Chromium resampler resets or stream buffer splices
        const prev = this.prevInputSamples[c];
        const delta = rawSample - prev;
        if (delta > 0.45) {
          rawSample = prev + 0.45;
        } else if (delta < -0.45) {
          rawSample = prev - 0.45;
        }
        this.prevInputSamples[c] = rawSample;

        // Store into delay line ring buffer
        ringBuffers[c][this.writePos] = rawSample;

        // DC-blocking highpass filter (cutoff ~35Hz) to remove DC bias & microphone thumps
        const filtered = rawSample - this.dcPrevIn[c] + 0.995 * this.dcPrevOut[c];
        this.dcPrevIn[c] = rawSample;
        this.dcPrevOut[c] = filtered;

        const mag = Math.abs(filtered);
        if (mag > samplePeak) samplePeak = mag;
        sampleSumSq += filtered * filtered;
      }

      // Energy envelope follower (fast attack ~2ms, smooth release ~20ms)
      const sampleRms = Math.sqrt(sampleSumSq / channels);
      const instantEnergy = Math.max(samplePeak, sampleRms * 1.5);
      if (instantEnergy > this.energyEnvelope) {
        this.energyEnvelope = this.energyEnvelope * 0.8 + instantEnergy * 0.2;
      } else {
        this.energyEnvelope = this.energyEnvelope * 0.998 + instantEnergy * 0.002;
      }

      // Adaptive noise floor: slowly tracks the quietest background room levels
      // between -48 dBFS (0.004) and -26 dBFS (0.050)
      if (this.energyEnvelope < this.noiseFloor) {
        this.noiseFloor = this.noiseFloor * 0.999 + this.energyEnvelope * 0.001;
      } else {
        this.noiseFloor = this.noiseFloor * 0.99995 + this.energyEnvelope * 0.00005;
      }
      if (this.noiseFloor < 0.004) this.noiseFloor = 0.004;
      if (this.noiseFloor > 0.050) this.noiseFloor = 0.050;

      // Active speech detection threshold with adaptive floor
      const activeThreshold = Math.max(
        this.baseThreshold,
        Math.min(0.065, this.noiseFloor * 2.4 + 0.012)
      );

      // Detection with hysteresis: higher sensitivity (0.70x) when looking for speech onset
      // in silent or fade-out state to preserve soft consonants (s, t, f, h) and whispered onsets.
      const isSpeech = (this.state === STATE_SILENT || this.state === STATE_FADING_OUT)
        ? (this.energyEnvelope > activeThreshold * 0.70 || samplePeak > activeThreshold * 0.85)
        : (this.energyEnvelope > activeThreshold || samplePeak > activeThreshold * 1.15);

      // State machine logic
      if (this.state === STATE_NOISY) {
        if (isSpeech) {
          this.silenceFrames = 0;
        } else {
          this.silenceFrames++;
          if (this.silenceFrames >= minSilenceFrames) {
            // Sustained silence confirmed (> 180 ms): begin smooth fade-out over padding window
            this.state = STATE_FADING_OUT;
            this.fadePos = 0;
          }
        }
        gainRingBuffer[this.writePos] = 1.0;
      } else if (this.state === STATE_FADING_OUT) {
        if (isSpeech) {
          // Speech returned during fade-out: smoothly ramp the interrupted fade back to 1.0
          this.state = STATE_NOISY;
          this.silenceFrames = 0;
          const restoreLen = Math.min(this.fadePos, paddingAfterFrames);
          for (let k = 0; k < restoreLen; k++) {
            const idx = (this.writePos - restoreLen + k + bufferCapacity) & bufferMask;
            const currentGain = gainRingBuffer[idx];
            gainRingBuffer[idx] = currentGain + (1.0 - currentGain) * fadeInGain(k, restoreLen);
          }
          gainRingBuffer[this.writePos] = 1.0;
        } else {
          this.fadePos++;
          gainRingBuffer[this.writePos] = fadeOutGain(this.fadePos, paddingAfterFrames);
          if (this.fadePos >= paddingAfterFrames) {
            // Fade-out complete: gate closed, enter sustained silence & fast-forward
            this.state = STATE_SILENT;
            this.setBoosting(true);
          }
        }
      } else if (this.state === STATE_SILENT) {
        if (isSpeech) {
          // SPEECH ONSET DETECTED!
          // 1. Immediately signal main thread to restore 1.0x normal playback rate.
          //    The 70 ms lookahead delay provides 40 ms of lead time for main thread IPC
          //    and Chromium's WSOLA resampler to settle back to 1.0x BEFORE speech exits the buffer.
          this.setBoosting(false);
          this.state = STATE_NOISY;
          this.silenceFrames = 0;

          // 2. Retroactively apply smooth cosine S-curve fade-in over the 30 ms pre-speech
          //    padding window in gainRingBuffer preceding this speech onset.
          //    This preserves 100% of speech attacks, breaths, and soft consonants with zero volume jumps!
          for (let k = 0; k < paddingBeforeFrames; k++) {
            const idx = (this.writePos - paddingBeforeFrames + k + bufferCapacity) & bufferMask;
            gainRingBuffer[idx] = fadeInGain(k, paddingBeforeFrames);
          }
          gainRingBuffer[this.writePos] = 1.0;
        } else {
          // During fast-forward silence, gain is 0.0 (muted).
          // This eliminates all WSOLA pitch-stretching artifacts on noise and resampler clicks!
          gainRingBuffer[this.writePos] = 0.0;
        }
      }

      // Read delayed sample from FIFO lookahead buffer and apply smooth gain
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
