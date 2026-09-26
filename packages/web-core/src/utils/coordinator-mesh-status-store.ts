/**
 * Coordinator mesh-status store — ONE shared, per-mesh holder of the
 * coordinator daemon's latest `mesh_status` answer.
 *
 * Owner principle: the dashboard talks only to a mesh's coordinator daemon,
 * and that daemon already holds every node's latest state (members push git +
 * content-free runtime to it). So there is exactly one thing to read per mesh,
 * and every surface that shows it — the /mesh page, the dashboard graph dialog,
 * the session info dialog — reads it from here instead of running its own
 * loader, cache, and retry loop.
 *
 * Rules this store enforces:
 *  - Requests for the same mesh are de-duplicated: while one is in flight a
 *    second caller gets the same promise. A `refresh:true` request that arrives
 *    while a plain read is in flight is queued behind it (once).
 *  - Nothing here retries or escalates. Freshness is the coordinator's job: each
 *    node carries `gitObservation` / `heldRuntime` (age, refreshing,
 *    unreachable), and the coordinator bumps the mesh revision when a background
 *    refresh lands. Callers re-read on that signal with `refresh:false`;
 *    `refresh:true` is reserved for an explicit user action.
 *  - A failed read keeps the last good status on screen and records the error.
 */
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import { extractRepoMeshStatus } from './repo-mesh-status'

export type CoordinatorMeshStatusLoader = (
    daemonId: string,
    meshId: string,
    options: { refresh: boolean },
) => Promise<unknown>

export interface CoordinatorMeshStatusSnapshot {
    meshId: string
    /** Coordinator daemon that produced `status` (the last successful read). */
    daemonId: string | null
    status: RepoMeshStatus | null
    /** Raw response of the last successful read (e.g. to read loader flags). */
    response: unknown
    /** Epoch ms of the last successful read. */
    loadedAt: number | null
    loading: boolean
    refreshing: boolean
    error: string | null
}

interface InFlight {
    daemonId: string
    refresh: boolean
    promise: Promise<RepoMeshStatus | null>
}

interface Entry {
    snapshot: CoordinatorMeshStatusSnapshot
    inFlight: InFlight | null
    queuedRefresh: Promise<RepoMeshStatus | null> | null
    listeners: Set<() => void>
}

const entries = new Map<string, Entry>()

function emptySnapshot(meshId: string): CoordinatorMeshStatusSnapshot {
    return { meshId, daemonId: null, status: null, response: null, loadedAt: null, loading: false, refreshing: false, error: null }
}

function getEntry(meshId: string): Entry {
    let entry = entries.get(meshId)
    if (!entry) {
        entry = { snapshot: emptySnapshot(meshId), inFlight: null, queuedRefresh: null, listeners: new Set() }
        entries.set(meshId, entry)
    }
    return entry
}

function update(meshId: string, patch: Partial<CoordinatorMeshStatusSnapshot>): void {
    const entry = getEntry(meshId)
    entry.snapshot = { ...entry.snapshot, ...patch }
    for (const listener of [...entry.listeners]) {
        try { listener() } catch { /* a listener must never break the store */ }
    }
}

/** Current snapshot for a mesh (a stable object until the next change). */
export function getCoordinatorMeshStatusSnapshot(meshId: string | null | undefined): CoordinatorMeshStatusSnapshot | null {
    if (!meshId) return null
    return entries.get(meshId)?.snapshot ?? null
}

/** Last good status for a mesh, if any surface has loaded it. */
export function peekCoordinatorMeshStatus(meshId: string | null | undefined): RepoMeshStatus | null {
    return getCoordinatorMeshStatusSnapshot(meshId)?.status ?? null
}

export function subscribeCoordinatorMeshStatus(meshId: string, listener: () => void): () => void {
    const entry = getEntry(meshId)
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener) }
}

/** Seed / overwrite the held status (tests, or a surface that already holds a fresh answer). */
export function primeCoordinatorMeshStatus(meshId: string, status: RepoMeshStatus | null, daemonId: string | null = null): void {
    update(meshId, { status, daemonId, loadedAt: status ? Date.now() : null, error: null })
}

/** Test helper: forget everything. */
export function resetCoordinatorMeshStatusStore(): void {
    entries.clear()
}

export interface LoadCoordinatorMeshStatusArgs {
    meshId: string
    /** The mesh's coordinator daemon. The store never falls back to another daemon. */
    daemonId: string
    /** true only for an explicit user refresh. */
    refresh?: boolean
    load: CoordinatorMeshStatusLoader
    extract?: (response: unknown) => RepoMeshStatus | null
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Failed to load mesh status'
}

/**
 * Read the coordinator's mesh_status into the shared store. Resolves with the
 * committed status (or null on failure — the error lands in the snapshot).
 * Never rejects.
 */
export function loadCoordinatorMeshStatus(args: LoadCoordinatorMeshStatusArgs): Promise<RepoMeshStatus | null> {
    const { meshId, daemonId, load } = args
    const refresh = args.refresh === true
    const extract = args.extract ?? ((response: unknown) => extractRepoMeshStatus(response))
    if (!meshId || !daemonId) return Promise.resolve(null)
    const entry = getEntry(meshId)
    const inFlight = entry.inFlight
    if (inFlight && inFlight.daemonId === daemonId) {
        if (!refresh || inFlight.refresh) return inFlight.promise
        // An explicit refresh while a plain read is in flight: run it once, after.
        if (!entry.queuedRefresh) {
            entry.queuedRefresh = inFlight.promise.then(() => {
                entry.queuedRefresh = null
                return loadCoordinatorMeshStatus(args)
            })
        }
        return entry.queuedRefresh
    }

    const hasStatus = entry.snapshot.status !== null
    update(meshId, { loading: !hasStatus, refreshing: hasStatus, error: null })
    const promise: Promise<RepoMeshStatus | null> = (async () => {
        // Yield once so `entry.inFlight` is set before any settle path runs,
        // even when the loader throws synchronously.
        await null
        try {
            const response = await load(daemonId, meshId, { refresh })
            const status = extract(response)
            if (!status) {
                update(meshId, { error: 'mesh_status returned an unexpected payload.' })
                return null
            }
            update(meshId, { status, response, daemonId, loadedAt: Date.now(), error: null })
            return status
        } catch (error) {
            update(meshId, { error: describeError(error) })
            return null
        } finally {
            if (entry.inFlight?.promise === promise) entry.inFlight = null
            update(meshId, { loading: false, refreshing: false })
        }
    })()
    entry.inFlight = { daemonId, refresh, promise }
    return promise
}
