/**
 * Canonical coordinator/daemon-id form normalizer shared by daemon-core (the mesh
 * reconcile loop, pending-event queue, and MCP surface) — the daemon-id counterpart
 * of node-normalize.ts.
 *
 * A daemon answers to the SAME machine under three interchangeable id forms, all
 * derived from one `mach_<hex>` machine id:
 *  - bare        — `mach_<hex>` (loadConfig().machineId; stamped by the local
 *                  queue-assignment dispatch path)
 *  - cloud       — `daemon_mach_<hex>` (the coordinator mesh node's config-form
 *                  daemonId, which the MCP layer's resolveCoordinatorDaemonId
 *                  prefers and stamps onto a worker's meshCoordinatorDaemonId)
 *  - standalone  — `standalone_mach_<hex>` (a standalone daemon's status instanceId)
 *
 * A worker's completion event is scoped (`coordinator_daemon_id`) with whichever
 * form the dispatch path happened to stamp, but the coordinator that later drains /
 * surfaces that event resolves its OWN id through a different path and frequently
 * holds a DIFFERENT form. Because the scope filter is an exact-string match
 * (`coordinator_daemon_id IS NULL OR IN (...)` in SQL, `.includes()` in JS), a
 * completion stamped `daemon_mach_X` is silently skipped by a coordinator whose
 * self-id set only contains bare `mach_X` (or standalone form) — the event never
 * surfaces and the coordinator is never auto-notified, while NULL-scoped events
 * (e.g. worktree bootstrap) always pass via the `IS NULL` branch.
 *
 * This module is the single source of truth that collapses the three forms to one
 * machine core and EXPANDS a self-id set to every equivalent form, so a scope match
 * succeeds regardless of which form stamped the event. Expansion stays WITHIN a
 * single machine core (`daemon_mach_X` only ever expands to other `mach_X` forms),
 * so an event scoped to a DIFFERENT coordinator is never falsely claimed.
 */

import { readString } from './json'

const DAEMON_ID_PREFIXES = ['daemon_', 'standalone_'] as const

/**
 * A daemon DO addressed by a raw 64-hex DO id (`idFromString`) rather than by a
 * canonical name (`idFromName("daemon_mach_<hex>")`). Decide by FORMAT, not by
 * length — the canonical name is 43+ chars, so a `length > 32` heuristic would
 * misclassify it. Mirrors the server's session-routing `isRawDoId`.
 */
export function isRawDaemonDoId(id: string | null | undefined): boolean {
    const trimmed = readString(id)
    return !!trimmed && /^[0-9a-f]{64}$/i.test(trimmed)
}

/** The machine-evidence fields a real daemon reports about its hardware. */
export interface DaemonMachineEvidence {
    machineNickname?: string | null
    nickname?: string | null
    hostname?: string | null
    platform?: string | null
    machineId?: string | null
    machine?: { hostname?: string | null; platform?: string | null } | null
    sessions?: unknown[] | null
}

/**
 * A phantom daemon entry — a UI surface must not offer it as a real machine.
 *
 * Symptom block for the raw-DO-id ghost (GHOST-MACHINE-REGISTRATIONS). When the
 * `X-ADHDEV-Daemon` instanceId header is missing or unparseable, the /ws handler
 * falls back to a random DO name, so every reconnect mints a FRESH raw 64-hex DO
 * id. Those keys accumulate as hardware-less entries that render as a bare hash
 * where a machine name belongs.
 *
 * BOTH conditions are required, and the second is what keeps this safe:
 *   1. the id is a raw DO id — no `daemon_`/`standalone_` canonical prefix.
 *   2. no machine evidence at all — no nickname, hostname, platform, registered
 *      machineId, and no sessions.
 *
 * A legacy / not-yet-reauthed daemon that ACTUALLY reports itself fails (2) and
 * therefore still renders, still attaches, and still routes — dropping on (1)
 * alone would make real daemons disappear from the picker. This is strictly a
 * PRESENTATION filter: routing tables (server `lastStatuses`, P2P relay) keep
 * the entry, because the raw key still resolves via `idFromString`.
 *
 * The server applies the same rule to its dashboard payloads via
 * `_unresolvedIdentity` (UserSession.isPhantomMachineEntry). That marker is
 * server-internal and never reaches the browser, and the client daemon store
 * never evicts an entry once injected — so a client surface reading the merged
 * P2P/WS store must re-derive the verdict from the entry SHAPE. This function is
 * that shared rule.
 */
