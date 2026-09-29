/**
 * Keyed status delta — the diff/fold pair behind the `daemon.metadata` lane
 * (the ONE daemon→dashboard state lane; data-path audit 2026-09-29 P0-3).
 *
 * The daemon digests every body it would have sent, diffs it against the
 * digest of the last body DELIVERED to a subscription, and sends only the
 * difference: changed top-level fields, changed daemon-level `status` fields,
 * and per-session changed fields keyed by session id, with removals explicit.
 * An unchanged state diffs to `null` — zero bytes on the wire. The dashboard
 * folds each delta into its held snapshot; the fold of every delta since a
 * snapshot equals the latest snapshot (pinned by keyed-status-delta.test.ts).
 *
 * Pure leaf: plain objects in, plain objects out; no transport, no clock.
 */

/** A session row: identified by `id`, everything else is a field. */
export interface KeyedStatusSession {
    id: string
    [field: string]: unknown
}

/** The snapshot body being diffed: top-level fields plus a `status` with a keyed session list. */
export interface KeyedStatusBody {
    status: { sessions: KeyedStatusSession[]; [field: string]: unknown }
    [field: string]: unknown
}

export interface KeyedStatusDigestOptions {
    /** Top-level keys that are never diffed (envelope identity: daemonId, …). */
    ignoreTopLevel?: readonly string[]
    /** `status` keys that are never diffed (in addition to `sessions`). */
    ignoreStatus?: readonly string[]
    /**
     * Session fields that change on every build without meaning anything
     * (a build-time `lastUpdated` stamp). A change to ONLY these fields is not
     * a change; when something else changed they ride along.
     */
    volatileSessionFields?: readonly string[]
}

interface SessionDigest {
    readonly value: KeyedStatusSession
    /** Signature of every non-volatile field (fast unchanged check). */
    readonly sig: string
    /** Per-field signatures, computed lazily — only for sessions that changed. */
    fieldSigs?: Map<string, string>
}

export interface KeyedStatusDigest {
    readonly top: ReadonlyMap<string, string>
    readonly topValues: Readonly<Record<string, unknown>>
    readonly status: ReadonlyMap<string, string>
    readonly statusValues: Readonly<Record<string, unknown>>
    readonly sessions: ReadonlyMap<string, SessionDigest>
    readonly order: readonly string[]
    readonly volatile: ReadonlySet<string>
}

export interface KeyedStatusDelta {
    set?: Record<string, unknown>
    unset?: string[]
    statusSet?: Record<string, unknown>
    statusUnset?: string[]
    sessions?: KeyedStatusSession[]
    sessionUnset?: Record<string, string[]>
    removedSessionIds?: string[]
    sessionOrder?: string[]
}

function sig(value: unknown): string | undefined {
    if (value === undefined) return undefined
    try {
        return JSON.stringify(value)
    } catch {
        return undefined
    }
}

function digestFields(
    source: Record<string, unknown>,
    ignore: ReadonlySet<string>,
): { sigs: Map<string, string>; values: Record<string, unknown> } {
    const sigs = new Map<string, string>()
    const values: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
        if (ignore.has(key)) continue
        const s = sig(value)
        if (s === undefined) continue
        sigs.set(key, s)
        values[key] = value
    }
    return { sigs, values }
}

function sessionSignature(session: KeyedStatusSession, volatile: ReadonlySet<string>): string {
    if (volatile.size === 0) return sig(session) ?? ''
    const stable: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(session)) {
        if (!volatile.has(key)) stable[key] = value
    }
    return sig(stable) ?? ''
}

function fieldSigsOf(digest: SessionDigest): Map<string, string> {
    if (!digest.fieldSigs) {
        const sigs = new Map<string, string>()
        for (const [key, value] of Object.entries(digest.value)) {
            const s = sig(value)
            if (s !== undefined) sigs.set(key, s)
        }
        digest.fieldSigs = sigs
    }
    return digest.fieldSigs
}

/** Digest one body. Cheap to hold: values are referenced, not copied. */
export function digestKeyedStatus(body: KeyedStatusBody, options: KeyedStatusDigestOptions = {}): KeyedStatusDigest {
    const volatile = new Set(options.volatileSessionFields ?? [])
    const top = digestFields(body as Record<string, unknown>, new Set(['status', ...(options.ignoreTopLevel ?? [])]))
    const status = digestFields(body.status, new Set(['sessions', ...(options.ignoreStatus ?? [])]))
    const sessions = new Map<string, SessionDigest>()
    const order: string[] = []
    for (const session of Array.isArray(body.status?.sessions) ? body.status.sessions : []) {
        if (!session || typeof session.id !== 'string' || !session.id) continue
        if (sessions.has(session.id)) continue
        sessions.set(session.id, { value: session, sig: sessionSignature(session, volatile) })
        order.push(session.id)
    }
    return { top: top.sigs, topValues: top.values, status: status.sigs, statusValues: status.values, sessions, order, volatile }
}

