/**
 * Opener-independent pop-out handoff.
 *
 * `window.open` can navigate the SAME tab (embedded browser panes, webviews, installed PWAs) or
 * return a window whose `opener` is null, so the postMessage handshake alone cannot be relied on.
 * Before opening, the opener parks the artifact in same-origin IndexedDB under a random handle
 * and opens `/artifact-view?h=<handle>`; the viewer takes (read + delete) the record. The URL
 * carries only the handle — never an artifact id, filename or content.
 *
 * The record is deleted when read and records older than HANDOFF_MAX_AGE_MS are swept on every
 * write and viewer load (all of them on sign-out), so content does not sit at rest. The store is injectable (tests, odd runtimes).
 */
export const ARTIFACT_HANDOFF_PARAM = 'h'
export const HANDOFF_MAX_AGE_MS = 10 * 60 * 1000
const HANDLE_RE = /^[0-9a-f]{32}$/

export interface ArtifactHandoffRecord {
    handle: string
    createdAt: number
    /** A structured-cloneable viewer item (Blob allowed; never an object URL). */
    item: unknown
}

export interface ArtifactHandoffStore {
    put(record: ArtifactHandoffRecord): Promise<void>
    /** Read and delete in one transaction. */
    take(handle: string): Promise<ArtifactHandoffRecord | null>
    /** Delete every record created before `cutoff` (ms epoch). */
    sweep(cutoff: number): Promise<void>
}

const DB_NAME = 'adhdev-artifact-handoff'
const STORE_NAME = 'items'

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('indexeddb_unavailable')); return }
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
            const store = req.result.createObjectStore(STORE_NAME, { keyPath: 'handle' })
            store.createIndex('createdAt', 'createdAt')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('indexeddb_open_failed'))
        req.onblocked = () => reject(new Error('indexeddb_blocked'))
    })
}

/** Run `fn` in one transaction; resolves with its result once the transaction COMMITS. */
async function withStore<T>(fn: (store: IDBObjectStore, setResult: (v: T) => void) => void, fallback: T): Promise<T> {
    const db = await openDb()
    try {
        return await new Promise<T>((resolve, reject) => {
            let result = fallback
            const tx = db.transaction(STORE_NAME, 'readwrite')
            tx.oncomplete = () => resolve(result)
            tx.onerror = () => reject(tx.error ?? new Error('indexeddb_tx_failed'))
            tx.onabort = () => reject(tx.error ?? new Error('indexeddb_tx_aborted'))
            fn(tx.objectStore(STORE_NAME), v => { result = v })
        })
    } finally {
        db.close()
    }
}

export const indexedDbHandoffStore: ArtifactHandoffStore = {
    put: record => withStore<void>(store => { store.put(record) }, undefined),
    take: handle => withStore<ArtifactHandoffRecord | null>((store, setResult) => {
        const get = store.get(handle)
        get.onsuccess = () => {
            if (get.result) { setResult(get.result as ArtifactHandoffRecord); store.delete(handle) }
        }
    }, null),
    sweep: cutoff => withStore<void>(store => {
        const cursorReq = store.index('createdAt').openCursor(IDBKeyRange.upperBound(cutoff, true))
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (cursor) { cursor.delete(); cursor.continue() }
        }
    }, undefined),
}

let activeStore: ArtifactHandoffStore | null = null
/** Swap the store (tests); pass null to restore the IndexedDB default. */
export function setArtifactHandoffStore(store: ArtifactHandoffStore | null): void {
    activeStore = store
    consumed.clear()
}
function getStore(): ArtifactHandoffStore { return activeStore ?? indexedDbHandoffStore }

export function newHandoffHandle(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function isHandoffHandle(value: unknown): value is string {
    return typeof value === 'string' && HANDLE_RE.test(value)
}

/**
 * Park `item` and return the handle. Throws when the store cannot hold it — the caller must
 * then keep the content in-page (modal) instead of opening a window that could never show it.
 */
export async function putArtifactHandoff(item: unknown, now: number = Date.now()): Promise<string> {
    const store = getStore()
    // Sweeping is hygiene, never a reason to lose the content.
    try { await store.sweep(now - HANDOFF_MAX_AGE_MS) } catch { /* best effort */ }
    const handle = newHandoffHandle()
    await store.put({ handle, createdAt: now, item })
    return handle
}

/** Best-effort removal of a parked record (e.g. the window turned out to be blocked). */
export async function discardArtifactHandoff(handle: string): Promise<void> {
    try { await getStore().take(handle) } catch { /* swept later */ }
}

/** Best-effort sweep of expired records; a window that never read its record must not leave it behind. */
export async function sweepArtifactHandoffs(now: number = Date.now()): Promise<void> {
    try { await getStore().sweep(now - HANDOFF_MAX_AGE_MS) } catch { /* retried on the next open */ }
}

/** Remove every parked record, expired or not (sign-out: parked content must not outlive the session). */
export async function purgeArtifactHandoffs(): Promise<void> {
    try { await getStore().sweep(Number.MAX_SAFE_INTEGER) } catch { /* expires on the next sweep */ }
}

const consumed = new Map<string, Promise<unknown | null>>()

/**
 * Read-and-delete. Memoised per handle so a re-run of the viewer's effect (StrictMode, remount)
 * sees the same result instead of an already-deleted record.
 */
export function consumeArtifactHandoff(handle: string, now: number = Date.now()): Promise<unknown | null> {
    if (!isHandoffHandle(handle)) return Promise.resolve(null)
    let pending = consumed.get(handle)
    if (!pending) {
        pending = getStore().take(handle).then(
            record => (record && now - record.createdAt <= HANDOFF_MAX_AGE_MS ? record.item : null),
            () => null,
        )
        consumed.set(handle, pending)
    }
    return pending
}
