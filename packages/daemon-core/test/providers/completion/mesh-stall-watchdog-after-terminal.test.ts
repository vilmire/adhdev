/**
 * STALL-AFTER-TERMINAL: the mesh stall watchdog kept evaluating a worker whose
 * task had already completed — seen live as
 * `[drop:mesh_worker_stall_transcript_advancing]` ~3 min after the completion on
 * a remote worker (its attempt row lives on the owner, so the Stage-6
 * terminal-stage re-arm never engages there). Once the session has emitted a
 * GENUINE completion for its task and no new busy episode has started, a quiet
 * screen is an idle worker: re-arm quietly, never trace or fire.
 */
import { describe, it, expect } from 'vitest';
import {
    runMeshStallTick, MESH_WORKER_STALL_IDLE_THRESHOLD_MS, type MeshStallHost,
} from '../../../src/providers/completion/mesh-stall-watchdog.js';

type Host = MeshStallHost & { events: Record<string, unknown>[]; transcriptProbes: number };

function host(opts: {
    latch?: { taskId: string; weak: boolean; emittedAtEpoch: number } | null;
    busyEpoch?: number;
    taskId?: string;
    turnActive?: boolean;
}): Host {
    const h: Host = {
        events: [],
        transcriptProbes: 0,
        instanceId: 'sess-after-terminal',
        type: 'claude-cli',
        startedAt: 0,
        adapter: {
            isAlive: () => true,
            getStatus: () => ({ lastOutputAt: 1_000, status: 'idle' }),
            getLastApprovalResolvedAt: () => 0,
        },
        meshStallAnchorAt: 1_000,
        meshStallEmittedForAnchor: false,
        meshStallTurnActiveLast: opts.turnActive ?? false,
        meshStallLastFiredAt: -1,
        meshStallTranscriptSignalSampled: false,
        isMeshWorkerSession: () => true,
        hasAdapterPendingResponse: () => opts.turnActive ?? false,
        probeNativeTranscriptSignals: () => { h.transcriptProbes++; return null; },
        meshTraceCtx: () => ({}),
        completingTurnTaskId: () => opts.taskId,
        pushEvent: (e) => { h.events.push(e); },
        lastEmittedCompletion: opts.latch ?? null,
        busyEpoch: opts.busyEpoch ?? 3,
    };
    return h;
}

const PAST = 1_000 + MESH_WORKER_STALL_IDLE_THRESHOLD_MS + 1;
const noProgress = (h: Host) => h.events.filter((e) => e.event === 'monitor:no_progress');

describe('mesh stall watchdog skips a task that already completed', () => {
    it('genuine completion for the stamped task, no turn since → quiet re-arm (no probe, no event)', () => {
        const h = host({ latch: { taskId: 'task-done', weak: false, emittedAtEpoch: 3 }, busyEpoch: 3, taskId: 'task-done' });
        runMeshStallTick(h, PAST);
        expect(noProgress(h)).toHaveLength(0);
        expect(h.transcriptProbes).toBe(0);
        expect(h.meshStallAnchorAt).toBe(PAST);
    });

    it('the stamp already cleared (launched member detached) → still quiet', () => {
        const h = host({ latch: { taskId: 'task-done', weak: false, emittedAtEpoch: 3 }, busyEpoch: 3, taskId: undefined });
        runMeshStallTick(h, PAST);
        expect(noProgress(h)).toHaveLength(0);
        expect(h.transcriptProbes).toBe(0);
    });

    it('a WEAK completion keeps the watchdog armed (the backstop it still serves)', () => {
        const h = host({ latch: { taskId: 'task-weak', weak: true, emittedAtEpoch: 3 }, busyEpoch: 3, taskId: 'task-weak' });
        runMeshStallTick(h, PAST);
        expect(noProgress(h)).toHaveLength(1);
    });

    it('a new busy episode since the completion (a new turn) keeps the watchdog armed', () => {
        const h = host({ latch: { taskId: 'task-done', weak: false, emittedAtEpoch: 3 }, busyEpoch: 4, taskId: 'task-done' });
        runMeshStallTick(h, PAST);
        expect(noProgress(h)).toHaveLength(1);
    });

    it('a different task now stamped keeps the watchdog armed', () => {
        const h = host({ latch: { taskId: 'task-old', weak: false, emittedAtEpoch: 3 }, busyEpoch: 3, taskId: 'task-new' });
        runMeshStallTick(h, PAST);
        expect(noProgress(h)).toHaveLength(1);
    });

    it('no completion emitted yet → unchanged behaviour (fires)', () => {
        const h = host({ latch: null, taskId: 'task-running' });
        runMeshStallTick(h, PAST);
        expect(noProgress(h)).toHaveLength(1);
    });
});
