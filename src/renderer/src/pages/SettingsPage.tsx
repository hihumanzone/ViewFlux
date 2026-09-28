import { Icon } from '../components/Icons'
import { SelectField } from '../components/SelectField'
import { SliderField } from '../components/SliderField'
import { SubtitleStyleControls } from '../components/SubtitleStyleControls'
import { useApp } from '../state/AppContext'
import { Switch } from '../components/Switch'
import { ACCENTS, SPONSOR_CATEGORIES, type Settings } from '../../../shared/types'
import { DEFAULT_SUBTITLE_STYLE } from '../../../shared/subtitles'
import { PLAYBACK_SPEEDS as SPEEDS } from '../../../shared/media'
import { APP_VERSION_LABEL } from '../../../shared/appInfo'
import { formatExact } from '../lib/format'

/**
 * `auto` follows the bandwidth, `max` picks the highest variant the manifest
 * offers, and the rest are hard ceilings the player targets directly.
 */
const QUALITIES: Settings['preferredQuality'][] = ['auto', 'max', '2160', '1440', '1080', '720', '480', '360']
const WATCH_LIMITS = [100, 250, 500, 1000, 2500, 5000]
const SEARCH_LIMITS = [25, 50, 100, 200, 500]

function Row({
  icon,
  label,
  hint,
  children
}: {
  icon?: Parameters<typeof Icon>[0]['name']
  label: string
  hint?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="setting">
      <div className="setting__text">
        <div className="setting__label">
          {icon && (
            <span className="setting__icon">
              <Icon name={icon} size={20} />
            </span>
          )}
          {label}
        </div>
        {hint && <div className="setting__hint">{hint}</div>}
      </div>
      {children && <div className="setting__control">{children}</div>}
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const { settings, searchHistory, history, saveSettings, clearSearchHistory, refreshHistory, confirm, toast } =
    useApp()

  /**
   * Persist a change and confirm it once. Used for one-shot controls (switches,
   * chips, dropdowns).
   */
  const update = (patch: Partial<Settings>): void => {
    void saveSettings({ ...settings, ...patch }).then(() => toast('Settings saved'))
  }

  /**
   * Persist a change without a toast. Sliders call this for every step of a
   * drag; the matching `onCommit` (on release) raises a single toast, so a
   * drag can no longer flood the screen with "Settings saved" notifications.
   */
  const updateQuietly = (patch: Partial<Settings>): void => {
    void saveSettings({ ...settings, ...patch })
  }

  const toggleCategory = (id: string): void => {
    update({
      sponsorCategories: {
        ...settings.sponsorCategories,
        [id]: !settings.sponsorCategories[id]
      }
    })
  }

  const clearSearches = async (): Promise<void> => {
    const ok = await confirm('Clear your search history?', {
      confirmLabel: 'Clear all',
      danger: true
    })
    if (!ok) return
    await clearSearchHistory()
    toast('Search history cleared')
  }

  const clearWatches = async (): Promise<void> => {
    const ok = await confirm('Clear your entire watch history?', {
      confirmLabel: 'Clear all',
      danger: true
    })
    if (!ok) return
    await window.api.clearHistory()
    await refreshHistory()
    toast('Watch history cleared')
  }

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Settings</h1>
          <p className="page__subtitle">Everything is stored locally on this device.</p>
        </div>
      </div>

      <div className="settings">
        <section className="settings-section">
          <div className="settings-section__heading">
            <Icon name="play_arrow" size={18} />
            Playback
          </div>
          <Row label="Preferred quality" hint="Applies to newly opened videos.">
            <SelectField
              value={settings.preferredQuality}
              options={QUALITIES.map((q) => ({
                value: q,
                label: q === 'auto' ? 'Auto' : q === 'max' ? 'Max quality' : `${q}p`
              }))}
              onSelect={(preferredQuality) => update({ preferredQuality })}
            />
          </Row>
          <Row label="Default playback speed" hint="Videos open at this speed.">
            <SelectField
              value={settings.preferredSpeed}
              options={SPEEDS.map((s) => ({ value: s, label: s === 1 ? 'Normal' : `${s}×` }))}
              onSelect={(preferredSpeed) => update({ preferredSpeed })}
            />
          </Row>
          <Row
            label="Default volume"
            hint="Type a value or drag the slider. Anything above 100% uses the volume booster."
          >
            <SliderField
              value={Math.round(settings.defaultVolume * 100)}
              min={0}
              max={300}
              step={5}
              suffix="%"
              label="Default volume"
              onChange={(percent) => updateQuietly({ defaultVolume: percent / 100 })}
              onCommit={() => toast('Settings saved')}
            />
          </Row>
          <Row label="Autoplay in playlists" hint="Automatically play the next video in a playlist.">
            <Switch
              on={settings.autoplayPlaylists}
              label="Autoplay in playlists"
              onClick={() => update({ autoplayPlaylists: !settings.autoplayPlaylists })}
            />
          </Row>
          <Row label="Preserve pitch" hint="Keep audio pitch when changing playback speed.">
            <Switch
              on={settings.preservePitch}
              label="Preserve pitch"
              onClick={() => update({ preservePitch: !settings.preservePitch })}
            />
          </Row>
          <Row
            label="Skip silence"
            hint="Automatically fast-forward through silent passages."
          >
            <Switch
              on={settings.skipSilence}
              label="Skip silence"
              onClick={() => update({ skipSilence: !settings.skipSilence })}
            />
          </Row>
        </section>

        <section className="settings-section">
          <div className="settings-section__heading">
            <Icon name="captions" size={18} />
            Subtitles
          </div>
          <Row
            label="Always show subtitles"
            hint="Turn on the first available caption track by default."
          >
            <Switch
              on={settings.alwaysShowCaptions}
              label="Always show subtitles"
              onClick={() => update({ alwaysShowCaptions: !settings.alwaysShowCaptions })}
            />
          </Row>
          <div className="setting setting--column">
            <div className="setting__text">
              <div className="setting__label">Caption appearance</div>
              <div className="setting__hint">
                Size is a percentage of the automatic size, which itself scales with the video.
                Also editable from the player's subtitle menu.
              </div>
            </div>
            <SubtitleStyleControls
              style={settings.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE}
              previewHeight={620}
              onChange={(subtitleStyle) => updateQuietly({ subtitleStyle })}
              onCommit={() => toast('Settings saved')}
            />
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section__heading">
            <Icon name="palette" size={18} />
            Appearance
          </div>
          <div className="setting setting--column">
            <div className="setting__text">
              <div className="setting__label">Accent color</div>
              <div className="setting__hint">Used for highlights, buttons and the player.</div>
            </div>
            <div className="accent-grid" role="radiogroup" aria-label="Accent color">
              {ACCENTS.map((accent) => (
                <button
                  key={accent.id}
                  type="button"
                  className={`accent-chip${settings.accent === accent.id ? ' accent-chip--active' : ''}`}
                  title={accent.label}
                  // Radio group: one accent is active at a time.
                  role="radio"
                  aria-checked={settings.accent === accent.id}
                  onClick={() => update({ accent: accent.id })}
                >
                  <span className="accent-chip__dot" style={{ background: accent.color }} />
                  {accent.label}
                  {settings.accent === accent.id && <Icon name="check" size={16} />}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section__heading">
            <Icon name="history" size={18} />
            History
          </div>
          <Row
            label="Save watch history"
            hint="Remember what you watched so you can resume where you left off."
          >
            <Switch
              on={settings.saveWatchHistory}
              label="Save watch history"
              onClick={() => update({ saveWatchHistory: !settings.saveWatchHistory })}
            />
          </Row>
          <Row label="Watch history limit" hint="Maximum number of videos to keep in history.">
            <SelectField
              value={settings.maxWatchHistory || 500}
              options={WATCH_LIMITS.map((limit) => ({
                value: limit,
                label: `${limit} videos`
              }))}
              onSelect={(maxWatchHistory) => update({ maxWatchHistory })}
            />
          </Row>
          {settings.saveWatchHistory && history.length > 0 && (
            <Row
              label="Watch history"
              hint={`${history.length} ${history.length === 1 ? 'video' : 'videos'} recorded.`}
            >
              <button className="btn btn--tonal btn--sm" onClick={() => void clearWatches()}>
                <Icon name="delete" size={16} />
                Clear
              </button>
            </Row>
          )}
          <Row
            label="Save search history"
            hint="Recent searches appear on the search page."
          >
            <Switch
              on={settings.saveSearchHistory}
              label="Save search history"
              onClick={() => update({ saveSearchHistory: !settings.saveSearchHistory })}
            />
          </Row>
          <Row label="Search history limit" hint="Maximum number of recent queries to remember.">
            <SelectField
              value={settings.maxSearchHistory || 50}
              options={SEARCH_LIMITS.map((limit) => ({
                value: limit,
                label: `${limit} searches`
              }))}
              onSelect={(maxSearchHistory) => update({ maxSearchHistory })}
            />
          </Row>
          {settings.saveSearchHistory && searchHistory.length > 0 && (
            <Row
              label="Search history"
              hint={`${searchHistory.length} saved ${searchHistory.length === 1 ? 'search' : 'searches'}.`}
            >
              <button className="btn btn--tonal btn--sm" onClick={() => void clearSearches()}>
                <Icon name="delete" size={16} />
                Clear
              </button>
            </Row>
          )}
        </section>

        <section className="settings-section">
          <div className="settings-section__heading">
            <Icon name="speed" size={18} />
            SponsorBlock
          </div>
          <Row
            label="Enable SponsorBlock"
            hint="Highlights and lets you skip sponsored and other segments."
          >
            <Switch
              on={settings.sponsorBlockEnabled}
              label="Enable SponsorBlock"
              onClick={() => update({ sponsorBlockEnabled: !settings.sponsorBlockEnabled })}
            />
          </Row>
          <Row
            label="Skip automatically"
            hint="Jump past enabled segments during playback. You can undo each skip."
          >
            <Switch
              on={settings.autoSkip}
              label="Skip automatically"
              onClick={() => update({ autoSkip: !settings.autoSkip })}
            />
          </Row>
          <div className="settings-section__subheading">Categories to skip</div>
          <div className="category-grid">
            {SPONSOR_CATEGORIES.map((category) => {
              const on = Boolean(settings.sponsorCategories[category.id])
              return (
                <button
                  key={category.id}
                  type="button"
                  className="category-row"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggleCategory(category.id)}
                >
                  <span className={`checkbox${on ? ' checkbox--on' : ''}`}>
                    {on && <Icon name="check" size={14} />}
                  </span>
                  <span>{category.label}</span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section__heading">
            <Icon name="info" size={18} />
            About
          </div>
          <Row label="ViewFlux Desktop" hint="A native Windows client focused on searching and watching.">
            <span className="about-version">{APP_VERSION_LABEL}</span>
          </Row>
          <Row
            label="Local library"
            hint="Playlists, bookmarks, history and settings, stored on this device only."
          >
            <span className="about-version">
              {formatExact(history.length)} watched
              {searchHistory.length > 0 ? ` · ${formatExact(searchHistory.length)} searches` : ''}
            </span>
          </Row>
        </section>
      </div>
    </div>
  )
}
