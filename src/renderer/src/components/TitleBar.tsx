import { Icon } from './Icons'
import { goBack, useCanGoBack } from '../lib/router'

export function TitleBar(): React.JSX.Element {
  const canBack = useCanGoBack()

  return (
    <header className="titlebar">
      <button
        className="titlebar__back"
        aria-label="Back"
        disabled={!canBack}
        onClick={goBack}
        title="Go back (Alt+Left)"
      >
        <Icon name="back" size={18} />
      </button>
      <div className="titlebar__app-name">
        <span>ViewFlux</span>
      </div>
      <div className="titlebar__spacer" />
      <button
        type="button"
        className="titlebar__shortcuts-btn"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        onClick={() => window.dispatchEvent(new CustomEvent('viewflux:open-shortcuts'))}
      >
        <Icon name="info" size={16} />
      </button>
    </header>
  )
}
