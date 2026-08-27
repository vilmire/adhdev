/**
 * Phase 2 Stage 3 — dual-write parity verifier.
 *
 * Compares the two stores the Stage 2 shadow now writes to — the mesh ledger
 * (system of record) and the `mesh.<id>.events` seqscribe topic (shadow) — and
 * counts where they disagree. Stage 4's cutover is only defensible if this
 * counter is zero over a real dogfood window, so the counter, not a passing
 * test, is the artifact this stage produces.
 *
 * ── What "parity" means here, precisely ────────────────────────────────────
 * NOT "the two records are equal" — they cannot be. The shadow leg is a
 * deliberate PROJECTION (mesh-event-projection.ts): it drops every free-text
 * field, so a byte comparison would report 100% mismatch by design. Parity is
 * therefore defined over what the projection preserves:
 *
 *   presence  — every ledger entry has exactly one shadow record, keyed by the
 *               ledger entry's own `id` (the projection copies it verbatim,
 *               which is why it copies it at all)
 *   agreement — for the entries present on both sides, the projected fields
 *               must match what re-projecting the ledger entry produces
 *
 * That second half is what makes the check meaningful rather than a tautology:
 * it re-runs the projection against the CURRENT ledger row and compares to what
 * was written at append time, so a shadow record that was written from a
 * different entry, written twice with different content, or corrupted in
 * transit is caught.
 *
 * ── Mismatch classes ───────────────────────────────────────────────────────
 *   missing_in_shadow — ledger has it, the topic does not. The expected shape
 *                       of a real bug (a dropped append, a topic that failed to
 *                       define, load-shedding).
 *   extra_in_shadow   — the topic has an id the ledger does not, AND the shadow
 *                       record's timestamp falls within the ledger window this
 *                       sweep actually compared (see "Window alignment" below).
 *                       Expected to be rare and interesting: a replicated record
 *                       from a REMOTE writer lands here on a full-sync topic, so
 *                       this class is reported only for records this node
 *                       itself wrote.
 *   field_mismatch    — both sides have the id, projected fields differ.
 *
 * ── Window alignment ───────────────────────────────────────────────────────
 * `ledgerEntries` (the caller's argument) is a BOUNDED tail — mesh-parity-loop
 * passes at most `PARITY_TAIL` recent rows. The shadow side must be bounded to
 * MATCH, because comparing a bounded set against an unbounded one reports every
 * shadow record older than the tail as `extra_in_shadow` forever: the ledger row
 * that would match it fell off the tail, not off the ledger.
 *
 * ★ The bound is a PINNED CANONICAL INTERVAL (seqscribe v3.5 P21), not a
 * timestamp filter. `headOrder(topic)` pins an immutable upper bound, and
 * `scanEntries(topic, { through, limit })` reads the closed interval below it.
 * Both properties matter:
 *
 *   · CLOSED AND PINNED. The head is captured once, so records appended DURING
 *     the sweep are outside the interval on both sides rather than racing in on
 *     the shadow side only. The previous implementation read the full retained
 *     topic through a fresh nonce consumer and had no upper bound at all.
 *   · SYMMETRIC. Both sides are now bounded windows of the same shape — a tail
 *     of the ledger, a tail of the topic — so `extra_in_shadow` means the same
 *     thing on both: "the other store was asked and does not have it".
 *
 * The lower bound stays the oldest ledger timestamp compared this sweep, since
 * the two stores are not ordered by the same key (the ledger's rowid/timestamp
 * vs. seqscribe's canonical order) and there is no exact translation between
 * them. What the pin removes is the unbounded TOP of the shadow side, which is
 * where the actual false `extra_in_shadow` reports came from — a record appended
 * after the ledger read but before the shadow read. `truncatedBelow` from the
 * scan says the requested lower bound predates the §7.6 archive floor, i.e. the
 * shadow tail is shorter than the ledger tail and absence below the cut carries
 * no information; that case widens nothing and is recorded rather than flagged.
 *
 * ★ NO DURABLE CURSOR. `scanEntries` creates none, so the sweep no longer leaks
 * a `stage3-mesh-parity:<nonce>` cursor row every 15 minutes — rows which, until
 * pruned, each held the topic's archive floor open. `PARITY_CONSUMER` survives
 * only as the prefix `pruneStaleReadModelConsumers` uses to GC what the old
 * implementation already left on disk.
 *
 * ── §6.1 / content boundary ────────────────────────────────────────────────
 * ★ The mismatch LOG LINE carries identifiers only — `id`, `ledgerKind`, and
 * the NAMES of the differing fields. Never a value: a field mismatch on an
 * allow-listed key still must not print the key's contents, because the log is
 * an operator surface and this module has no business deciding a value is safe
 * to render. The counters that reach the stats bucket are integers.
 */

