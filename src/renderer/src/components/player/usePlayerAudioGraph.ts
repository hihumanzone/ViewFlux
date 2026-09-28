import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SILENCE_SKIP_MULTIPLIER,
  createSilenceSkipper,
  type SilenceSkipper
} from '../../lib/silenceSkipper'
import { clampVolume } from './types'
import { PLAYBACK_SPEEDS as SPEEDS } from '../../../../shared/media'

export interface UsePlayerAudioGraphProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  isLive?: boolean
  initialVolume: number
  initialSpeed: number
  preservePitch: boolean
  skipSilence: boolean
  playing: boolean
  status: 'loading' | 'ready' | 'error'
  onPitchChange: (value: boolean) => void
  onSkipSilenceChange: (value: boolean) => void
  onOsd?: (text: string, icon?: string) => void
}

export function usePlayerAudioGraph({
  videoRef,
  isLive = false,
  initialVolume,
  initialSpeed,
  preservePitch,
  skipSilence,
  playing,
  status,
  onPitchChange,
  onSkipSilenceChange,
  onOsd
}: UsePlayerAudioGraphProps) {
  const safeInitialSpeed = Number.isFinite(initialSpeed) && initialSpeed >= 0.25 ? initialSpeed : 1

  const [volume, setVolume] = useState(initialVolume)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(safeInitialSpeed)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const limiterRef = useRef<DynamicsCompressorNode | null>(null)
  const skipperRef = useRef<SilenceSkipper | null>(null)
  const skipperPendingRef = useRef(false)
  const skipperEnabledRef = useRef(false)
  const boostRef = useRef(false)
  const rateRef = useRef(safeInitialSpeed)
  const pitchRef = useRef(preservePitch)
  pitchRef.current = preservePitch
  const volumeRef = useRef(volume)
  volumeRef.current = volume
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  rateRef.current = Number.isFinite(rate) && rate >= 0.25 ? rate : 1

  // Keep rate synchronized if initialSpeed changes
  useEffect(() => {
    if (Number.isFinite(initialSpeed) && initialSpeed >= 0.25) {
      setRate(initialSpeed)
      rateRef.current = initialSpeed
    }
  }, [initialSpeed])

  const boostTarget = (): number => {
    const baseRate = Number.isFinite(rateRef.current) && rateRef.current >= 0.25 ? rateRef.current : 1
    return Math.min(3.5, Math.max(2.25, baseRate * SILENCE_SKIP_MULTIPLIER))
  }

  const setBoost = useCallback((on: boolean) => {
    const video = videoRef.current
    if (!video) return
    boostRef.current = on
    const baseRate = Number.isFinite(rateRef.current) && rateRef.current >= 0.25 ? rateRef.current : 1
    if (on) {
      // Only speed up if video is currently playing and not seeking
      if (!video.paused && !video.seeking) {
        const target = boostTarget()
        if (Math.abs(video.playbackRate - target) > 0.01) {
          video.playbackRate = target
        }
      }
    } else {
      if (Math.abs(video.playbackRate - baseRate) > 0.01) {
        video.playbackRate = baseRate
      }
    }
  }, [])

  const endBoost = useCallback(() => {
    const wasBoosting = boostRef.current
    boostRef.current = false
    const video = videoRef.current
    const baseRate = Number.isFinite(rateRef.current) && rateRef.current >= 0.25 ? rateRef.current : 1
    if (video && wasBoosting && Math.abs(video.playbackRate - baseRate) > 0.01) {
      video.playbackRate = baseRate
    }
  }, [])

  // Listen to seeking, waiting, stalling, and pausing to immediately flush the skipper
  // delay line and restore normal playback rate so no stale pops or jumps occur.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleInterrupt = (): void => {
      endBoost()
      skipperRef.current?.flush()
    }

    video.addEventListener('seeking', handleInterrupt)
    video.addEventListener('seeked', handleInterrupt)
    video.addEventListener('waiting', handleInterrupt)
    video.addEventListener('pause', handleInterrupt)
    video.addEventListener('stalled', handleInterrupt)

    return () => {
      video.removeEventListener('seeking', handleInterrupt)
      video.removeEventListener('seeked', handleInterrupt)
      video.removeEventListener('waiting', handleInterrupt)
      video.removeEventListener('pause', handleInterrupt)
      video.removeEventListener('stalled', handleInterrupt)
    }
  }, [videoRef, endBoost])

  // Initialize Web Audio graph
  const initAudioGraph = useCallback(() => {
    const video = videoRef.current
    if (!video) return null
    if (audioCtxRef.current && gainNodeRef.current) {
      if (audioCtxRef.current.state === 'suspended') {
        void audioCtxRef.current.resume().catch(() => undefined)
      }
      return audioCtxRef.current
    }

    try {
      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioCtor) return null

      const ctx = new AudioCtor()
      audioCtxRef.current = ctx

      const source = ctx.createMediaElementSource(video)
      sourceNodeRef.current = source

      const gain = ctx.createGain()
      gain.gain.value = mutedRef.current ? 0 : volumeRef.current
      gainNodeRef.current = gain

      // DynamicsCompressor acts as a brickwall limiter to ensure 300% volume sounds clean
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.setValueAtTime(-1.0, ctx.currentTime)
      limiter.knee.setValueAtTime(0, ctx.currentTime)
      limiter.ratio.setValueAtTime(20, ctx.currentTime)
      limiter.attack.setValueAtTime(0.003, ctx.currentTime)
      limiter.release.setValueAtTime(0.1, ctx.currentTime)
      limiterRef.current = limiter

      source.connect(gain)
      gain.connect(limiter)
      limiter.connect(ctx.destination)

      video.volume = 1
      video.muted = false

      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined)
      }

      if (!skipperPendingRef.current) {
        skipperPendingRef.current = true
        void createSilenceSkipper(ctx, {
          onBoostChange: setBoost
        })
          .then((skipper) => {
            skipperPendingRef.current = false
            if (audioCtxRef.current !== ctx || !sourceNodeRef.current) {
              skipper?.dispose()
              return
            }
            if (!skipper) return
            skipperRef.current = skipper
            try {
              source.disconnect()
              source.connect(skipper.node)
              skipper.node.connect(gain)
            } catch {
              skipper.dispose()
              skipperRef.current = null
              return
            }
            skipper.setEnabled(skipperEnabledRef.current)
          })
          .catch(() => {
            skipperPendingRef.current = false
          })
      }

      return ctx
    } catch {
      return null
    }
  }, [setBoost, videoRef])

  useEffect(() => {
    if (status === 'ready') {
      initAudioGraph()
    }
  }, [status, initAudioGraph])

  // Silence skipping worklet toggling
  useEffect(() => {
    const wanted = !isLive && skipSilence && playing
    skipperEnabledRef.current = wanted
    if (wanted) {
      initAudioGraph()
    } else {
      endBoost()
    }
    const skipper = skipperRef.current
    if (!skipper) return
    skipper.setEnabled(wanted)
    skipper.flush()
  }, [isLive, skipSilence, playing, initAudioGraph, endBoost])

  // Volume control
  const changeVolume = useCallback(
    (next: number) => {
      const v = clampVolume(next)
      setVolume(v)
      const isMuted = v === 0
      setMuted(isMuted)
      const video = videoRef.current
      if (!video) return
      initAudioGraph()
      if (gainNodeRef.current && audioCtxRef.current) {
        gainNodeRef.current.gain.setValueAtTime(isMuted ? 0 : v, audioCtxRef.current.currentTime)
        video.volume = 1
        video.muted = false
      } else {
        video.volume = Math.min(1, v)
        video.muted = isMuted
      }
      const pct = Math.round(v * 100)
      onOsd?.(isMuted ? 'Muted' : `${pct}%`, isMuted ? 'volumeOff' : 'volume')
    },
    [initAudioGraph, onOsd, videoRef]
  )

  const toggleMute = useCallback(() => {
    const nextMuted = !muted
    setMuted(nextMuted)
    initAudioGraph()
    if (gainNodeRef.current && audioCtxRef.current) {
      gainNodeRef.current.gain.setValueAtTime(
        nextMuted ? 0 : (volume || 1),
        audioCtxRef.current.currentTime
      )
    } else if (videoRef.current) {
      videoRef.current.muted = nextMuted
    }
    onOsd?.(nextMuted ? 'Muted' : `${Math.round((volume || 1) * 100)}%`, nextMuted ? 'volumeOff' : 'volume')
  }, [muted, volume, initAudioGraph, onOsd, videoRef])

  // Speed control
  const changeRate = useCallback(
    (value: number) => {
      const video = videoRef.current
      const clamped = Number.isFinite(value) && value >= 0.25 ? Math.min(5, Math.max(0.25, value)) : 1
      rateRef.current = clamped
      setRate(clamped)
      if (!video) return
      if (boostRef.current) {
        setBoost(true)
      } else {
        video.playbackRate = clamped
      }
      onOsd?.(`${clamped === 1 ? 'Normal' : `${clamped.toFixed(2)}×`}`, 'speed')
    },
    [setBoost, onOsd, videoRef]
  )

  const stepSpeed = useCallback(
    (direction: -1 | 1) => {
      const currentRate = Number.isFinite(rate) && rate >= 0.25 ? rate : 1
      const currentIndex = SPEEDS.findIndex((s) => Math.abs(s - currentRate) < 0.01)
      if (currentIndex !== -1) {
        const nextIndex = Math.max(0, Math.min(SPEEDS.length - 1, currentIndex + direction))
        changeRate(SPEEDS[nextIndex])
      } else {
        const target =
          direction > 0
            ? SPEEDS.find((s) => s > currentRate) ?? 5
            : [...SPEEDS].reverse().find((s) => s < currentRate) ?? 0.25
        changeRate(target)
      }
    },
    [rate, changeRate]
  )

  const togglePitch = useCallback(() => {
    const next = !preservePitch
    pitchRef.current = next
    const video = videoRef.current
    if (video) video.preservesPitch = next
    onPitchChange(next)
    onOsd?.(`Preserve pitch: ${next ? 'On' : 'Off'}`, 'tune')
  }, [preservePitch, onPitchChange, onOsd, videoRef])

  const toggleSkipSilence = useCallback(() => {
    if (isLive) return
    const next = !skipSilence
    onSkipSilenceChange(next)
    onOsd?.(`Skip silence: ${next ? 'On' : 'Off'}`, 'tune')
  }, [isLive, skipSilence, onSkipSilenceChange, onOsd])

  const safeRate = Number.isFinite(rate) && rate >= 0.25 ? rate : safeInitialSpeed

  return {
    volume,
    muted,
    rate: safeRate,
    changeVolume,
    toggleMute,
    changeRate,
    stepSpeed,
    togglePitch,
    toggleSkipSilence
  }
}
