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

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' https: data: blob:; media-src 'self' http://127.0.0.1:* blob:; " +
  "connect-src 'self' http://127.0.0.1:*; font-src 'self' data:; worker-src 'self' blob:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'"

/** Injects a strict CSP into the built HTML (dev relies on Vite's dev server). */
function cspPlugin() {
  return {
    name: 'inject-csp',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html.replace(
        '</head>',
        `    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  </head>`
      )
    }
  }
}

export default defineConfig({
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
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react(), cspPlugin()]
  }
})