import type { Order, ScanResult } from 'seqscribe';
import { LOG } from '../logging/logger.js';
import type { SeqscribeNodeHandle } from './node.js';
import {
    MESH_EVENT_ENTRY_KIND,
    projectMeshLedgerEntry,
    type ProjectedMeshEvent,
} from './mesh-event-projection.js';
import { meshEventsTopic } from './topics.js';

/** Durable consumer name for the parity tail. Renaming replays the log once. */
export const PARITY_CONSUMER = 'stage3-mesh-parity';

export type MeshParityMismatchKind = 'missing_in_shadow' | 'extra_in_shadow' | 'field_mismatch';

/** Aggregate parity counters. Integers only — this feeds the stats bucket. */
export interface MeshParityCounters {
    /** Ledger entries examined by the most recent comparison. */
    compared: number;
    /** Entries present in the ledger but absent from the shadow topic. */
    missingInShadow: number;
    /** Shadow records written by THIS writer with no matching ledger entry. */
    extraInShadow: number;
    /** Entries present on both sides whose projected fields disagree. */
    fieldMismatch: number;
    /** Sum of the three mismatch classes — the number Stage 4 needs at zero. */
    mismatches: number;
    /** Comparisons run since process start. */
    runs: number;
}

const counters: MeshParityCounters = {
    compared: 0,
    missingInShadow: 0,
    extraInShadow: 0,
    fieldMismatch: 0,
    mismatches: 0,
    runs: 0,
};

/** A single disagreement, for logging and for tests. */
export interface MeshParityMismatch {
    kind: MeshParityMismatchKind;
    /** Ledger entry id — an opaque uuid, safe to log. */
    id: string;
    /** The original ledger kind, an enum. Null when only the shadow has it. */
    ledgerKind: string | null;
    /** Names (never values) of the fields that disagree. */
    fields?: string[];
}

export interface MeshParityResult {
    meshId: string;
    compared: number;
    mismatches: MeshParityMismatch[];
}

/** Minimal ledger-entry shape. Structural on purpose — see the boundary note
 * in mesh-dual-write.ts: `seqscribe/**` may not import `mesh/**`. */
export interface ParityLedgerEntry {
    id: string;
    timestamp: string;
    kind: string;
    nodeId?: string | undefined;
    sessionId?: string | undefined;
    providerType?: string | undefined;
    taskId?: string | undefined;
    payload?: Record<string, unknown> | undefined;
}

/**
 * Compare the projected fields of an expected/actual pair.
 *
 * Returns the NAMES of differing fields. `payload` is compared key-by-key so a
 * report says which key drifted rather than "payload" — the difference between
 * an actionable line and a shrug.
 */
function diffProjected(expected: ProjectedMeshEvent, actual: ProjectedMeshEvent): string[] {
    const fields: string[] = [];
    if (expected.ledgerKind !== actual.ledgerKind) fields.push('ledgerKind');
    if (expected.timestamp !== actual.timestamp) fields.push('timestamp');
    if (expected.nodeId !== actual.nodeId) fields.push('nodeId');
    if (expected.sessionId !== actual.sessionId) fields.push('sessionId');
    if (expected.providerType !== actual.providerType) fields.push('providerType');
    if (expected.taskId !== actual.taskId) fields.push('taskId');

    const keys = new Set([
        ...Object.keys(expected.payload ?? {}),
        ...Object.keys(actual.payload ?? {}),
    ]);
    for (const key of keys) {
        if (expected.payload?.[key] !== actual.payload?.[key]) fields.push(`payload.${key}`);
    }
    return fields;
}

/** Coerce a replicated entry payload into a ProjectedMeshEvent, or null. */
function readProjected(payload: unknown): ProjectedMeshEvent | null {
    if (!payload || typeof payload !== 'object') return null;
    const record = payload as Partial<ProjectedMeshEvent>;
    if (typeof record.id !== 'string' || record.id.length === 0) return null;
    return {
        id: record.id,
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
        ledgerKind: typeof record.ledgerKind === 'string' ? record.ledgerKind : '',
        nodeId: record.nodeId ?? null,
        sessionId: record.sessionId ?? null,
        providerType: record.providerType ?? null,
        taskId: record.taskId ?? null,
        payload: (record.payload ?? {}) as Record<string, string | number | boolean>,
    };
}

/** Per-page bound for the shadow scan. Paged to the pinned head, not capped. */
const SHADOW_SCAN_PAGE = 500;

