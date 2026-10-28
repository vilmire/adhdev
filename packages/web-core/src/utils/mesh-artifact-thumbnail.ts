/**
 * Thumbnail loading for the mesh Artifacts tab: a small concurrency-limited queue
 * plus a dedicated small cache, so scrolling a long list neither floods the daemon
 * with fetches nor evicts the chat bubbles' entries from the shared payload LRU.
 */

export const THUMBNAIL_MAX_CONCURRENT = 3
export const THUMBNAIL_CACHE_MAX = 40

const cache = new Map<string, Blob>()

export function getCachedThumbnail(key: string): Blob | undefined {
    const hit = cache.get(key)
    if (hit) { cache.delete(key); cache.set(key, hit) }
    return hit
}

function setCachedThumbnail(key: string, blob: Blob): void {
    cache.delete(key)
    if (cache.size >= THUMBNAIL_CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, blob)
}

export function clearThumbnailState(): void {
    cache.clear()
    pending.length = 0
}

interface QueueEntry { run: () => void; cancelled: boolean }
const pending: QueueEntry[] = []
let running = 0

function pump(): void {
    while (running < THUMBNAIL_MAX_CONCURRENT && pending.length > 0) {
        const entry = pending.shift()!
        if (entry.cancelled) continue
        running += 1
        entry.run()
    }
}

/**
 * Queue a thumbnail load. Entries cancelled before their turn (row scrolled away or
 * unmounted) are dropped without ever calling `load`. Resolves null when cancelled.
 */
export function enqueueThumbnail(key: string, load: () => Promise<Blob>): { promise: Promise<Blob | null>; cancel: () => void } {
    const cached = getCachedThumbnail(key)
    if (cached) return { promise: Promise.resolve(cached), cancel: () => {} }
    let resolve!: (b: Blob | null) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<Blob | null>((res, rej) => { resolve = res; reject = rej })
    const entry: QueueEntry = {
        cancelled: false,
        run: () => {
            load().then(blob => { setCachedThumbnail(key, blob); resolve(entry.cancelled ? null : blob) }, err => reject(err))
                .finally(() => { running -= 1; pump() })
        },
    }
    pending.push(entry)
    pump()
    return {
        promise,
        cancel: () => {
            if (entry.cancelled) return
            entry.cancelled = true
            const at = pending.indexOf(entry)
            if (at >= 0) { pending.splice(at, 1); resolve(null) }
        },
    }
}
