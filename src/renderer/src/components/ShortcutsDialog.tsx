import { memo } from 'react'
import { Dialog } from './Dialog'
import { Icon } from './Icons'

interface ShortcutRow {
  key: string
  desc: string
}

interface ShortcutCategory {
  title: string
  icon: 'play' | 'search'
  shortcuts: ShortcutRow[]
}

const CATEGORIES: ShortcutCategory[] = [
  {
    title: 'Playback Controls',
    icon: 'play',
    shortcuts: [
      { key: 'Space, K', desc: 'Play / Pause' },
      { key: 'J, L', desc: 'Seek backward / forward 10 seconds' },
      { key: '←, →', desc: 'Seek backward / forward 5 seconds' },
      { key: '[, ]', desc: 'Previous / Next chapter' },
      { key: 'Shift + P, Shift + N', desc: 'Previous / Next playlist video' },
      { key: '0 – 9', desc: 'Seek to percentage (0% to 90%)' },
      { key: 'Home, End', desc: 'Jump to beginning / end' },
      { key: '↑, ↓', desc: 'Volume up / down 5%' },
      { key: 'M', desc: 'Toggle mute' },
      { key: 'F', desc: 'Toggle fullscreen' },
      { key: 'C', desc: 'Toggle subtitles / captions' },
      { key: 'I', desc: 'Toggle Picture-in-Picture' },
      { key: '<, >', desc: 'Decrease / increase playback speed' }
    ]
  },
  {
    title: 'Navigation & General',
    icon: 'search',
    shortcuts: [
      { key: '/ or Ctrl+F', desc: 'Focus search bar' },
      { key: 'Alt + ←', desc: 'Go back to previous screen' },
      { key: 'Alt + →', desc: 'Go forward to next screen' },
      { key: '?', desc: 'Open keyboard shortcuts sheet' },
      { key: 'Esc', desc: 'Close open dialogs, menus and popovers' }
    ]
  }
]

export const ShortcutsDialog = memo(function ShortcutsDialog({
  onClose
}: {
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog title="Keyboard Shortcuts" onClose={onClose} className="shortcuts-dialog">
      <div className="shortcuts-dialog__content">
        {CATEGORIES.map((cat) => (
          <div key={cat.title} className="shortcuts-dialog__category">
            <div className="shortcuts-dialog__category-title">
              <Icon name={cat.icon} size={18} />
              <span>{cat.title}</span>
            </div>
            <div className="shortcuts-dialog__grid">
              {cat.shortcuts.map((sc) => (
                <div key={sc.key} className="shortcuts-dialog__row">
                  <span className="shortcuts-dialog__desc">{sc.desc}</span>
                  <kbd className="shortcuts-dialog__key">{sc.key}</kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="shortcuts-dialog__footer">
        <button type="button" className="btn btn--tonal" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  )
})
