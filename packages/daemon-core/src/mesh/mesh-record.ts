/**
 * meshRecord — the ONE write API for every NON-turn mesh event (wiring-
 * unification C3: "every other kind is `mesh.record` topic-only"; C-W9a
 * retired the ledger-append API, the event-ledger table and the JSONL mirror).
 *
 * Two legs, one call:
 *   1. TOPIC (always): the scalar projection on `mesh.<id>.events` — what every
 *      peer indexes into `mesh_topic_index` (the fleet view).
 *   2. LOCAL (`{ local }`): the FULL nested payload as a `mesh_local_records`
 *      row (mesh-local-record-store.ts) — refine results, MAGI synthesis,
 *      dispatch error text — that the projection drops. Local-only by
 *      construction: never published, never sent to the server. Written
 *      synchronously and in-process, so it works in a process with no
 *      seqscribe node armed (the mcp-server shares `mesh-runtime.db`; it can
 *      also reach it over the `record_local` IPC command).
 *
 * Content boundary: the record is projected through the existing allow-list
 * (`seqscribe/mesh-event-projection.ts` — ids, enums, booleans, counters,
 * ≤200-char scalars under PROJECTED_PAYLOAD_KEYS) before it reaches the
 * metadata-class `mesh.<id>.events` topic. Free text in `payload` is dropped
 * by construction; text that must travel goes to `mesh.<id>.handoff`.
 *
 * Turn outcomes are NOT records: they are `turn_events` rows written by the
 * turn ledger (`ledger.observe`) and published as `turn.*` entries.
 */

import { randomUUID } from 'crypto';
import { publishMeshRecord, publishMeshRecordAwaited, type MeshRecordEntry } from '../seqscribe/mesh-publisher.js';
import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshLedgerEntry, MeshLedgerKind } from './mesh-ledger.js';

/** Scalars a record may carry (anything else in `payload` is dropped by the projection). */
export interface MeshRecordScalars {
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    taskId?: string;
    payload?: Record<string, unknown>;
    /** Stable id (dedupe key for consumers); a fresh UUID when omitted. */
    id?: string;
    /** Epoch ms; now when omitted. */
    at?: number;
}

/**
 * `{ local: true }` keeps `scalars.payload` in full locally; `{ local: { payload } }`
 * keeps a different (usually richer) payload locally while `scalars.payload`
 * is what the topic projection sees.
 */
export interface MeshRecordOptions {
    local?: true | { payload: Record<string, unknown> };
}

export interface MeshRecordResult {
    eventId: string;
    /** ISO time the record carries (both legs). */
    timestamp: string;
    /** False when no seqscribe node is armed in this process or the record was refused (ERROR-logged). */
    published: boolean;
    /** True when the local row was written (only with `{ local }`). */
    storedLocally: boolean;
}

// LEDGER-TASK-TRACEABILITY (B), carried over from the retired ledger append: the kinds
// whose taskId base field is derived from payload.taskId when omitted, so every
// lifecycle record is joinable by kind + task_id (topic index and local rows).
const TASK_LIFECYCLE_KINDS: ReadonlySet<string> = new Set<MeshLedgerKind>([
    'task_dispatched', 'task_claimed', 'task_completed', 'task_failed', 'task_stalled', 'task_reclaimed',
    'task_approval_needed', 'task_approval_resolved', 'task_question_pending', 'p2p_dispatch_failed',
    'dispatch_failed', 'dispatch_duplicate_rebound', 'queue_hold_hard_deadline', 'redrive_provider_changed',
]);

