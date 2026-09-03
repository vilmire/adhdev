/**
 * Terminal-notification REDRIVE from the seqscribe replica (Stage 5a-2).
 *
 * Design: docs/design/2026-08-29-seqscribe-outbox-migration.md §4.3 (안 C).
 *
 * ── What this replaces, and what it does not ───────────────────────────────
 * The turn outbox (`mesh_turn_outbox`) carries TWO responsibilities that the
 * migration deliberately splits:
 *
 *   · REDELIVERY GUARANTEE — "a terminal that was committed but never reached
 *     the coordinator gets re-injected". THIS is what this consumer takes over.
 *   · PAYLOAD TRANSPORT — the prose (finalSummary, worker result) that the
 *     coordinator actually displays. That stays on the pending-events queue and
 *     is NOT touched here; free text never rides the replicated topic.
 *
 * So this consumer performs exactly the injection `drainMeshTurnOutbox` performs
 * (mesh-event-suppression.ts) — same target queue, same fingerprint inputs — and
 * differs only in `source`. It re-arms the ORIGINAL completion; it does not
 * carry it.
 *
 * ── Why it can be run alongside the outbox (5a's dual drive) ───────────────
 * Both paths inject into `queuePendingMeshCoordinatorEvent`, whose fingerprint
 * dedup collapses the second arrival onto the first. Whichever path fires first
 * wins; the other is absorbed. That is the same logic the outbox already relies
 * on for its own redeliveries ("a redelivery that collapses onto the original is
 * still delivered"), so dual drive needs no new dedup machinery — only that both
 * paths compute the SAME fingerprint.
 *
 * ★ That last clause is the whole reason Stage 5a-1 exists. The fingerprint keys
 * terminal completions `…::weak` / `…::genuine`, and the drain derives its half
 * from `payload.weak` on the outbox ROW. The replica has no such row, so `weak`
 * had to become a projected field on the ledger entry first. Reconstructing it
 * from the projected `evidenceLevel` would NOT be equivalent — see the
 * non-substitutability note in mesh-event-projection.ts and the §4.3 correction.
 *
 * ── Cursor naming ─────────────────────────────────────────────────────────
 * ★ The name must not collide with either GC prefix in
 * `pruneTopicConsumers` (seqscribe/mesh-read-model.ts): `stage4a-mesh-read-model#`
 * and `stage3-mesh-parity:`. A name matching one of those is deleted at every
 * boot, which silently rewinds this consumer to a full replay — re-injecting
 * every retained terminal — or, once its rows are gone, drops the redelivery
 * guarantee entirely. `REDRIVE_CONSUMER` is a distinct namespace with no `#`
 * or `:` suffix form, and `assertRedriveConsumerNameIsPruneSafe` pins it.
 *
 * ── Failure handling, and where quarantine will attach (5a-4) ─────────────
 * `onEntry` is at-least-once with a cursor that advances ONLY after the callback
 * resolves (SPEC §9); a throw leaves the cursor put and retries with backoff. We
 * therefore let an injection failure propagate: not advancing is what makes the
 * notification recoverable.
 *
 * ★ But a cursor that never advances is not free. A registered consumer gates
 * §7.6 archiving from the moment it registers (seqscribe/consume.ts), so a
 * permanently stuck cursor pins the topic's archive floor open and the retained
 * log grows without bound. That is a real resource leak, not merely a lost
 * notification — which is why the owner chose an auto-resolving QUARANTINE over
 * a WARN for the "permanent failure" signal that the outbox's `failed` park used
 * to provide (§11-3, decided 2026-09-03).
 *
 * Quarantine itself is 5a-4 and is NOT implemented here. What this file owes it
 * is a shape it can attach to, so the counters below (`consecutiveFailures`,
 * `lastFailureAt`) are tracked per mesh from the start: quarantine becomes a
 * policy read over that state plus a decision to skip-and-advance, rather than a
 * refactor of the delivery path.
 */

