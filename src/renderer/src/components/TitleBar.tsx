import { useEffect, useState } from 'react'
import { Icon } from './Icons'
import { goBack, goForward, useCanGoBack, useCanGoForward } from '../lib/router'

export function TitleBar(): React.JSX.Element {
  const canBack = useCanGoBack()
  const canForward = useCanGoForward()
  const isMac = typeof window !== 'undefined' && window.api?.platform === 'darwin'

  // Detect whether native Window Controls Overlay is active
  const [hasWCO, setHasWCO] = useState<boolean>(() => {
    if (typeof navigator !== 'undefined' && 'windowControlsOverlay' in navigator) {
      return navigator.windowControlsOverlay?.visible ?? false
    }
    return false
  })

  // Show fallback custom controls if on non-Mac platform and native WCO is not available
  const showCustomControls = !isMac && !hasWCO
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const wco = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : undefined
    if (wco) {
      const handler = (e: WindowControlsOverlayGeometryChangeEvent): void => {
        setHasWCO(e.visible ?? wco.visible)
      }
      wco.addEventListener('geometrychange', handler)
      return () => {
        wco.removeEventListener('geometrychange', handler)
      }
    }
    return undefined
  }, [])

  useEffect(() => {
    if (!showCustomControls) return
    void window.api?.isWindowMaximized?.().then(setIsMaximized)
    return window.api?.onWindowMaximizedChange?.(setIsMaximized)
  }, [showCustomControls])

  return (
    <header className="titlebar" data-has-wco={hasWCO ? 'true' : 'false'}>
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
      <div className="titlebar__actions">
        <button
          type="button"
          className="titlebar__shortcuts-btn"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={() => window.dispatchEvent(new CustomEvent('viewflux:open-shortcuts'))}
        >
          <Icon name="keyboard" size={16} />
        </button>
      </div>
      {showCustomControls && (
        <div className="titlebar__window-controls">
          <button
            type="button"
            className="titlebar__window-btn titlebar__window-btn--minimize"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => window.api?.windowMinimize?.()}
          >
            <Icon name="minimize" size={14} />
          </button>
          <button
            type="button"
            className="titlebar__window-btn titlebar__window-btn--maximize"
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
            title={isMaximized ? 'Restore' : 'Maximize'}
            onClick={() => window.api?.windowToggleMaximize?.()}
          >
            <Icon name={isMaximized ? 'restore' : 'maximize'} size={14} />
          </button>
          <button
            type="button"
            className="titlebar__window-btn titlebar__window-btn--close"
            aria-label="Close"
            title="Close"
            onClick={() => window.api?.windowClose?.()}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </header>
  )
}
