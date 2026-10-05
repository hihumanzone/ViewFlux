import { createRoot } from 'react-dom/client'
import { AppProvider } from './state/AppContext'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root container #root not found')

if (window.api?.platform) {
  document.documentElement.dataset.platform = window.api.platform
}

// No StrictMode: it double-invokes effects, which would create and destroy the
// Shaka Player instance twice on every mount.
createRoot(container).render(
  // Outermost boundary: catches a failure in the provider itself, which would
  // otherwise unmount the entire tree and leave a permanently blank window.
  <ErrorBoundary>
    <AppProvider>
      <App />
    </AppProvider>
  </ErrorBoundary>
)
