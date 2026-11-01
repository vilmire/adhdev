import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';

afterEach(() => { setActiveTurnLedger(null); MeshRuntimeStore.resetForTests(); });
let seq = 0;

/** A ledger whose stop port answers a canned absence receipt built from the exact request. */
function fixture(evidenceFor: (sessionId: string) => Record<string, unknown>) {
    const meshId = `hb-${++seq}`, taskId = `${meshId}-task`, sessionId = `${meshId}-session`;
    const attempt = seedMeshAttempt({ meshId, taskId, sessionId, nodeId: 'node', providerType: 'codex-cli', stage: 'generating', scope: 'mesh_direct' });
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'test-daemon', publisher: null, autoFlush: false,
        ports: { cancelDispatch: request => ({ ...request, success: true, quiescent: true, evidence: evidenceFor(request.sessionId), incarnation: 'inc-1' }) } });
    setActiveTurnLedger(ledger);
    ledger.observe({ eventId: meshId + '-stop', kind: 'cancel', source: 'operator', at: Date.now(), observedBy: 'test-daemon', sessionId,
        attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation }, reason: 'operator_cancel' });
    return { ledger, attempt };
}

describe('settleWriterStop: host_session_absent must name the host boot id', () => {
    it('settles when the absence evidence carries a non-empty hostBootId', async () => {
        const f = fixture(sessionId => ({ kind: 'host_session_absent', sessionId, hostBootId: 'host-boot-1', observedAt: 1 }));
        await vi.waitFor(() => expect(f.ledger.getAttempt(f.attempt.attemptId)?.terminal?.outcome).toBe('cancelled'));
    });

    it.each([
        ['missing (older host)', undefined],
        ['empty', ''],
        ['blank', '   '],
        ['non-string', 42],
    ])('stays pending (fail-closed) when hostBootId is %s', async (_label, hostBootId) => {
        const f = fixture(sessionId => ({ kind: 'host_session_absent', sessionId, observedAt: 1, ...(hostBootId === undefined ? {} : { hostBootId }) }));
        await new Promise(resolve => setTimeout(resolve, 50)); // let the (async) receipt reach settleWriterStop
        const after = f.ledger.getAttempt(f.attempt.attemptId)!;
        expect(after.state).toBe('stopping');
        expect(after.terminal).toBeNull();
    });

    it('does not require a boot id for non-absence evidence (native table proof)', async () => {
        const f = fixture(() => ({ kind: 'native_tree_gone' }));
        await vi.waitFor(() => expect(f.ledger.getAttempt(f.attempt.attemptId)?.terminal?.outcome).toBe('cancelled'));
    });
});