import { LOG } from '../logging/logger.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';

/**
 * Durable consumer name for the redrive tail.
 *
 * ★ Distinct from READ_MODEL_CONSUMER / PARITY_CONSUMER: a consumer name owns a
 * cursor, and two features sharing one would each advance it past the other's
 * unread entries — here that would mean silently skipping terminals.
 *
 * ★ Deliberately NOT prefixed `stage4a-mesh-read-model` or `stage3-mesh-parity`
 * in any form. See the cursor-naming note above.
 */
export const REDRIVE_CONSUMER = 'stage5a-mesh-terminal-redrive';

/** Env flag. Absent/anything-but-`on` = off, so the default is no behaviour change. */
export const REDRIVE_ENV = 'ADHDEV_SEQSCRIBE_TERMINAL_REDRIVE';

/**
 * Ledger kinds this consumer re-arms.
 *
 * Matches the outbox's own scope: `enqueueTerminalOutbox` is called only from
 * the reducer's committed-terminal branch, which fires for completed/failed.
 * `task_stalled` is deliberately excluded — the outbox never enqueued one, so
 * including it here would inject notifications the legacy path never produced,
 * which is a behaviour CHANGE rather than a migration.
 */
export const REDRIVEN_TERMINAL_KINDS: readonly string[] = ['task_completed', 'task_failed'];

/** Per-mesh delivery state. Read by the 5a-3 coverage metrics and, later, by 5a-4. */
export interface RedriveMeshState {
    /** Entries this process handed to the pending queue (dedup may absorb them). */
    injected: number;
    /** Entries skipped as non-terminal or unusable. */
    skipped: number;
    /** Consecutive callback failures — the input to the 5a-4 quarantine policy. */
    consecutiveFailures: number;
    /** Epoch ms of the most recent failure, or null. */
    lastFailureAt: number | null;
}

const state = new Map<string, RedriveMeshState>();

function stateFor(meshId: string): RedriveMeshState {
    let s = state.get(meshId);
    if (!s) {
        s = { injected: 0, skipped: 0, consecutiveFailures: 0, lastFailureAt: null };
        state.set(meshId, s);
    }
    return s;
}

/** Snapshot of a mesh's redrive state, or null if it has never been touched. */
export function getRedriveState(meshId: string): RedriveMeshState | null {
    const s = state.get(meshId);
    return s ? { ...s } : null;
}

/** Whether the redrive leg is enabled. Off unless explicitly turned on. */
export function isTerminalRedriveEnabled(env: Record<string, string | undefined>): boolean {
    return env[REDRIVE_ENV] === 'on';
}

/**
 * Guard the consumer name against the boot-time GC prefixes.
 *
 * Exported so the gate can assert it against the REAL prefixes rather than
 * against a copy — a duplicated literal would keep passing after someone renames
 * the read-model constant.
 */
export function assertRedriveConsumerNameIsPruneSafe(prunePrefixes: readonly string[]): void {
    for (const prefix of prunePrefixes) {
        if (REDRIVE_CONSUMER.startsWith(prefix)) {
            throw new Error(
                `redrive consumer name '${REDRIVE_CONSUMER}' matches boot-GC prefix '${prefix}' — `
                + 'it would be pruned on every boot, rewinding or dropping the redelivery cursor',
            );
        }
    }
}

/** The projected entry shape this consumer reads. Mirrors ProjectedMeshEvent. */
export interface RedriveProjectedEntry {
    id: string;
    ledgerKind: string;
    nodeId?: string | null;
    sessionId?: string | null;
    providerType?: string | null;
    taskId?: string | null;
    payload: Record<string, string | number | boolean>;
}

