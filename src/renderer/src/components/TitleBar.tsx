import { Icon } from './Icons'
import { goBack, goForward, useCanGoBack, useCanGoForward } from '../lib/router'

export function TitleBar(): React.JSX.Element {
  const canBack = useCanGoBack()
  const canForward = useCanGoForward()

  return (
    <header className="titlebar">
      <div className="titlebar__nav-group">
        <button
          type="button"
          className="titlebar__nav-btn titlebar__back"
          aria-label="Back"
          disabled={!canBack}
          onClick={goBack}
          title="Go back (Alt+Left)"
        >
          <Icon name="back" size={17} />
        </button>
        <button
          type="button"
          className="titlebar__nav-btn titlebar__forward"
          aria-label="Forward"
          disabled={!canForward}
          onClick={goForward}
          title="Go forward (Alt+Right)"
        >
          <Icon name="forward" size={17} />
        </button>
      </div>
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
