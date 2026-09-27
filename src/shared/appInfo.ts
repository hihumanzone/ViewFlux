/**
 * Build/runtime facts the About panel shows.
 *
 * `__APP_VERSION__` is substituted by Vite at build time from package.json, so
 * bumping the version can no longer leave the About panel claiming to be an
 * older release. During `tsc` and in tests the define is absent, hence the
 * `typeof` guard and the `'dev'` fallback.
 */
declare const __APP_VERSION__: string

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

/** `v1.2.3`, or just `dev` when there is no build-time version to show. */
export const APP_VERSION_LABEL = APP_VERSION === 'dev' ? APP_VERSION : `v${APP_VERSION}`