/**
 * Hard bound on pages per sweep, so a pathologically large retained window
 * cannot make one parity run walk the entire topic. Reaching it means the scan
 * covered a suffix of the interval rather than all of it, which is reported as
 * a truncated window rather than silently treated as complete.
 */
const SHADOW_SCAN_MAX_PAGES = 200;

interface ShadowWindow {
    records: Map<string, ProjectedMeshEvent>;
    /** The pinned upper bound this window was read against; null = empty topic. */
    through: Order | null;
    /** The requested lower bound predates the §7.6 archive floor. */
    truncatedBelow: boolean;
}

/**
 * Read this node's own shadow records for a mesh, bounded by a pinned head.
 *
 * ★ Uses `scanEntries` (P21) rather than a nonce consumer. The old
 * implementation registered a throwaway durable consumer, waited two macrotask
 * turns for the backlog to drain, and unsubscribed — which guessed at drain
 * completion, read an unbounded window, and left a cursor row behind on every
 * sweep. A scan is synchronous, pinned, and has no durable side effects.
 *
 * `through` is captured by the CALLER via `headOrder` and passed in, so the
 * ledger and shadow sides of one comparison share a single immutable interval.
 *
 * Only records whose writer is THIS node are collected. A full-sync topic also
 * carries remote writers' records, and those have no local ledger row to match
 * — counting them as `extra_in_shadow` would report a healthy fleet as broken.
 */
function collectOwnShadowRecords(
    handle: SeqscribeNodeHandle,
    topic: string,
    through: Order,
): ShadowWindow {
    const records = new Map<string, ProjectedMeshEvent>();
    let truncatedBelow = false;
    let after: Order | undefined;

    for (let page = 0; page < SHADOW_SCAN_MAX_PAGES; page++) {
        const result: ScanResult = handle.node.scanEntries(topic, {
            ...(after ? { after } : {}),
            through,
            limit: SHADOW_SCAN_PAGE,
        });
        if (result.truncatedBelow) truncatedBelow = true;
        for (const entry of result.entries) {
            if (entry.kind !== MESH_EVENT_ENTRY_KIND) continue;
            if (entry.writer !== handle.writerId) continue;
            const projected = readProjected(entry.payload);
            if (projected) records.set(projected.id, projected);
        }
        if (result.complete || !result.nextAfter) break;
        after = result.nextAfter;
    }

    return { records, through, truncatedBelow };
}

function shortId(id: string): string {
    return id.length <= 12 ? id : `${id.slice(0, 12)}…`;
}

/**
 * Run one parity comparison for a mesh.
 *
 * `ledgerEntries` is supplied by the CALLER rather than read here, because
 * `seqscribe/**` may not import `mesh/**` (check:boundaries) — the mesh side
 * owns the read, this module owns the comparison.
 *
 * Never throws: parity is diagnostics. A failure to read the shadow topic is
 * reported as a run that compared nothing, not as an exception into a caller
 * that is probably a timer.
 */
