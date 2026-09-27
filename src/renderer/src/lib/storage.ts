/**
 * localStorage access that never throws.
 *
 * The renderer is a normal web context, but it runs on `file://` under a
 * strict CSP and can be pointed at a profile where storage is disabled. A bare
 * `localStorage.setItem` in that situation throws a SecurityError from inside
 * an event handler or a lazy initialiser, which takes down the whole view. UI
 * preferences are never worth that, so every read falls back to the default and
 * every write is dropped silently.
 */

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readStored(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeStored(key: string, value: string): void {
  try {
    storage()?.setItem(key, value)
  } catch {
    /* preference simply won't persist */
  }
}

/**
 * Reads the current value of `key`, falling back to `legacyKey` for installs
 * that predate the current key name. Returns `null` if neither is set.
 */
export function readStoredWithLegacy(key: string, legacyKey: string): string | null {
  return readStored(key) ?? readStored(legacyKey)
}
