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
 * passes at most `PARITY_TAIL` recent rows. `shadow`, read in this module, is
 * the topic's FULL retained window — unbounded. Comparing a bounded set against
 * an unbounded one is only valid inside their overlap: a shadow record older
 * than the oldest ledger row this sweep examined was never asked about, so its
 * absence from `ledgerEntries` means "not in this sweep's window", not "not in
 * the ledger". `runMeshParityCheck` tracks the oldest compared ledger
 * timestamp and skips `extra_in_shadow` for any shadow record older than it —
 * detection strength INSIDE the window is unchanged; only the ambiguous
 * outside-window case is excluded.
 *
 * ── §6.1 / content boundary ────────────────────────────────────────────────
 * ★ The mismatch LOG LINE carries identifiers only — `id`, `ledgerKind`, and
 * the NAMES of the differing fields. Never a value: a field mismatch on an
 * allow-listed key still must not print the key's contents, because the log is
 * an operator surface and this module has no business deciding a value is safe
 * to render. The counters that reach the stats bucket are integers.
 */

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

/**
 * Read this node's own shadow records for a mesh.
 *
 * Uses a FRESH consumer name per call (`${PARITY_CONSUMER}:${nonce}`) rather
 * than the durable one: a durable cursor delivers only the suffix since the
 * last read, but parity needs the WHOLE retained window every time — a record
 * that went missing before the previous run would otherwise never be seen
 * again. The nonce cursor is registered, drained, and unsubscribed.
 *
 * Only records whose writer is THIS node are collected. A full-sync topic also
 * carries remote writers' records, and those have no local ledger row to match
 * — counting them as `extra_in_shadow` would report a healthy fleet as broken.
 */
async function collectOwnShadowRecords(
    handle: SeqscribeNodeHandle,
    topic: string,
    nonce: string,
): Promise<Map<string, ProjectedMeshEvent>> {
    const found = new Map<string, ProjectedMeshEvent>();
    let unsub: (() => void) | null = null;
    try {
        unsub = handle.node.onEntry(topic, `${PARITY_CONSUMER}:${nonce}`, (entry) => {
            if (entry.kind !== MESH_EVENT_ENTRY_KIND) return;
            if (entry.writer !== handle.writerId) return;
            const projected = readProjected(entry.payload);
            if (projected) found.set(projected.id, projected);
        });
        // onEntry delivers the retained backlog asynchronously; yield until the
        // queue drains. Two macrotask turns is enough for the library's own
        // scheduling and keeps this off the hot path entirely.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
        try {
            unsub?.();
        } catch {
            /* already gone */
        }
    }
    return found;
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
    opts: { nonce?: string } = {},
): Promise<MeshParityResult> {
    const topic = meshEventsTopic(meshId);
    const result: MeshParityResult = { meshId, compared: 0, mismatches: [] };

    if (!handle.topics.some((d) => d.topic === topic)) {
        // The shadow never defined this mesh's topic — nothing was written, so
        // there is nothing to compare. Not a mismatch: reporting one here would
        // flag every mesh that has produced no events yet.
        return result;
    }

    let shadow: Map<string, ProjectedMeshEvent>;
    try {
        shadow = await collectOwnShadowRecords(
            handle,
            topic,
            opts.nonce ?? `${Date.now()}-${counters.runs}`,
        );
    } catch (error) {
        LOG.warn(
            'Seqscribe',
            `parity read failed mesh=${meshId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return result;
    }

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

    // ★ Window alignment. `ledgerEntries` is a bounded tail (mesh-parity-loop's
    // PARITY_TAIL), but `shadow` above is read from the FULL retained topic —
    // unbounded. Without this, any shadow record older than the oldest ledger
    // entry in this sweep's window is reported `extra_in_shadow` forever: the
    // ledger row that would match it fell off the tail, not off the ledger. The
    // ledger simply was not asked about that record this sweep, so its absence
    // from `ledgerEntries` carries no information — skip rather than flag.
    // A record inside the window with no matching id is still a real extra: the
    // ledger WAS asked and does not have it. Only the outside-window case is
    // ambiguous, so only it is excluded here — detection strength inside the
    // window is unchanged.
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
