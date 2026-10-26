import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { stopExactMeshWriter } from '../../src/commands/mesh-writer-stop.js';
import { settleQueueWriter } from '../../src/mesh/mesh-queue-retirement.js';
import { cancelTask, requeueTaskWithOutcome } from '../../src/mesh/mesh-work-queue.js';
import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js';
import { createTurnScheduler } from '../../src/mesh/turn-ledger/scheduler.js';
import { TURN_IPC_PROTOCOL_VERSION } from '@adhdev/mesh-shared';

afterEach(() => { setActiveTurnLedger(null); MeshRuntimeStore.resetForTests(); });
let seq = 0;
function fixture(mode: 'absent' | 'live' | 'unreachable', scope: 'mesh_queue' | 'mesh_direct' = 'mesh_queue') {
    const store = MeshRuntimeStore.getInstance(); const meshId = `dead-${mode}-${scope}-${++seq}`;
    const taskId = meshId + '-task', sessionId = meshId + '-session';
    store.insertQueueEntry({ id: taskId, meshId, message: 'work', status: 'assigned', assignedNodeId: 'node', assignedSessionId: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
    const attempt = seedMeshAttempt({ meshId, taskId, sessionId, nodeId: 'node', providerType: 'codex-cli', stage: 'generating', scope });
    const host: any = { adapters: new Map(), deps: { getInstanceManager: () => ({ getInstance: () => undefined }),
        listHostedCliRuntimes: async () => { if (mode === 'unreachable') throw new Error('offline'); return mode === 'live' ? [{ runtimeId: sessionId }] : []; } } };
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'test-daemon', publisher: null, autoFlush: false,
        ports: { cancelDispatch: r => stopExactMeshWriter(host, r) } });
    setActiveTurnLedger(ledger);
    ledger.observe({ eventId: meshId + '-stop', kind: 'cancel', source: 'operator', at: Date.now(), observedBy: 'test-daemon', sessionId,
        attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation }, reason: 'operator_cancel' });
    expect(ledger.getAttempt(attempt.attemptId)?.state).toBe('stopping');
    return { store, meshId, taskId, sessionId, attempt, ledger, setMode: (next: typeof mode) => { mode = next; } };
}
describe('rc32 verified dead writer retirement', () => {
    it('force retires a stopping attempt, audits host absence and releases the physical claim', async () => {
        const f = fixture('absent');
        expect(f.store.hasActiveAssignment(f.meshId, f.sessionId, 'node')).toBe(true);
        await settleQueueWriter(f.meshId, f.taskId, 'superseded');
        expect(f.ledger.getAttempt(f.attempt.attemptId)?.terminal?.reason).toBe('superseded');
        expect(requeueTaskWithOutcome(f.meshId, f.taskId, { force: true })?.entry.status).toBe('pending');
        expect(f.store.hasActiveAssignment(f.meshId, f.sessionId, 'node')).toBe(false);
        const events = f.store.db.prepare("SELECT payload_json FROM turn_events WHERE event_id LIKE 'writer_settled:%'").all() as any[];
        expect(events.some(e => JSON.parse(e.payload_json).writerStopReceipt?.evidence?.kind === 'host_session_absent')).toBe(true);
    });
    it.each(['mesh_queue', 'mesh_direct'] as const)('cancel converges an absent %s session to terminal', async scope => {
        const f = fixture('absent', scope); await settleQueueWriter(f.meshId, f.taskId, 'operator_cancel');
        expect(cancelTask(f.meshId, f.taskId)?.status).toBe('cancelled');
        expect(f.ledger.getAttempt(f.attempt.attemptId)?.terminal?.outcome).toBe('cancelled');
        expect(f.store.hasActiveAssignment(f.meshId, f.sessionId, 'node')).toBe(false);
    });
    it('periodically inspects escalated stops and converges after the host reports absence', async () => {
        const f = fixture('unreachable');
        const attempt = f.ledger.getAttempt(f.attempt.attemptId)!;
        attempt.data.writerStop!.tries = 3; attempt.data.writerStop!.escalated = true;
        f.store.turnStore().upsertAttempt(attempt, Date.now());
        f.setMode('absent');
        const scheduler = createTurnScheduler({ ledger: f.ledger });
        await scheduler.tick();
        await vi.waitFor(() => expect(f.ledger.getAttempt(f.attempt.attemptId)?.terminal?.outcome).toBe('cancelled'));
        scheduler.stop();
        expect(f.store.hasActiveAssignment(f.meshId, f.sessionId, 'node')).toBe(false);
    });
    it.each(['live', 'unreachable'] as const)('never retires a %s writer and cancel returns a useful error', async mode => {
        const f = fixture(mode); await settleQueueWriter(f.meshId, f.taskId, 'superseded');
        expect(f.ledger.getAttempt(f.attempt.attemptId)?.state).toBe('stopping');
        expect(requeueTaskWithOutcome(f.meshId, f.taskId, { force: true })?.refusal).toBeTruthy();
        expect(f.store.hasActiveAssignment(f.meshId, f.sessionId, 'node')).toBe(true);
        const result = await meshStoreIpcHandlers.queue_cancel({} as any, { v: TURN_IPC_PROTOCOL_VERSION, meshId: f.meshId, taskId: f.taskId });
        expect(result).toMatchObject({ success: false, code: 'writer_checkpoint_pending', error: expect.stringContaining('unknown, cannot prove dead') });
    });
});
