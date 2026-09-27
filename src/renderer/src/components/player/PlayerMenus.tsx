import { memo } from 'react'
import { Menu, MenuItem } from '../Menu'
import { SliderField } from '../SliderField'
import { Switch } from '../Switch'
import { PLAYBACK_SPEEDS as SPEEDS } from '../../../../shared/media'
import type { AudioTrack, MenuKind, TextTrack } from './types'

export interface PlayerMenusProps {
  menu: MenuKind | null
  menuAnchor: HTMLElement | null
  onClose: () => void
  // Settings menu props
  rate: number
  onChangeRate: (rate: number) => void
  preservePitch: boolean
  onTogglePitch: () => void
  skipSilence: boolean
  onToggleSkipSilence: () => void
  // Quality menu props
  levelHeights: { height: number; bandwidth: number }[]
  selectedHeight: number | null
  selectedAudioTier: string | null
  onSelectStream: (height: number | null, audioTier: string | null) => void
  onSelectHeight: (height: number) => void
  // Captions menu props
  textTracks: TextTrack[]
  textVisible: boolean
  activeTextId: number | null
  onSelectCaption: (id: number | null) => void
  // Audio menu props
  audioTracks: AudioTrack[]
  audioLanguages: { code: string; label: string }[]
  selectedAudioLang: string | null
  audioTiers: readonly string[]
  isOriginalLanguage: (code: string) => boolean
  onSelectAudio: (code: string) => void
  onSelectAudioTier: (tier: string | null) => void
}

export const PlayerMenus = memo(function PlayerMenus({
  menu,
  menuAnchor,
  onClose,
  rate,
  onChangeRate,
  preservePitch,
  onTogglePitch,
  skipSilence,
  onToggleSkipSilence,
  levelHeights,
  selectedHeight,
  selectedAudioTier,
  onSelectStream,
  onSelectHeight,
  textTracks,
  textVisible,
  activeTextId,
  onSelectCaption,
  audioLanguages,
  selectedAudioLang,
  audioTiers,
  isOriginalLanguage,
  onSelectAudio,
  onSelectAudioTier
}: PlayerMenusProps): React.JSX.Element {
  return (
    <>
      {/* 1. Playback Settings Sheet */}
      <Menu
        anchor={menuAnchor}
        open={menu === 'settings'}
        onClose={onClose}
        align="end"
        gap={36}
        prefer="above"
        className="sheet"
      >
        <div className="sheet__title">Playback settings</div>

        <div className="sheet__row sheet__row--stack">
          <div className="sheet__row-head">
            <span className="sheet__label">Speed</span>
            <span className="sheet__value">
              {rate === 1 ? 'Normal' : `${rate.toFixed(2)}×`}
            </span>
          </div>
          <div className="speed-chips">
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={`speed-chips__chip${rate === s ? ' speed-chips__chip--active' : ''}`}
                onClick={() => onChangeRate(s)}
              >
                {s === 1 ? 'Normal' : `${s}×`}
              </button>
            ))}
          </div>
          <SliderField
            value={rate}
            min={0.25}
            max={5}
            step={0.05}
            precision={2}
            suffix="×"
            label="Playback speed"
            onChange={onChangeRate}
          />
        </div>

        <div className="sheet__row sheet__row--toggle">
          <div>
            <div className="sheet__label">Preserve pitch</div>
            <div className="sheet__hint">Keep audio pitch when changing speed.</div>
          </div>
          <Switch
            on={preservePitch}
            label="Preserve pitch"
            onClick={onTogglePitch}
          />
        </div>

        <div className="sheet__row sheet__row--toggle">
          <div>
            <div className="sheet__label">Skip silence</div>
            <div className="sheet__hint">Fast-forward through silent passages.</div>
          </div>
          <Switch
            on={skipSilence}
            label="Skip silence"
            onClick={onToggleSkipSilence}
          />
        </div>
      </Menu>

      {/* 2. Quality Menu */}
      <Menu
        anchor={menuAnchor}
        open={menu === 'quality'}
        onClose={onClose}
        align="end"
        gap={36}
        prefer="above"
        title="Quality"
        checkable
      >
        <MenuItem
          label="Auto"
          selected={selectedHeight == null && selectedAudioTier == null}
          onSelect={() => {
            onSelectStream(null, null)
            onClose()
          }}
        />
        {levelHeights.map((level) => (
          <MenuItem
            key={level.height}
            label={`${level.height}p`}
            selected={selectedHeight === level.height}
            onSelect={() => onSelectHeight(level.height)}
          />
        ))}
      </Menu>

      {/* 3. Subtitles / Captions Menu */}
      <Menu
        anchor={menuAnchor}
        open={menu === 'captions'}
        onClose={onClose}
        align="end"
        gap={36}
        prefer="above"
        title="Subtitles"
        checkable
      >
        <MenuItem
          label="Off"
          selected={!textVisible}
          onSelect={() => onSelectCaption(null)}
        />
        {textTracks.length === 0 ? (
          <div className="menu__item menu__item--empty">No subtitles available</div>
        ) : (
          textTracks.map((track, index) => (
            <MenuItem
              key={track.id ?? `${track.language}-${track.label}-${index}`}
              label={track.label || track.language}
              selected={textVisible && activeTextId === track.id}
              onSelect={() => onSelectCaption(track.id)}
            />
          ))
        )}
      </Menu>

      {/* 4. Audio Tracks Menu */}
      <Menu
        anchor={menuAnchor}
        open={menu === 'audio'}
        onClose={onClose}
        align="end"
        gap={36}
        prefer="above"
        title="Audio"
        checkable
      >
        {audioLanguages.map((entry) => (
          <MenuItem
            key={entry.code}
            label={entry.label}
            hint={
              isOriginalLanguage(entry.code) && audioLanguages.length > 1
                ? 'original'
                : undefined
            }
            selected={selectedAudioLang === entry.code}
            onSelect={() => onSelectAudio(entry.code)}
          />
        ))}
        {audioTiers.length > 1 && (
          <>
            <div className="menu__divider" />
            <div className="menu__title">Audio quality</div>
            <MenuItem
              label="Auto"
              selected={selectedAudioTier == null}
              onSelect={() => onSelectAudioTier(null)}
            />
            {audioTiers.map((tier) => (
              <MenuItem
                key={tier}
                label={tier}
                selected={selectedAudioTier === tier}
                onSelect={() => onSelectAudioTier(tier)}
              />
            ))}
          </>
        )}
      </Menu>
    </>
  )
})
