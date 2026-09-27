import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from './Icons'

interface Props {
  children: ReactNode
  /** Changing this value resets the boundary, e.g. the current route. */
  resetKey?: string
}

interface State {
  error: Error | null
}

/**
 * Catches render-time errors so a bad video manifest, a failed IPC call or a
 * bug in one page cannot leave the user staring at a blank white window with no
 * way back.
 *
 * Deliberately a class component: `getDerivedStateFromError` and
 * `componentDidCatch` have no hook equivalent. It is mounted at three levels —
 * around the whole app, and around each page inside the content area — so a
 * crash while watching a video does not take the navigation with it.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The renderer has no devtools in a packaged build, so this is the only
    // place a stack trace is recoverable.
    console.error('[renderer] uncaught error', error, info.componentStack)
  }

  override componentDidUpdate(prev: Props): void {
    // Navigating away from a broken page should clear the error automatically
    // rather than making the user find and press "Try again".
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private readonly retry = (): void => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash">
        <div className="crash__card" role="alert">
          <span className="crash__icon">
            <Icon name="info" size={32} />
          </span>
          <h2 className="crash__title">Something went wrong</h2>
          <p className="crash__message">
            The page hit an unexpected error. Your saved playlists, bookmarks and
            history are unaffected.
          </p>
          <pre className="crash__detail">{error.message}</pre>
          <div className="crash__actions">
            <button className="btn btn--filled" onClick={this.retry} autoFocus>
              Try again
            </button>
            <button
              className="btn btn--tonal"
              onClick={() => {
                window.location.hash = '#/search?q=&f=all'
                window.location.reload()
              }}
            >
              Go to search
            </button>
          </div>
        </div>
      </div>
    )
  }
}
