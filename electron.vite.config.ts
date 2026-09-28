import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version?: string
}

/** Keeps the About panel in sync with package.json instead of a hardcoded string. */
const appVersionDefine = {
  __APP_VERSION__: JSON.stringify(pkg.version ?? 'dev')
}

/** Strict policy for built output. */
const CSP_BUILD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' https: data: blob:; media-src 'self' http://127.0.0.1:* blob:; " +
  "connect-src 'self' http://127.0.0.1:*; font-src 'self' data:; worker-src 'self' blob:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'"

/**
 * Policy for the dev server. Vite injects an inline react-refresh preamble and
 * talks to an HMR websocket, so both need relaxing. `unsafe-eval` is
 * deliberately NOT enabled: Electron refuses to treat the page as secured
 * without it, and the dev server does not need it.
 */
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' https: data: blob:; media-src 'self' http://127.0.0.1:* blob:; " +
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://127.0.0.1:*; " +
  "font-src 'self' data:; worker-src 'self' blob:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'"

/**
 * Injects a CSP into the served HTML. Applies in dev as well as build, since
 * without it the dev server leaves the renderer with no policy at all and
 * Electron logs an insecure-CSP warning.
 */
function cspPlugin(isDev: boolean) {
  const csp = isDev ? CSP_DEV : CSP_BUILD
  return {
    name: 'inject-csp',
    transformIndexHtml(html: string) {
      return html.replace(
        '</head>',
        `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`
      )
    }
  }
}

export default defineConfig(({ command }) => {
  const isDev = command === 'serve'

  return {
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    // The renderer is sandboxed with no Node access, so the version has to be
    // baked in rather than read from package.json at runtime.
    define: appVersionDefine,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
        output: {
          // Rolldown (Vite 8) removed the object form of manualChunks in favour
          // of codeSplitting groups. Patterns are matched against resolved
          // module paths, hence the node_modules-scoped tests.
          codeSplitting: {
            groups: [
              { name: 'shaka-player', test: /node_modules[\\/]shaka-player/ },
              { name: 'react-vendor', test: /node_modules[\\/](react|react-dom)[\\/]/ }
            ]
          }
        }
      }
    },
    plugins: [react(), cspPlugin(isDev)]
  }
  }
})
