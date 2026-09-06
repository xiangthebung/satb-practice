/**
 * Where you left off.
 *
 * A rehearsal is rarely finished in one sitting. Closing the tab used to lose
 * the score, the part and the bar, and a singer's own MusicXML file had to be
 * found and opened again every time. This keeps one record — the last score
 * opened, the file itself when it was the singer's own, and the bar the
 * transport was at — in IndexedDB, which unlike localStorage can hold a file.
 *
 * Storage is a convenience and never a requirement: every call resolves to
 * something usable when IndexedDB is missing, blocked (private browsing on
 * some browsers) or full, and nothing here throws.
 */

const DB_NAME = 'choir-practice';
const DB_VERSION = 1;
const STORE = 'resume';
const KEY = 'last';

/** Open the database, creating the store on first use. Resolves null if it cannot. */
function openDatabase() {
  return new Promise(resolve => {
    let request;
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * Run one transaction, resolving its result or null.
 *
 * Resolved when the transaction has completed, not when the request has
 * succeeded: a write is only safe once it is committed, and a page that
 * reloads between the two aborts it. "Forget this score" followed at once by
 * a reload used to bring the score back.
 */
async function withStore(mode, action) {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise(resolve => {
    let settled = false;
    let result = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { db.close(); } catch (error) { /* already closed */ }
      resolve(value);
    };
    try {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      request.onsuccess = () => { result = request.result ?? null; };
      request.onerror = () => finish(null);
      transaction.oncomplete = () => finish(result);
      transaction.onabort = () => finish(null);
      transaction.onerror = () => finish(null);
    } catch (error) {
      finish(null);
    }
  });
}

/**
 * Remember the score that is open and where the transport is in it.
 *
 * @param {{
 *   kind: 'sample'|'file',
 *   samplePath?: string|null,
 *   sampleKey?: string|null,
 *   file?: Blob|null,
 *   fileName: string,
 *   title: string,
 *   composer?: string,
 *   voiceType?: string|null,
 *   partName?: string|null,
 *   beat: number,
 *   bar: number,
 *   tempo?: number
 * }} record
 * @returns {Promise<boolean>} true when the record was written
 */
export async function saveResume(record) {
  if (!record || !record.fileName) return false;
  const stored = { ...record, savedAt: Date.now() };
  const result = await withStore('readwrite', store => store.put(stored, KEY));
  return result !== null;
}

/** Forget the last score. Resolves once the deletion is committed. */
export async function clearResume() {
  await withStore('readwrite', store => store.delete(KEY));
}

/** The last record, or null when there is none or storage is unavailable. */
export async function readResume() {
  const record = await withStore('readonly', store => store.get(KEY));
  return isResumeRecord(record) ? record : null;
}

/**
 * A record is only worth offering if it can be opened again.
 * @param {object} record
 * @returns {boolean}
 */
export function isResumeRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (!record.fileName || !record.title) return false;
  if (record.kind === 'sample') return Boolean(record.samplePath);
  if (record.kind === 'file') return Boolean(record.file);
  return false;
}

/**
 * The words on the home screen's card.
 *
 * "Continue: Quick! We have but a second, bar 14", with the part and tempo
 * underneath. Bar one is the start, so it is not called out as a position.
 *
 * @param {object} record
 * @returns {{ label: string, detail: string }}
 */
export function describeResume(record) {
  if (!isResumeRecord(record)) return { label: '', detail: '' };
  const bar = Math.round(Number(record.bar) || 0);
  const label = bar > 1
    ? `Continue: ${record.title}, bar ${bar}`
    : `Continue: ${record.title}`;
  const details = [];
  if (record.partName) details.push(record.partName);
  const tempo = Math.round(Number(record.tempo) || 0);
  if (tempo > 0) details.push(`${tempo} BPM`);
  if (record.kind === 'file') details.push('your own file');
  return { label, detail: details.join(' · ') };
}
