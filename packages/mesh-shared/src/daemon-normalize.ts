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
