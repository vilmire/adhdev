/**
 * Mesh name registry — meshId → display name, for labelling conversations.
 *
 * A coordinator / worker session only carries its mesh *id*
 * (`coordinator.meshId`, `settings.meshCoordinatorFor`, `settings.meshNodeFor`).
 * The human name lives in the mesh list / mesh status answers that other
 * surfaces already load (New Session mesh picker, the Mesh page list, the
 * coordinator mesh-status store). Those surfaces record what they learned
 * here, and the conversation markers read it — so showing "Coordinator ·
 * <mesh name>" never costs a network call of its own.
 *
 * Names persist in localStorage as a per-viewer convenience so a reload does
 * not fall back to the bare role label until the next mesh read. Storage is
 * best-effort: every access is guarded and the registry works in memory only
 * when storage is unavailable.
 */

const STORAGE_KEY = 'adhdev:mesh-names:v1'
const MAX_ENTRIES = 200

let names: Map<string, string> | null = null
let version = 0
const listeners = new Set<() => void>()

function load(): Map<string, string> {
    if (names) return names
    names = new Map()
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
        const parsed = raw ? JSON.parse(raw) : null
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [id, name] of Object.entries(parsed)) {
                if (typeof name === 'string' && name.trim()) names.set(id, name.trim())
            }
        }
    } catch { /* storage unavailable or corrupt — start empty */ }
    return names
}

function persist(map: Map<string, string>): void {
    try {
        if (typeof localStorage === 'undefined') return
        const entries = [...map.entries()].slice(-MAX_ENTRIES)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
    } catch { /* best-effort */ }
}

/** Record names learned from a mesh list / status answer. Ignores id-only entries. */
export function rememberMeshNames(meshes: ReadonlyArray<{ id?: unknown; name?: unknown } | null | undefined>): void {
    const map = load()
    let changed = false
    for (const mesh of meshes) {
        const id = typeof mesh?.id === 'string' ? mesh.id.trim() : ''
        const name = typeof mesh?.name === 'string' ? mesh.name.trim() : ''
        // A name equal to the id is a fallback label, not a real name.
        if (!id || !name || name === id) continue
        if (map.get(id) === name) continue
        map.delete(id)
        map.set(id, name)
        changed = true
    }
    if (!changed) return
    version += 1
    persist(map)
    for (const listener of [...listeners]) {
        try { listener() } catch { /* a listener must never break the registry */ }
    }
}

export function rememberMeshName(id: unknown, name: unknown): void {
    rememberMeshNames([{ id, name }])
}

export function getMeshName(meshId: string | null | undefined): string | null {
    if (!meshId) return null
    return load().get(meshId) ?? null
}

export function subscribeMeshNames(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

/** Monotonic change counter (a stable useSyncExternalStore snapshot). */
export function getMeshNamesVersion(): number {
    return version
}

/** Test helper: forget everything (memory and storage). */
export function resetMeshNameRegistry(): void {
    names = new Map()
    version += 1
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    for (const listener of [...listeners]) {
        try { listener() } catch { /* ignore */ }
    }
}