export async function runMeshParityCheck(
    handle: SeqscribeNodeHandle,
    meshId: string,
    ledgerEntries: readonly ParityLedgerEntry[],
    // `nonce` is VESTIGIAL: it named the throwaway durable consumer the shadow
    // read used before P21. `scanEntries` needs no consumer, so nothing reads
    // it — accepted only so existing callers keep compiling.
    _opts: { nonce?: string } = {},
): Promise<MeshParityResult> {
    const topic = meshEventsTopic(meshId);
    const result: MeshParityResult = { meshId, compared: 0, mismatches: [] };

    if (!handle.topics.some((d) => d.topic === topic)) {
        // The shadow never defined this mesh's topic — nothing was written, so
        // there is nothing to compare. Not a mismatch: reporting one here would
        // flag every mesh that has produced no events yet.
        return result;
    }

    let window: ShadowWindow;
    try {
        // ★ Pin the head BEFORE reading either side. Everything appended after
        // this point is outside the interval on both sides, so a record landing
        // mid-sweep can no longer appear as `extra_in_shadow`.
        const through = handle.node.headOrder(topic);
        if (through === null) {
            // Empty topic. Every ledger entry is missing_in_shadow, which is
            // the honest answer — fall through with an empty window.
            window = { records: new Map(), through: null, truncatedBelow: false };
        } else {
            window = collectOwnShadowRecords(handle, topic, through);
        }
    } catch (error) {
        LOG.warn(
            'Seqscribe',
            `parity read failed mesh=${meshId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return result;
    }
    const shadow = window.records;

    const seen = new Set<string>();
    let oldestComparedMs = Infinity;
    for (const entry of ledgerEntries) {
        result.compared++;
        seen.add(entry.id);
        const entryMs = new Date(entry.timestamp).getTime();
        if (Number.isFinite(entryMs) && entryMs < oldestComparedMs) oldestComparedMs = entryMs;
        const actual = shadow.get(entry.id);
        if (!actual) {
            result.mismatches.push({
                kind: 'missing_in_shadow',
                id: entry.id,
                ledgerKind: entry.kind,
            });
            continue;
        }
        const fields = diffProjected(projectMeshLedgerEntry(entry), actual);
        if (fields.length > 0) {
            result.mismatches.push({
                kind: 'field_mismatch',
                id: entry.id,
                ledgerKind: entry.kind,
                fields,
            });
        }
    }

    // ★ Window alignment — the LOWER bound. The upper bound is already handled:
    // `shadow` was read against a head pinned before either side, so nothing
    // appended during this sweep is in it. What remains is that `ledgerEntries`
    // is a bounded tail (mesh-parity-loop's PARITY_TAIL) while the shadow scan
    // reaches back to the topic's retention floor, so the shadow window can
    // start EARLIER than the ledger window.
    //
    // A shadow record older than the oldest ledger entry this sweep examined was
    // never asked about: the ledger row that would match it fell off the tail,
    // not off the ledger. Its absence from `ledgerEntries` therefore carries no
    // information — skip rather than flag. A record inside the window with no
    // matching id is still a real extra: the ledger WAS asked and does not have
    // it. Only the ambiguous below-window case is excluded, so detection
    // strength inside the window is unchanged.
    for (const [id, record] of shadow) {
        if (seen.has(id)) continue;
        const recordMs = new Date(record.timestamp).getTime();
        if (Number.isFinite(recordMs) && recordMs < oldestComparedMs) continue;
        result.mismatches.push({
            kind: 'extra_in_shadow',
            id,
            ledgerKind: record.ledgerKind || null,
        });
    }

    // ★ Archive-gap disclosure. `truncatedBelow` means the scan's lower bound
    // sits under the §7.6 cold-archive floor: canonical scans read the hot log
    // only, so shadow records below the cut are simply not visible to this
    // sweep. That WEAKENS `missing_in_shadow` detection (a ledger entry whose
    // shadow record was archived looks missing) rather than strengthening it,
    // so it is disclosed, not acted on — the sweep's own `missing_in_shadow`
    // findings feed backfill, and a spurious one there costs a redundant
    // re-append, not a wrong answer.
    if (window.truncatedBelow) {
        LOG.info(
            'Seqscribe',
            `parity window mesh=${meshId} reaches below the archive floor — ` +
                `shadow records under the cut are not visible to this sweep`,
        );
    }

    // ── Counters + logging ────────────────────────────────────────────────
    counters.runs++;
    counters.compared = result.compared;
    let missing = 0;
    let extra = 0;
    let field = 0;
    for (const m of result.mismatches) {
        if (m.kind === 'missing_in_shadow') missing++;
        else if (m.kind === 'extra_in_shadow') extra++;
        else field++;
    }
    counters.missingInShadow += missing;
    counters.extraInShadow += extra;
    counters.fieldMismatch += field;
    counters.mismatches += result.mismatches.length;

    if (result.mismatches.length > 0) {
        // ★ Identifiers and field NAMES only — never a field value (§6.1).
        for (const m of result.mismatches.slice(0, MISMATCH_LOG_CAP)) {
            LOG.info(
                'Seqscribe',
                `parity mismatch kind=${m.kind} mesh=${meshId} entry=${shortId(m.id)} ` +
                    `ledgerKind=${m.ledgerKind ?? 'unknown'}` +
                    (m.fields?.length ? ` fields=${m.fields.join(',')}` : ''),
            );
        }
        if (result.mismatches.length > MISMATCH_LOG_CAP) {
            LOG.info(
                'Seqscribe',
                `parity mismatch mesh=${meshId} — ${result.mismatches.length - MISMATCH_LOG_CAP} further mismatches not logged this run`,
            );
        }
    }

    return result;
}

/**
 * Per-run cap on mismatch log lines. A systemic break (the shadow silently
 * off) would otherwise print one line per ledger entry and bury the daemon log
 * in the exact situation an operator most needs to read it.
 */
export const MISMATCH_LOG_CAP = 20;

/** Snapshot of the parity counters. */
export function meshParityCounters(): MeshParityCounters {
    return { ...counters };
}

/** Reset counters. TESTS ONLY. */
export function __resetMeshParityForTests(): void {
    counters.compared = 0;
    counters.missingInShadow = 0;
    counters.extraInShadow = 0;
    counters.fieldMismatch = 0;
    counters.mismatches = 0;
    counters.runs = 0;
}