export function isPhantomDaemonEntry(
    entry: (DaemonMachineEvidence & { id?: string | null }) | null | undefined,
): boolean {
    if (!entry) return false
    if (!isRawDaemonDoId(entry.id)) return false
    const hasMachineEvidence = Boolean(
        readString(entry.machineNickname)
        || readString(entry.nickname)
        || readString(entry.hostname)
        || readString(entry.platform)
        || readString(entry.machine?.hostname)
        || readString(entry.machine?.platform)
        || readString(entry.machineId)
        || (Array.isArray(entry.sessions) && entry.sessions.length > 0),
    )
    return !hasMachineEvidence
}

/**
 * Reduce any daemon-id form to its machine core: strips a leading `daemon_` /
 * `standalone_` prefix, leaving the bare `mach_<hex>` (or returning a non-prefixed
 * id unchanged). Returns undefined for an empty/absent id.
 */
export function machineCoreFromDaemonId(id: string | null | undefined): string | undefined {
    const trimmed = readString(id)
    if (!trimmed) return undefined
    for (const prefix of DAEMON_ID_PREFIXES) {
        if (trimmed.startsWith(prefix)) {
            const core = trimmed.slice(prefix.length).trim()
            return core || undefined
        }
    }
    return trimmed
}

/**
 * Canonicalize any daemon-id form to the single CANON producer form
 * `daemon_mach_<core>` (the cloud `daemon_` form).
 *
 * CANON-IDENTITY double-dispatch root cause: the coordinator daemon id is stamped
 * onto a worker dispatch by TWO independent producers — the MCP-side
 * resolveCoordinatorDaemonId (which prefers the coordinator mesh node's config-form
 * `daemon_mach_X` daemonId) and the daemon-core queue dispatch (which stamps the
 * bare `loadConfig().machineId` = `mach_X`). When the SAME coordinator dispatches
 * the same task down both paths, the two worker sessions are stamped with two
 * DIFFERENT coordinator-id forms; a raw-string dedup that should recognise "this
 * task is already dispatched by me" fails, and the task runs twice.
 *
 * The durable fix is comparator-side (daemonIdsEquivalent / expandDaemonIdForms),
 * but unifying every PRODUCER on one canonical form shrinks the surface so even a
 * raw `===` agrees. The canon is the cloud `daemon_` form because that is what the
 * coordinator mesh node's config-form daemonId already carries and what the cloud
 * P2P signaling layer registers a daemon under — so canonicalizing the bare/standalone
 * fallback forms makes them consistent with the already-working primary path.
 *
 * Only a `mach_<…>` core is rewritten; an arbitrary/non-machine id (e.g. a custom
 * node id) is returned unchanged so it is never ballooned into a spurious `daemon_`
 * form. Idempotent. Returns undefined for an empty/absent id.
 */
export function canonicalDaemonId(id: string | null | undefined): string | undefined {
    const core = machineCoreFromDaemonId(id)
    if (!core) return undefined
    if (!core.startsWith('mach_')) return core
    return `daemon_${core}`
}

/** True when both ids resolve to the same machine core — i.e. they are the same
 *  daemon under different id forms. False when either side is empty. */
export function daemonIdsEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
    const coreA = machineCoreFromDaemonId(a)
    const coreB = machineCoreFromDaemonId(b)
    if (!coreA || !coreB) return false
    return coreA === coreB
}

/**
 * Expand a set of coordinator/daemon ids to every equivalent form, so an
 * exact-string scope filter (SQL `IN (...)` or JS `.includes()`) matches a
 * completion stamped in any form of the same machine. The original ids are kept in
 * their input order and FIRST (callers that treat `[0]` as the primary — e.g.
 * per-daemon JSONL file naming — keep their original primary); the derived
 * `mach_<hex>` / `daemon_mach_<hex>` / `standalone_mach_<hex>` forms are appended.
 *
 * Derived prefixed forms are emitted ONLY for a core that looks like a real machine
 * id (`mach_<…>`), so arbitrary/test ids (e.g. `node-daemon-id`) are passed through
 * untouched and never balloon into spurious forms. Result is de-duplicated.
 */
export function expandDaemonIdForms(
    ids: string | null | undefined | ReadonlyArray<string | null | undefined>,
): string[] {
    const list = Array.isArray(ids) ? ids : ids != null ? [ids] : []
    const out: string[] = []
    const seen = new Set<string>()
    const add = (value: string | undefined): void => {
        if (!value || seen.has(value)) return
        seen.add(value)
        out.push(value)
    }
    // Pass 1: originals first, in input order (preserve caller's primary at [0]).
    for (const raw of list) add(readString(raw))
    // Pass 2: derived machine-core forms for any id that resolves to a `mach_` core.
    for (const raw of list) {
        const core = machineCoreFromDaemonId(readString(raw))
        if (!core || !core.startsWith('mach_')) continue
        add(core)
        for (const prefix of DAEMON_ID_PREFIXES) add(`${prefix}${core}`)
    }
    return out
}