function diffFieldMaps(
    prev: ReadonlyMap<string, string>,
    next: ReadonlyMap<string, string>,
    nextValues: Readonly<Record<string, unknown>>,
): { set?: Record<string, unknown>; unset?: string[] } {
    let set: Record<string, unknown> | undefined
    let unset: string[] | undefined
    for (const [key, s] of next) {
        if (prev.get(key) === s) continue
        ;(set ??= {})[key] = nextValues[key]
    }
    for (const key of prev.keys()) {
        if (!next.has(key)) (unset ??= []).push(key)
    }
    return { ...(set ? { set } : {}), ...(unset ? { unset } : {}) }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
    return true
}

/**
 * The difference `prev → next`, or `null` when nothing a consumer can observe
 * changed. `prev === null` is not accepted here — a subscription with no
 * delivered baseline gets a snapshot, not a delta.
 */
export function diffKeyedStatus(prev: KeyedStatusDigest, next: KeyedStatusDigest): KeyedStatusDelta | null {
    const delta: KeyedStatusDelta = {}
    const top = diffFieldMaps(prev.top, next.top, next.topValues)
    if (top.set) delta.set = top.set
    if (top.unset) delta.unset = top.unset
    const status = diffFieldMaps(prev.status, next.status, next.statusValues)
    if (status.set) delta.statusSet = status.set
    if (status.unset) delta.statusUnset = status.unset

    for (const [id, nextSession] of next.sessions) {
        const prevSession = prev.sessions.get(id)
        if (!prevSession) {
            ;(delta.sessions ??= []).push(nextSession.value)
            continue
        }
        if (prevSession.sig === nextSession.sig) continue
        const prevSigs = fieldSigsOf(prevSession)
        const nextSigs = fieldSigsOf(nextSession)
        const change: KeyedStatusSession = { id }
        let changed = false
        for (const [key, s] of nextSigs) {
            if (key === 'id' || prevSigs.get(key) === s) continue
            change[key] = nextSession.value[key]
            changed = true
        }
        const gone: string[] = []
        for (const key of prevSigs.keys()) {
            if (!nextSigs.has(key)) gone.push(key)
        }
        if (changed) (delta.sessions ??= []).push(change)
        if (gone.length > 0) (delta.sessionUnset ??= {})[id] = gone
    }
    for (const id of prev.sessions.keys()) {
        if (!next.sessions.has(id)) (delta.removedSessionIds ??= []).push(id)
    }
    if (!sameOrder(prev.order, next.order)) delta.sessionOrder = [...next.order]

    return Object.keys(delta).length > 0 ? delta : null
}

/** Rebuild the full body from a held one plus a delta. Never mutates `held`. */
export function foldKeyedStatus<T extends KeyedStatusBody>(held: T, delta: KeyedStatusDelta): T {
    const next: Record<string, unknown> = { ...held }
    for (const key of delta.unset ?? []) delete next[key]
    Object.assign(next, delta.set ?? {})

    const status: Record<string, unknown> = { ...held.status }
    for (const key of delta.statusUnset ?? []) delete status[key]
    Object.assign(status, delta.statusSet ?? {})

    const byId = new Map<string, KeyedStatusSession>()
    for (const session of held.status.sessions ?? []) byId.set(session.id, session)
    for (const id of delta.removedSessionIds ?? []) byId.delete(id)
    for (const change of delta.sessions ?? []) {
        const base = byId.get(change.id)
        byId.set(change.id, base ? { ...base, ...change } : { ...change })
    }
    for (const [id, keys] of Object.entries(delta.sessionUnset ?? {})) {
        const base = byId.get(id)
        if (!base) continue
        const trimmed = { ...base }
        for (const key of keys) delete trimmed[key]
        byId.set(id, trimmed)
    }
    const order = delta.sessionOrder ?? (held.status.sessions ?? []).map((session) => session.id)
    const sessions: KeyedStatusSession[] = []
    const placed = new Set<string>()
    for (const id of order) {
        const session = byId.get(id)
        if (!session || placed.has(id)) continue
        sessions.push(session)
        placed.add(id)
    }
    for (const [id, session] of byId) {
        if (!placed.has(id)) sessions.push(session)
    }
    status.sessions = sessions
    next.status = status
    return next as T
}
