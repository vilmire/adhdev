// ---------------------------------------------------------------------------
// turn-attempt-seed — seed / advance turn-ledger attempts for surface tests
// ---------------------------------------------------------------------------
// C-W8: the Stage 6 presentation (and every surface on it) reads the turn
// ledger's `turn_attempts` table. Surface tests are not reducer tests — the
// reducer has its own suites (test/turn-ledger/**) — so they seed rows straight
// through `TurnStore.upsertAttempt` in the SURFACE vocabulary (`waiting_approval`
// / `waiting_choice` become `suspended` + suspension, a terminal stage becomes
// a terminal row). `nowMs` stamps `updated_at`, the column the presentation's
// stale-authority gate reads.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { TurnAttempt, TurnScope } from '../../src/mesh/turn-ledger/types.js';
import type { TurnReason } from '@adhdev/mesh-shared';

export type SeedTurnStage =
    | 'accepted' | 'delivered' | 'consumed' | 'generating'
    | 'waiting_approval' | 'waiting_choice' | 'finalizing'
    | 'completed' | 'failed' | 'cancelled';

const TERMINAL: ReadonlySet<SeedTurnStage> = new Set(['completed', 'failed', 'cancelled']);
const RANK: Record<SeedTurnStage, number> = {
    accepted: 0, delivered: 1, consumed: 2, generating: 3, waiting_approval: 4, waiting_choice: 4, finalizing: 5,
    completed: 6, failed: 6, cancelled: 6,
};

export interface SeedMeshAttemptArgs {
    meshId: string;
    taskId: string;
    sessionId: string;
    providerType?: string;
    nodeId?: string | null;
    scope?: TurnScope;
    attemptNo?: number;
    attemptId?: string;
    stage?: SeedTurnStage;
    /** Stamps accepted_at / created_at / updated_at (and the stage timestamps). */
    nowMs?: number;
    terminalReason?: TurnReason;
}

function applyStage(attempt: TurnAttempt, stage: SeedTurnStage, nowMs: number, reason?: TurnReason): TurnAttempt {
    const next: TurnAttempt = { ...attempt };
    if (RANK[stage] >= 1 && next.deliveredAt === null) next.deliveredAt = nowMs;
    if (RANK[stage] >= 2 && next.consumedAt === null) next.consumedAt = nowMs;
    if (TERMINAL.has(stage)) {
        next.state = stage as TurnAttempt['state'];
        next.suspension = null;
        next.terminal = {
            outcome: stage as 'completed' | 'failed' | 'cancelled',
            reason: reason ?? (stage === 'cancelled' ? 'operator_cancel' : 'turn_end'),
            source: 'fsm_edge',
            strength: 'genuine',
            at: nowMs,
        };
    } else if (stage === 'waiting_approval' || stage === 'waiting_choice') {
        next.state = 'suspended';
        next.suspension = stage === 'waiting_choice' ? 'choice' : 'approval';
    } else {
        next.state = stage;
        next.suspension = null;
    }
    next.lastActivityAt = nowMs;
    return next;
}

/** Seed a mesh attempt (default scope `mesh_queue`, stage `accepted`). */
export function seedMeshAttempt(args: SeedMeshAttemptArgs): TurnAttempt {
    const nowMs = args.nowMs ?? Date.now();
    const attemptNo = args.attemptNo ?? 0;
    const base: TurnAttempt = {
        attemptId: args.attemptId ?? `${args.scope ?? 'mesh_queue'}:${args.meshId}:${args.taskId}:${attemptNo}:${randomUUID().slice(0, 6)}`,
        scope: args.scope ?? 'mesh_queue',
        meshId: args.meshId,
        taskId: args.taskId,
        attemptNo,
        sessionId: args.sessionId,
        nodeId: args.nodeId ?? null,
        providerType: args.providerType ?? null,
        ownerDaemonId: 'test-daemon',
        generation: 0,
        prevGeneration: null,
        dispatchNonce: null,
        messageId: null,
        consumeProfile: 'default',
        maxTaskRetries: 1,
        state: 'accepted',
        suspension: null,
        redriveCount: 0,
        reclaimCount: 0,
        hollowCount: 0,
        livenessFailStreak: 0,
        lastLiveness: null,
        coordinator: { daemonId: null, sessionId: null },
        acceptedAt: nowMs,
        deliveredAt: null,
        consumedAt: null,
        lastActivityAt: null,
        weakSince: null,
        candidateNotifiedGeneration: null,
        lastNoProgressNoticeAt: null,
        notifiedAt: null,
        terminal: null,
        data: {},
    };
    const attempt = applyStage(base, args.stage ?? 'accepted', nowMs, args.terminalReason);
    MeshRuntimeStore.getInstance().turnStore().upsertAttempt(attempt, nowMs);
    return attempt;
}

/** Move an existing attempt to a surface stage (a terminal stage commits it). */
export function advanceSeededAttempt(attemptId: string, stage: SeedTurnStage, opts: { nowMs?: number; reason?: TurnReason } = {}): TurnAttempt {
    const store = MeshRuntimeStore.getInstance().turnStore();
    const current = store.getAttempt(attemptId);
    if (!current) throw new Error(`advanceSeededAttempt: unknown attempt ${attemptId}`);
    const nowMs = opts.nowMs ?? Date.now();
    const next = applyStage(current, stage, nowMs, opts.reason);
    store.upsertAttempt(next, nowMs);
    return next;
}

/**
 * Seed a worker-MCP audit row (report / progress / handoff index) on
 * `turn_events`, creating its mesh attempt first when absent (C-W8: these rows
 * moved off the legacy `mesh_turn_events`, and now hang off a real attempt).
 * Each seeded attempt gets its own session so the one-open-attempt-per-session
 * index never collides across tests.
 */
export function seedWorkerEvent(args: {
    meshId: string;
    taskId: string;
    attemptId: string;
    kind: string;
    payload: Record<string, unknown>;
    dedupeKey?: string;
    eventId?: string;
    atMs?: number;
    sessionId?: string;
}): boolean {
    const store = MeshRuntimeStore.getInstance().turnStore();
    if (!store.getAttempt(args.attemptId)) {
        seedMeshAttempt({
            meshId: args.meshId,
            taskId: args.taskId,
            sessionId: args.sessionId ?? `sess-${args.attemptId}`,
            attemptId: args.attemptId,
            stage: 'generating',
            ...(args.atMs !== undefined ? { nowMs: args.atMs } : {}),
        });
    }
    return store.insertWorkerEvent({
        eventId: args.eventId ?? `evt-${randomUUID()}`,
        attemptId: args.attemptId,
        kind: args.kind,
        dedupeKey: args.dedupeKey ?? '',
        payload: args.payload,
        atMs: args.atMs ?? Date.now(),
    });
}