function derivedTaskId(kind: string, scalars: MeshRecordScalars): string | undefined {
    if (scalars.taskId) return scalars.taskId;
    if (!TASK_LIFECYCLE_KINDS.has(kind)) return undefined;
    const value = scalars.payload?.taskId;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildMeshRecordEntry(kind: string, scalars: MeshRecordScalars): MeshRecordEntry {
    const eventId = scalars.id ?? randomUUID();
    const taskId = derivedTaskId(kind, scalars);
    return {
        id: eventId,
        timestamp: new Date(scalars.at ?? Date.now()).toISOString(),
        kind,
        ...(scalars.nodeId ? { nodeId: scalars.nodeId } : {}),
        ...(scalars.sessionId ? { sessionId: scalars.sessionId } : {}),
        ...(scalars.providerType ? { providerType: scalars.providerType } : {}),
        ...(taskId ? { taskId } : {}),
        ...(scalars.payload ? { payload: scalars.payload } : {}),
    };
}

let loggedLocalFailure = false;

/** The local leg: one `mesh_local_records` row. Never throws (one WARN on the first failure). */
function storeLocal(meshId: string, entry: MeshRecordEntry, payload: Record<string, unknown>): boolean {
    try {
        return MeshRuntimeStore.getInstance().localRecordStore().insert({
            eventId: entry.id,
            meshId,
            kind: entry.kind,
            nodeId: entry.nodeId ?? null,
            sessionId: entry.sessionId ?? null,
            providerType: entry.providerType ?? null,
            taskId: entry.taskId ?? null,
            atMs: Date.parse(entry.timestamp),
            payload,
        });
    } catch (e: any) {
        if (!loggedLocalFailure) {
            loggedLocalFailure = true;
            LOG.warn('MeshRecord', `local record write failed (kind ${entry.kind}, mesh ${meshId}): ${e?.message ?? String(e)}`);
        }
        return false;
    }
}

function localPayload(scalars: MeshRecordScalars, opts: MeshRecordOptions): Record<string, unknown> | null {
    if (!opts.local) return null;
    return opts.local === true ? (scalars.payload ?? {}) : opts.local.payload;
}

// C-W8: operating notes live in `mesh_operating_notes` (mesh-operating-notes.ts);
// a note written as a record would be invisible to every reader, so it is refused.
const REFUSED_KINDS: ReadonlySet<string> = new Set(['coordinator_operating_note', 'coordinator_operating_note_tombstone']);

/**
 * Record one non-turn mesh event: the scalar projection on `mesh.<meshId>.events`
 * (`mesh.record`) and — with `{ local }` — the full payload locally. Never throws;
 * an operating-note kind is refused (WARN, nothing written).
 */
export function meshRecord(meshId: string, kind: string, scalars: MeshRecordScalars = {}, opts: MeshRecordOptions = {}): MeshRecordResult {
    const entry = buildMeshRecordEntry(kind, scalars);
    if (REFUSED_KINDS.has(kind)) {
        LOG.warn('MeshRecord', `'${kind}' is not a record kind — use recordOperatingNote / forgetOperatingNote (mesh-operating-notes.ts)`);
        return { eventId: entry.id, timestamp: entry.timestamp, published: false, storedLocally: false };
    }
    const local = localPayload(scalars, opts);
    const storedLocally = local ? storeLocal(meshId, entry, local) : false;
    let published = false;
    try {
        published = publishMeshRecord(meshId, entry);
    } catch {
        /* the topic leg must never affect the local write */
    }
    return { eventId: entry.id, timestamp: entry.timestamp, published, storedLocally };
}

/** The local row a `{ local }` record produced, in the reader shape (tests / callers that echo it). */
export function meshRecordAsEntry(meshId: string, kind: string, scalars: MeshRecordScalars, result: MeshRecordResult): MeshLedgerEntry {
    const taskId = derivedTaskId(kind, scalars);
    return {
        id: result.eventId,
        meshId,
        timestamp: result.timestamp,
        kind: kind as MeshLedgerKind,
        ...(scalars.nodeId ? { nodeId: scalars.nodeId } : {}),
        ...(scalars.sessionId ? { sessionId: scalars.sessionId } : {}),
        ...(scalars.providerType ? { providerType: scalars.providerType } : {}),
        ...(taskId ? { taskId } : {}),
        payload: scalars.payload ?? {},
    };
}

export interface MeshRecordAppendResult {
    eventId: string;
    /** The entry's append coordinate on `mesh.<meshId>.events`; null when it was not appended (no node / refused / rejected). */
    appended: { topic: string; writer: string; seq: number } | null;
}

/**
 * `meshRecord`, awaiting the append so the caller gets the real coordinate
 * (the `mesh_record` IPC response's `seq`). Never rejects.
 */
export async function meshRecordAppended(meshId: string, kind: string, scalars: MeshRecordScalars = {}, opts: MeshRecordOptions = {}): Promise<MeshRecordAppendResult> {
    const entry = buildMeshRecordEntry(kind, scalars);
    const local = localPayload(scalars, opts);
    if (local) storeLocal(meshId, entry, local);
    const id = await publishMeshRecordAwaited(meshId, entry);
    return {
        eventId: entry.id,
        appended: id ? { topic: String(id[0]), writer: String(id[1]), seq: Number(id[2]) } : null,
    };
}
