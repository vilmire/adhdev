/**
 * Keyed document delta — THE diff/fold engine behind every keyed dashboard
 * lane: `daemon.metadata` (the daemon's state, sessions keyed by id) and
 * `mesh.status` (the coordinator's mesh view, nodes / queue tasks / missions
 * keyed) — data-path audit 2026-09-29 P1-4 (one engine, one spec per lane).
 *
 * A document is plain top-level fields, optional SPLIT objects (an object whose
 * fields are diffed one by one, e.g. daemon.metadata's `status`), and named
 * keyed COLLECTIONS (arrays of rows identified by an id field, possibly nested
 * one object deep, e.g. `queue.tasks` / `status.sessions`). The daemon digests
 * every body it would have sent, diffs it against the digest of the last body
 * DELIVERED to a subscription, and sends only the difference: changed fields,
 * and per collection the rows whose content changed (changed fields only), the
 * fields a row lost, and the rows that disappeared. An unchanged document
 * diffs to `null` — zero bytes on the wire. The dashboard folds each delta
 * into its held snapshot; the fold of every delta since a snapshot equals the
 * latest snapshot apart from `ignore`d fields (pinned by keyed-doc-delta.test.ts).
 *
 * Volatile fields (a build stamp, live process counters, a row's per-build
 * stamps via `stableRow`) are not a change by themselves; when something else
 * changed they ride along.
 *
 * Pure leaf: plain objects in, plain objects out; no transport, no clock.
 */

export interface KeyedDocSpec {
    /** Collection path (`nodes`, `queue.tasks`, `status.sessions`) → the id field of its rows. */
    collections: Readonly<Record<string, string>>
    /** Top-level objects whose own fields are diffed one by one (the rest of the object is not re-sent). */
    splitObjects?: readonly string[]
    /** Field paths (`daemonId`, `status.timestamp`) that are never diffed — envelope identity / clock. */
    ignore?: readonly string[]
    /** Field paths (top-level or inside a split object) that change on every build without meaning anything. */
    volatileTopLevel?: readonly string[]
    /**
     * The part of a collection row that decides whether it CHANGED (drop the
     * per-build stamps inside it). A row whose stable view is unchanged sends
     * nothing; a changed row sends every field whose value differs, stamps
     * included. Must not mutate `row`.
     */
    stableRow?: (collection: string, row: Record<string, unknown>) => Record<string, unknown>
}

type Row = Record<string, unknown>

interface RowDigest {
    readonly value: Row
    /** The row as compared (stableRow view). */
    readonly stable: Row
    readonly sig: string
    fieldSigs?: Map<string, string>
}

interface CollectionDigest {
    readonly rows: ReadonlyMap<string, RowDigest>
    readonly order: readonly string[]
}

export interface KeyedDocDigest {
    /** Field signatures by path (`field`, or `object.field` for a split object). */
    readonly top: ReadonlyMap<string, string>
    readonly topValues: Readonly<Record<string, unknown>>
    readonly collections: ReadonlyMap<string, CollectionDigest>
    readonly volatile: ReadonlySet<string>
}

export interface KeyedCollectionDelta {
    /** New rows (whole) and changed rows (id + changed fields). */
    upsert?: Row[]
    /** Fields a row lost, by row id. */
    unsetFields?: Record<string, string[]>
    removed?: string[]
    order?: string[]
    /** The collection is no longer present in the document at all. */
    absent?: true
}

export interface KeyedDocDelta {
    set?: Record<string, unknown>
    unset?: string[]
    /** Per split object: its changed / lost fields. */
    objects?: Record<string, { set?: Record<string, unknown>; unset?: string[] }>
    collections?: Record<string, KeyedCollectionDelta>
}

