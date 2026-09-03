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
 * ── Failure handling ────────────────────────────────────────────────────
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
 * ── Quarantine (5a-4) ───────────────────────────────────────────────────────
 * A mesh enters quarantine after `QUARANTINE_FAILURE_THRESHOLD` (proposed
 * default: 5, see the constant) CONSECUTIVE `consumeRedriveEntry` failures.
 * While quarantined, `consumeRedriveEntry` returns `'quarantined'` instead of
 * throwing — the caller (mesh-terminal-redrive-consumer.ts) treats that the
 * same as a skip: the `onEntry` callback resolves, the durable cursor ADVANCES
 * past the entry, and the §7.6 archive floor releases on the next drain pass.
 * The unresolved notification is not re-armed by this path while quarantined —
 * it relies on the SAME dual-drive property that makes 5a safe at all: the
 * legacy outbox drain (or, post-5b, backfill/parity) is the other independent
 * path to the same terminal, so quarantining the redrive leg alone does not
 * silently lose the notification.
 *
 * "Auto-resolving": this is NOT a permanent park like the outbox's `failed`
 * status (which needs a human to clear). Once `QUARANTINE_COOLDOWN_MS` has
 * elapsed since the failure that triggered quarantine, the NEXT entry is let
 * through for a real attempt (half-open probe, one entry only). Success clears
 * quarantine (`consecutiveFailures` resets to 0, same as any other success);
 * failure re-arms quarantine with a fresh cooldown window. No operator action
 * is required either way — this is what makes it strictly better than WARN,
 * which only flagged the leak without stopping it.
 *
 * Quarantine state is in-memory only (same as the rest of `RedriveMeshState`),
 * so a daemon restart also clears it — consistent with "auto-resolving": a
 * restarted process starts each mesh's failure streak at zero rather than
 * inheriting a pre-restart quarantine that may no longer apply.
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

/**
 * Consecutive-failure threshold that quarantines a mesh's redrive leg (5a-4).
 *
 * ★ PROPOSED DEFAULT — the design doc (§11-3) decided quarantine itself but
 * left the exact threshold to the implementation. 5 is deliberately lower than
 * the legacy outbox's own park threshold (8, `drainTurnOutbox` maxAttempts in
 * mesh-turn-ledger.ts) — quarantine's cost here is an unbounded archive floor,
 * not merely a delayed notification, so erring toward tripping sooner is the
 * safer default. Revisit with real failure-rate data if it proves too eager.
 */
export const QUARANTINE_FAILURE_THRESHOLD = 5;

/**
 * Half-open cooldown (ms): how long a mesh stays quarantined before the next
 * entry is let through for a real (auto-resolving) probe attempt.
 *
 * ★ PROPOSED DEFAULT, same caveat as the threshold above. 60s is short enough
 * that a transient coordinator hiccup self-heals on a human timescale, and long
 * enough not to hammer a genuinely down coordinator every drain pass.
 */
export const QUARANTINE_COOLDOWN_MS = 60_000;

/** Per-mesh delivery state. Read by the 5a-3 coverage metrics and the 5a-4 quarantine policy. */
export interface RedriveMeshState {
    /** Entries this process handed to the pending queue (dedup may absorb them). */
    injected: number;
    /** Entries skipped as non-terminal or unusable. */
    skipped: number;
    /** Consecutive callback failures — the input to the 5a-4 quarantine policy. */
    consecutiveFailures: number;
    /** Epoch ms of the most recent failure, or null. */
    lastFailureAt: number | null;
    /** Entries skip-and-advanced because the mesh was quarantined at the time. */
    quarantineSkips: number;
    /**
     * Epoch ms when this mesh most recently ENTERED quarantine, or null if it
     * has never been quarantined. Distinct from `lastFailureAt`: this only
     * updates on the transition into quarantine, not on every failure inside
     * it, so it marks the start of the current cooldown window.
     */
    quarantinedAt: number | null;
}

const state = new Map<string, RedriveMeshState>();

function stateFor(meshId: string): RedriveMeshState {
    let s = state.get(meshId);
    if (!s) {
        s = {
            injected: 0,
            skipped: 0,
            consecutiveFailures: 0,
            lastFailureAt: null,
            quarantineSkips: 0,
            quarantinedAt: null,
        };
        state.set(meshId, s);
    }
    return s;
}

/** Snapshot of a mesh's redrive state, or null if it has never been touched. */
export function getRedriveState(meshId: string): RedriveMeshState | null {
    const s = state.get(meshId);
    return s ? { ...s } : null;
}

/**
 * Whether a mesh is CURRENTLY quarantined (past the failure threshold and
 * still inside the cooldown window). Exported so the consumer registration and
 * diagnostics can share one definition rather than re-deriving it.
 *
 * `nowMs` is a parameter (not `Date.now()` inline) so tests can drive the
 * half-open transition deterministically without a real 60s wait.
 */
