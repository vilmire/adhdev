/**
 * REDRAW-NUDGE × MESH-STALL-WATCH: the spec driver resize-wiggles a silent
 * generating screen long before the 180s+ stall watchdog. When no_progress
 * fires anyway, the event records how many redraw nudges already ran, so the
 * coordinator can tell "a repaint did not reveal idle" from an untried wedge.
 */
import { describe, it, expect } from 'vitest';
import {
    runMeshStallTick, MESH_WORKER_STALL_IDLE_THRESHOLD_MS, type MeshStallHost,
} from '../../../src/providers/completion/mesh-stall-watchdog.js';

function host(redrawNudges: number | undefined): MeshStallHost & { events: Record<string, unknown>[] } {
    const events: Record<string, unknown>[] = [];
    return {
        events,
        instanceId: 'sess-redraw-nudge',
        type: 'antigravity-cli',
        startedAt: 0,
        adapter: {
            isAlive: () => true,
            getStatus: () => ({ lastOutputAt: 1_000, status: 'generating' }),
            ...(redrawNudges === undefined ? {} : { getRedrawNudgeCount: () => redrawNudges }),
        },
        meshStallAnchorAt: 1_000,
        meshStallEmittedForAnchor: false,
        meshStallTurnActiveLast: false,
        meshStallLastFiredAt: -1,
        meshStallTranscriptSignalSampled: false,
        isMeshWorkerSession: () => true,
        hasAdapterPendingResponse: () => false,
        probeNativeTranscriptSignals: () => null,
        tryReconcileTranscriptCompletionForStall: () => false,
        meshTraceCtx: () => ({}),
        completingTurnTaskId: () => 'task-redraw',
        pushEvent: (e) => { events.push(e); },
    };
}

const PAST = 1_000 + MESH_WORKER_STALL_IDLE_THRESHOLD_MS + 1;

describe('mesh stall watchdog notes the redraw nudges that already ran', () => {
    it('carries redrawNudges from the adapter on monitor:no_progress', () => {
        const h = host(3);
        runMeshStallTick(h, PAST);
        const ev = h.events.find(e => e.event === 'monitor:no_progress');
        expect(ev?.redrawNudges).toBe(3);
    });

    it('reports 0 for adapters without the nudge (non-spec / older drivers)', () => {
        const h = host(undefined);
        runMeshStallTick(h, PAST);
        const ev = h.events.find(e => e.event === 'monitor:no_progress');
        expect(ev?.redrawNudges).toBe(0);
    });
});