/**
 * Build the pending-event injection for a projected terminal entry.
 *
 * ★ Field-for-field equivalent to `drainMeshTurnOutbox`'s metadataEvent
 * (mesh-event-suppression.ts), because equality of the resulting FINGERPRINT is
 * what makes dual drive safe. The only intended difference is `source`, which is
 * not a fingerprint input and exists so the two paths are distinguishable in
 * diagnostics.
 *
 * Returns null when the entry cannot produce a well-formed injection, so the
 * caller can skip it rather than throwing (a malformed entry is not a transient
 * failure, and retrying it forever would pin the archive floor).
 */
export function buildRedriveInjection(
    meshId: string,
    entry: RedriveProjectedEntry,
): PendingMeshCoordinatorEvent | null {
    if (!REDRIVEN_TERMINAL_KINDS.includes(entry.ledgerKind)) return null;

    const taskId = entry.taskId
        || (typeof entry.payload.taskId === 'string' ? entry.payload.taskId : undefined);
    // The outbox row is keyed by task; an entry with no task id cannot be
    // re-armed against anything, and the drain would never have enqueued it.
    if (!taskId) return null;

    const event = typeof entry.payload.event === 'string'
        ? entry.payload.event
        : 'agent:generating_completed';
    const sessionId = entry.sessionId
        || (typeof entry.payload.sessionId === 'string' ? entry.payload.sessionId : undefined);
    const providerType = entry.providerType
        || (typeof entry.payload.providerType === 'string' ? entry.payload.providerType : undefined);
    const nodeId = entry.nodeId
        || (typeof entry.payload.nodeId === 'string' ? entry.payload.nodeId : undefined);

    const metadataEvent: Record<string, unknown> = {
        taskId,
        ...(sessionId ? { sessionId } : {}),
        ...(providerType ? { providerType } : {}),
        // Fingerprint parity with the drain: a weak original was stamped
        // evidenceLevel='insufficient'; a bare record reads as genuine. Sourced
        // from the projected `weak` (Stage 5a-1) — NOT recomputed from
        // evidenceLevel, which is not projected and would not be equivalent.
        ...(entry.payload.weak === true ? { evidenceLevel: 'insufficient' } : {}),
        source: 'seqscribe_redelivery',
        redriveRedelivery: true,
    };

    return {
        event,
        meshId,
        nodeId: nodeId || undefined,
        metadataEvent,
        queuedAt: Date.now(),
    } as PendingMeshCoordinatorEvent;
}

/**
 * Handle one projected entry. Throws on injection failure so the durable cursor
 * does NOT advance and the entry is retried.
 *
 * Non-terminal / unusable entries are skipped (cursor advances) — they are not
 * failures, and holding the cursor on one would stall every later terminal
 * behind it.
 */
export function consumeRedriveEntry(meshId: string, entry: RedriveProjectedEntry): 'injected' | 'skipped' {
    const s = stateFor(meshId);
    const injection = buildRedriveInjection(meshId, entry);
    if (!injection) {
        s.skipped++;
        return 'skipped';
    }

    let queued = false;
    try {
        queued = queuePendingMeshCoordinatorEvent(injection);
    } catch (error) {
        s.consecutiveFailures++;
        s.lastFailureAt = Date.now();
        throw error instanceof Error ? error : new Error(String(error));
    }

    if (!queued) {
        // The queue REJECTED the event (not a dedup collapse — that returns
        // true). Treat as transient: leave the cursor so it is retried.
        s.consecutiveFailures++;
        s.lastFailureAt = Date.now();
        throw new Error(`pending queue rejected redrive injection for task ${injection.metadataEvent.taskId}`);
    }

    s.consecutiveFailures = 0;
    s.injected++;
    LOG.debug(
        'MeshRedrive',
        `re-armed terminal ${entry.ledgerKind} entry=${entry.id} mesh=${meshId} — dedup collapses it onto the original if already delivered`,
    );
    return 'injected';
}

/** Reset all module state. TESTS ONLY. */
export function __resetTerminalRedriveForTests(): void {
    state.clear();
}