export function isMeshQuarantined(meshId: string, nowMs: number = Date.now()): boolean {
    const s = state.get(meshId);
    if (!s || s.quarantinedAt === null) return false;
    return nowMs - s.quarantinedAt < QUARANTINE_COOLDOWN_MS;
}

/** Count of meshes currently quarantined. Feeds the diagnostics surface (5a-1/5a-3 pattern). */
export function getQuarantinedMeshCount(nowMs: number = Date.now()): number {
    let count = 0;
    for (const meshId of state.keys()) {
        if (isMeshQuarantined(meshId, nowMs)) count++;
    }
    return count;
}

/** Cumulative entries skip-and-advanced across every mesh because of quarantine. */
export function getTotalQuarantineSkips(): number {
    let total = 0;
    for (const s of state.values()) total += s.quarantineSkips;
    return total;
}

/**
 * Total entries this process has handed to the pending queue across every
 * mesh, since boot (or the last test reset). Feeds the 5a-3 coverage metric:
 * the outbox's own `delivered` counter (mesh-turn-ledger.ts) is likewise a
 * cross-mesh cumulative total on the same store, so the two are comparable
 * without a per-entry join — in dual-drive, a terminal the outbox delivered
 * is a terminal redrive also independently injected (whichever path wins the
 * dedup race, both attempted the injection; `injected` counts attempts that
 * reached the queue, not just the one dedup let through — see
 * `consumeRedriveEntry`, which increments `injected` on `queued === true`,
 * a case dedup collapse also satisfies).
 */
export function getTotalRedriveInjected(): number {
    let total = 0;
    for (const s of state.values()) total += s.injected;
    return total;
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
 *
 * ── Quarantine (5a-4) ────────────────────────────────────────────────────
 * If the mesh is currently quarantined (`isMeshQuarantined`), this entry is
 * skip-and-advanced WITHOUT attempting the injection — same rationale as the
 * non-terminal skip above: holding the cursor here would pin the §7.6 archive
 * floor open indefinitely. Once the cooldown elapses, the mesh naturally falls
 * out of quarantine (`isMeshQuarantined` returns false) and the very next
 * entry gets a real attempt — that IS the half-open probe; no separate probe
 * codepath is needed because a live topic keeps delivering new entries.
 */
export function consumeRedriveEntry(
    meshId: string,
    entry: RedriveProjectedEntry,
    nowMs: number = Date.now(),
): 'injected' | 'skipped' | 'quarantined' {
    const s = stateFor(meshId);

    if (isMeshQuarantined(meshId, nowMs)) {
        s.quarantineSkips++;
        LOG.warn(
            'MeshRedrive',
            `mesh=${meshId} redrive quarantined (consecutiveFailures=${s.consecutiveFailures}) — `
            + `skip-and-advance entry=${entry.id} to release the §7.6 archive floor; `
            + 'the legacy outbox drain remains the redelivery path for this terminal while quarantined',
        );
        return 'quarantined';
    }

    const injection = buildRedriveInjection(meshId, entry);
    if (!injection) {
        s.skipped++;
        return 'skipped';
    }

    let queued = false;
    try {
        queued = queuePendingMeshCoordinatorEvent(injection);
    } catch (error) {
        recordFailure(s, meshId, nowMs);
        throw error instanceof Error ? error : new Error(String(error));
    }

    if (!queued) {
        // The queue REJECTED the event (not a dedup collapse — that returns
        // true). Treat as transient: leave the cursor so it is retried.
        recordFailure(s, meshId, nowMs);
        throw new Error(`pending queue rejected redrive injection for task ${injection.metadataEvent.taskId}`);
    }

    s.consecutiveFailures = 0;
    s.quarantinedAt = null;
    s.injected++;
    LOG.debug(
        'MeshRedrive',
        `re-armed terminal ${entry.ledgerKind} entry=${entry.id} mesh=${meshId} — dedup collapses it onto the original if already delivered`,
    );
    return 'injected';
}

/**
 * Record one failure and, on crossing `QUARANTINE_FAILURE_THRESHOLD`, enter
 * quarantine. Only the THRESHOLD-CROSSING failure sets `quarantinedAt` — a
 * failure while already quarantined never reaches here (it is skip-and-
 * advanced above), so `quarantinedAt` marks exactly the start of a cooldown
 * window, never mid-window noise.
 */
function recordFailure(s: RedriveMeshState, meshId: string, nowMs: number): void {
    s.consecutiveFailures++;
    s.lastFailureAt = nowMs;
    if (s.consecutiveFailures >= QUARANTINE_FAILURE_THRESHOLD) {
        s.quarantinedAt = nowMs;
        LOG.warn(
            'MeshRedrive',
            `mesh=${meshId} redrive entering quarantine after ${s.consecutiveFailures} consecutive failures — `
            + `cooldown ${QUARANTINE_COOLDOWN_MS}ms before the next auto-resolving probe attempt`,
        );
    }
}

/** Reset all module state. TESTS ONLY. */
export function __resetTerminalRedriveForTests(): void {
    state.clear();
}
