import { describe, expect, it } from 'vitest';
import { runMeshStallTick, MESH_WORKER_STALL_IDLE_THRESHOLD_MS, type MeshStallHost } from '../../../src/providers/completion/mesh-stall-watchdog.js';

function host(status: string, withRef = true) {
    const emitted: any[] = [];
    const h = {
        instanceId: 'w1', type: 'codex-cli', startedAt: 0,
        adapter: { isAlive: () => true, getStatus: () => ({ status, lastOutputAt: 1_000 }), getLastApprovalResolvedAt: () => 0 },
        meshStallAnchorAt: 1_000, meshStallEmittedForAnchor: false, meshStallTurnActiveLast: false, meshStallLastFiredAt: -1,
        meshStallTranscriptSignalSampled: false, isMeshWorkerSession: () => true, hasAdapterPendingResponse: () => false,
        probeNativeTranscriptSignals: () => null, meshTraceCtx: () => ({}), completingTurnTaskId: () => 't', pushEvent: () => {},
        turnEvidencePort: { observe: (e: any) => { emitted.push(e); } },
        currentAttemptRef: () => (withRef ? { attemptId: 'a1', generation: 1 } : null),
    } as unknown as MeshStallHost & { emitted: any[] };
    (h as any).emitted = emitted;
    return h as MeshStallHost & { emitted: any[] };
}
const LATE = 1_000 + MESH_WORKER_STALL_IDLE_THRESHOLD_MS + 60_000;

describe('stall watchdog reports a parked prompt as turn evidence (reminder input)', () => {
    it('emits one no_progress observation with the waiting status, still not a monitor:no_progress event', () => {
        const h = host('waiting_approval');
        runMeshStallTick(h, LATE);
        expect(h.emitted).toHaveLength(1);
        expect(h.emitted[0]).toMatchObject({ kind: 'no_progress', observedStatus: 'waiting_approval', source: 'mesh_stall_watchdog' });
    });
    it('emits nothing without an attempt binding', () => {
        const h = host('waiting_approval', false);
        runMeshStallTick(h, LATE);
        expect(h.emitted).toHaveLength(0);
    });
});
