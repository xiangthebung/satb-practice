/**
 * Small persistence helper.
 *
 * Every read and write is guarded: private browsing modes and locked-down
 * storage settings make localStorage throw, and a rehearsal tool must keep
 * working without its saved preferences.
 */

const NAMESPACE = 'choir-practice';

function storage() {
  try {
    return window.localStorage;
  } catch (error) {
    return null;
  }
}

/**
 * Read a stored string preference.
 * @param {string} key
 * @param {string|null} fallback
 * @returns {string|null}
 */
export function readPref(key, fallback = null) {
  try {
    const value = storage()?.getItem(`${NAMESPACE}:${key}`);
    return value === null || value === undefined ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

/**
 * Persist a string preference. Passing null removes it.
 * @param {string} key
 * @param {string|null} value
 */
export function writePref(key, value) {
  try {
    const store = storage();
    if (!store) return;
    if (value === null || value === undefined) store.removeItem(`${NAMESPACE}:${key}`);
    else store.setItem(`${NAMESPACE}:${key}`, String(value));
  } catch (error) {
    // Preferences are a convenience, never a requirement.
  }
}

/**
 * Read a numeric preference, clamped to a range.
 * @param {string} key
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function readNumberPref(key, fallback, min = -Infinity, max = Infinity) {
  const stored = readPref(key);
  // A missing preference must fall back, and Number('') / Number(null) are 0.
  if (stored === null || String(stored).trim() === '') return fallback;
  const value = Number(stored);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Read a boolean preference stored as '1' / '0'.
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function readBoolPref(key, fallback = false) {
  const value = readPref(key);
  if (value === null) return fallback;
  return value === '1' || value === 'true';
}

/**
 * Persist a boolean preference.
 * @param {string} key
 * @param {boolean} value
 */
export function writeBoolPref(key, value) {
  writePref(key, value ? '1' : '0');
}