function sig(value: unknown): string | undefined {
    if (value === undefined) return undefined
    try {
        return JSON.stringify(value)
    } catch {
        return undefined
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Read the array at `path` (`a` or `a.b`) — undefined when absent. */
function readPath(doc: Record<string, unknown>, path: string): unknown {
    const [head, tail] = splitPath(path)
    if (!tail) return doc[head]
    const parent = doc[head]
    return isRecord(parent) ? parent[tail] : undefined
}

function splitPath(path: string): [string, string | undefined] {
    const dot = path.indexOf('.')
    return dot < 0 ? [path, undefined] : [path.slice(0, dot), path.slice(dot + 1)]
}

/**
 * The document minus its collections (a nested collection is removed from a
 * shallow copy of its parent, so the parent's other fields stay top-level data).
 */
function stripCollections(doc: Record<string, unknown>, spec: KeyedDocSpec): Record<string, unknown> {
    const out: Record<string, unknown> = { ...doc }
    for (const path of Object.keys(spec.collections)) {
        const [head, tail] = splitPath(path)
        if (!tail) {
            delete out[head]
            continue
        }
        const parent = out[head]
        if (!isRecord(parent) || !(tail in parent)) continue
        const copy = { ...parent }
        delete copy[tail]
        out[head] = copy
    }
    return out
}

function fieldSigsOf(digest: RowDigest): Map<string, string> {
    if (!digest.fieldSigs) {
        const sigs = new Map<string, string>()
        for (const [key, value] of Object.entries(digest.stable)) {
            const s = sig(value)
            if (s !== undefined) sigs.set(key, s)
        }
        digest.fieldSigs = sigs
    }
    return digest.fieldSigs
}

/** Digest one document. Cheap to hold: values are referenced, not copied. */
export function digestKeyedDoc(doc: Record<string, unknown>, spec: KeyedDocSpec): KeyedDocDigest {
    const top = new Map<string, string>()
    const topValues: Record<string, unknown> = {}
    const ignore = new Set(spec.ignore ?? [])
    const split = new Set(spec.splitObjects ?? [])
    const add = (path: string, value: unknown) => {
        if (ignore.has(path)) return
        const s = sig(value)
        if (s === undefined) return
        top.set(path, s)
        topValues[path] = value
    }
    for (const [key, value] of Object.entries(stripCollections(doc, spec))) {
        if (split.has(key) && isRecord(value)) {
            for (const [field, fieldValue] of Object.entries(value)) add(`${key}.${field}`, fieldValue)
            continue
        }
        add(key, value)
    }
    const collections = new Map<string, CollectionDigest>()
    for (const [path, idField] of Object.entries(spec.collections)) {
        const list = readPath(doc, path)
        if (!Array.isArray(list)) continue
        const rows = new Map<string, RowDigest>()
        const order: string[] = []
        for (const row of list) {
            if (!isRecord(row)) continue
            const id = row[idField]
            if (typeof id !== 'string' || !id || rows.has(id)) continue
            const stable = spec.stableRow ? spec.stableRow(path, row) : row
            rows.set(id, { value: row, stable, sig: sig(stable) ?? '' })
            order.push(id)
        }
        collections.set(path, { rows, order })
    }
    return { top, topValues, collections, volatile: new Set(spec.volatileTopLevel ?? []) }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
    return true
}

function diffCollection(prev: CollectionDigest | undefined, next: CollectionDigest | undefined, idField: string): KeyedCollectionDelta | null {
    if (!next) return prev ? { absent: true } : null
    const delta: KeyedCollectionDelta = {}
    const prevRows = prev?.rows ?? new Map<string, RowDigest>()
    const nextRows = next?.rows ?? new Map<string, RowDigest>()
    for (const [id, nextRow] of nextRows) {
        const prevRow = prevRows.get(id)
        if (!prevRow) {
            ;(delta.upsert ??= []).push(nextRow.value)
            continue
        }
        if (prevRow.sig === nextRow.sig) continue
        const prevSigs = fieldSigsOf(prevRow)
        const nextSigs = fieldSigsOf(nextRow)
        const change: Row = { [idField]: id }
        let changed = false
        for (const [key, s] of nextSigs) {
            if (key === idField || prevSigs.get(key) === s) continue
            change[key] = nextRow.value[key]
            changed = true
        }
        // A real change carries the row's volatile fields (dropped by stableRow) along.
        if (changed) {
            for (const [key, value] of Object.entries(nextRow.value)) {
                if (key in nextRow.stable || key in change) continue
                if (sig(prevRow.value[key]) !== sig(value)) change[key] = value
            }
        }
        const gone: string[] = []
        for (const key of prevSigs.keys()) if (!nextSigs.has(key) && !(key in nextRow.value)) gone.push(key)
        if (changed) (delta.upsert ??= []).push(change)
        if (gone.length > 0) (delta.unsetFields ??= {})[id] = gone
    }
    for (const id of prevRows.keys()) {
        if (!nextRows.has(id)) (delta.removed ??= []).push(id)
    }
    if (!sameOrder(prev?.order ?? [], next?.order ?? [])) delta.order = [...(next?.order ?? [])]
    return Object.keys(delta).length > 0 ? delta : null
}

/**
 * The difference `prev → next`, or `null` when nothing a consumer can observe
 * changed (volatile top-level fields alone are not a change).
 */
export function diffKeyedDoc(prev: KeyedDocDigest, next: KeyedDocDigest, spec: KeyedDocSpec): KeyedDocDelta | null {
    const delta: KeyedDocDelta = {}
    let meaningful = false
    let set: Record<string, unknown> | undefined
    let unset: string[] | undefined
    const split = spec.splitObjects ?? []
    const objectOf = (path: string): [string, string] | null => {
        for (const object of split) {
            if (path.startsWith(`${object}.`)) return [object, path.slice(object.length + 1)]
        }
        return null
    }
    const objects: NonNullable<KeyedDocDelta['objects']> = {}
    for (const [path, s] of next.top) {
        if (prev.top.get(path) === s) continue
        const inObject = objectOf(path)
        if (inObject) ((objects[inObject[0]] ??= {}).set ??= {})[inObject[1]] = next.topValues[path]
        else (set ??= {})[path] = next.topValues[path]
        if (!next.volatile.has(path)) meaningful = true
    }
    for (const path of prev.top.keys()) {
        if (next.top.has(path)) continue
        const inObject = objectOf(path)
        if (inObject) ((objects[inObject[0]] ??= {}).unset ??= []).push(inObject[1])
        else (unset ??= []).push(path)
        if (!next.volatile.has(path)) meaningful = true
    }
    for (const [path, idField] of Object.entries(spec.collections)) {
        const change = diffCollection(prev.collections.get(path), next.collections.get(path), idField)
        if (!change) continue
        ;(delta.collections ??= {})[path] = change
        meaningful = true
    }
    if (!meaningful) return null
    if (set) delta.set = set
    if (unset) delta.unset = unset
    if (Object.keys(objects).length > 0) delta.objects = objects
    return delta
}

function foldCollection(held: unknown, change: KeyedCollectionDelta, idField: string): Row[] {
    const byId = new Map<string, Row>()
    const heldOrder: string[] = []
    for (const row of Array.isArray(held) ? held : []) {
        if (!isRecord(row) || typeof row[idField] !== 'string') continue
        byId.set(row[idField] as string, row)
        heldOrder.push(row[idField] as string)
    }
    for (const id of change.removed ?? []) byId.delete(id)
    for (const row of change.upsert ?? []) {
        const id = row[idField]
        if (typeof id !== 'string') continue
        const base = byId.get(id)
        byId.set(id, base ? { ...base, ...row } : { ...row })
    }
    for (const [id, keys] of Object.entries(change.unsetFields ?? {})) {
        const base = byId.get(id)
        if (!base) continue
        const trimmed = { ...base }
        for (const key of keys) delete trimmed[key]
        byId.set(id, trimmed)
    }
    const order = change.order ?? heldOrder
    const out: Row[] = []
    const placed = new Set<string>()
    for (const id of order) {
        const row = byId.get(id)
        if (!row || placed.has(id)) continue
        out.push(row)
        placed.add(id)
    }
    for (const [id, row] of byId) if (!placed.has(id)) out.push(row)
    return out
}

/** Rebuild the full document from a held one plus a delta. Never mutates `held`. */
export function foldKeyedDoc<T extends Record<string, unknown>>(held: T, delta: KeyedDocDelta, spec: KeyedDocSpec): T {
    // Collections are re-inserted below from the held ones, so the plain fields
    // are folded on the stripped view (a nested parent keeps its other fields).
    const heldCollections = new Map<string, unknown>()
    for (const path of Object.keys(spec.collections)) heldCollections.set(path, readPath(held, path))
    const next: Record<string, unknown> = stripCollections(held, spec)
    for (const key of delta.unset ?? []) delete next[key]
    Object.assign(next, delta.set ?? {})
    for (const [object, change] of Object.entries(delta.objects ?? {})) {
        const folded: Record<string, unknown> = isRecord(next[object]) ? { ...(next[object] as Record<string, unknown>) } : {}
        for (const key of change.unset ?? []) delete folded[key]
        Object.assign(folded, change.set ?? {})
        next[object] = folded
    }
    for (const [path, idField] of Object.entries(spec.collections)) {
        const change = delta.collections?.[path]
        const heldList = heldCollections.get(path)
        if (change?.absent) {
            const [head, tail] = splitPath(path)
            if (!tail) delete next[head]
            continue
        }
        if (!change && heldList === undefined) continue
        const list = change ? foldCollection(heldList, change, idField) : heldList
        const [head, tail] = splitPath(path)
        if (!tail) {
            next[head] = list
            continue
        }
        const parent = isRecord(next[head]) ? { ...(next[head] as Record<string, unknown>) } : {}
        parent[tail] = list
        next[head] = parent
    }
    return next as T
}

/**
 * The `daemon.metadata` document (the snapshot body minus its envelope):
 * `status` is split field by field, its sessions keyed by `id`. `daemonId` is
 * envelope identity and `status.timestamp` the build clock — never diffed (the
 * fold re-stamps them from the frame); a session's `lastUpdated` build stamp is
 * not a change by itself.
 */
export const DAEMON_METADATA_DOC_SPEC: KeyedDocSpec = {
    collections: { 'status.sessions': 'id' },
    splitObjects: ['status'],
    ignore: ['daemonId', 'status.timestamp'],
    stableRow: (_collection, row) => {
        if (!('lastUpdated' in row)) return row
        const { lastUpdated: _stamp, ...stable } = row
        return stable
    },
}

/**
 * The `mesh.status` document: nodes keyed by `nodeId`, queue tasks and missions
 * by `id`. `refreshedAt` and `sourceOfTruth` (its aggregate-cache age /
 * returnedAt) are per-call stamps and the counters are live process tallies —
 * none of them is a change by itself.
 */
export const MESH_STATUS_DOC_SPEC: KeyedDocSpec = {
    collections: { nodes: 'nodeId', 'queue.tasks': 'id', missions: 'id' },
    volatileTopLevel: [
        'refreshedAt', 'sourceOfTruth',
        'turnPresentationCounters', 'meshProtocolV2Counters', 'pendingRetentionCounters', 'meshProtocolMetrics',
    ],
    stableRow: (collection, row) => (collection === 'nodes' ? stableMeshNodeRow(row) : row),
}

function without(value: unknown, keys: readonly string[]): unknown {
    if (!isRecord(value)) return value
    const out = { ...value }
    for (const key of keys) delete out[key]
    return out
}

/**
 * A mesh node minus the stamps an aggregate rebuild re-derives from the clock
 * (last-seen / updated / freshness age, the local read's check time, a local
 * facts bundle's reportedAt). A REMOTE node's `gitObservation.observedAt` is
 * real news (the member's own check time — the dashboard's "aged" hint) and
 * is compared; the coordinator's own / local checkout's is its read time.
 */
function stableMeshNodeRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row }
    delete out.lastSeenAt
    delete out.updatedAt
    delete out.last_seen_at
    delete out.updated_at
    if ('dataFreshness' in out) out.dataFreshness = without(out.dataFreshness, ['ageMs', 'lastProbeAt', 'staleness'])
    if ('connection' in out) out.connection = without(out.connection, ['lastStateChangeAt'])
    if ('git' in out) {
        const git = without(out.git, ['lastCheckedAt'])
        // "No submodules" is the same fact whether a read listed none or skipped the scan.
        if (isRecord(git) && Array.isArray(git.submodules) && git.submodules.length === 0) delete git.submodules
        out.git = git
    }
    if ('nodeFacts' in out) out.nodeFacts = without(out.nodeFacts, ['reportedAt'])
    const observation = out.gitObservation
    if (isRecord(observation) && (observation.source === 'self' || observation.source === 'local')) {
        out.gitObservation = without(observation, ['observedAt'])
    }
    return out
}
