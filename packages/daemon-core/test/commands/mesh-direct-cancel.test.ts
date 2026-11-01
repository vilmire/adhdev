import { afterEach, describe, expect, it } from 'vitest';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { stopExactMeshWriter } from '../../src/commands/mesh-writer-stop.js';
import { turnLedgerIpcSpecs } from '../../src/commands/low-family/turn-ledger-ipc.js';
import { meshDirectCancel } from '../../src/commands/low-family/mesh-direct-cancel.js';

afterEach(() => { setActiveTurnLedger(null); MeshRuntimeStore.resetForTests(); });
let seq = 0;
const ctx: any = { deps: { statusInstanceId: 'test-daemon' } };

function fixture(scope: 'mesh_direct' | 'mesh_queue' = 'mesh_direct', stage: 'generating' | 'completed' = 'generating') {
    const meshId = `dc-${++seq}`, taskId = `${meshId}-task`, sessionId = `${meshId}-session`;
    const attempt = seedMeshAttempt({ meshId, taskId, sessionId, nodeId: 'node', providerType: 'codex-cli', stage, scope });
    // Writer host reports the session still live => stop stays pending (fail-closed), never force-released.
    const host: any = { adapters: new Map(), deps: { idleSessionLifetimeControl: { resolveHostBootId: () => 'host-boot-1' }, getInstanceManager: () => ({ getInstance: () => undefined }),
        listHostedCliRuntimes: async () => [{ runtimeId: sessionId }] } };
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'test-daemon', publisher: null, autoFlush: false,
        ports: { cancelDispatch: r => stopExactMeshWriter(host, r) } });
    setActiveTurnLedger(ledger);
    return { meshId, taskId, sessionId, attempt, ledger };
}

describe('mesh_direct_cancel daemon command', () => {
    it('is registered as an IPC-only command', () => {
        const spec = turnLedgerIpcSpecs.find(s => s.name === "mesh_direct_cancel");
        expect(spec?.sources).toEqual(["ipc", "standalone"]);
    });

    it('cancels a live direct attempt through the ledger and leaves a pending stop (no forced release)', async () => {
        const f = fixture();
        const res: any = await meshDirectCancel(ctx, { taskId: f.taskId });
        expect(res).toMatchObject({ success: true, noop: false });
        expect(res.attemptRef.attemptId).toBe(f.attempt.attemptId);
        const after = f.ledger.getAttempt(f.attempt.attemptId)!;
        expect(after.state).toBe('stopping');
        expect(after.terminal).toBeNull();
        expect(res.stopPending).toBe(true);
        expect(after.data.writerStop?.reason).toBe('operator_cancel');
    });

    it('accepts attemptId and an explicit cancel reason', async () => {
        const f = fixture();
        const res: any = await meshDirectCancel(ctx, { attemptId: f.attempt.attemptId, reason: 'superseded' });
        expect(res.success).toBe(true);
        expect(f.ledger.getAttempt(f.attempt.attemptId)!.data.writerStop?.reason).toBe('superseded');
    });

    it('unknown attempt/task answers an error', async () => {
        fixture();
        expect(await meshDirectCancel(ctx, { attemptId: 'nope' })).toMatchObject({ success: false, code: 'attempt_not_found' });
        expect(await meshDirectCancel(ctx, { taskId: 'nope' })).toMatchObject({ success: false, code: 'attempt_not_found' });
    });

    it('already-terminal attempt is a no-op', async () => {
        const f = fixture('mesh_direct', 'completed');
        const res: any = await meshDirectCancel(ctx, { taskId: f.taskId });
        expect(res).toMatchObject({ success: true, noop: true, state: 'completed' });
        expect(f.ledger.getAttempt(f.attempt.attemptId)!.state).toBe('completed');
    });

    it('is owner-only: an attempt owned by another daemon is refused, not forwarded', async () => {
        const f = fixture();
        const row = f.ledger.getAttempt(f.attempt.attemptId)!;
        MeshRuntimeStore.getInstance().turnStore().upsertAttempt({ ...row, ownerDaemonId: 'other-daemon' }, Date.now());
        const res: any = await meshDirectCancel(ctx, { attemptId: f.attempt.attemptId });
        expect(res).toMatchObject({ success: false, code: 'ledger_not_owner' });
        expect(f.ledger.getAttempt(f.attempt.attemptId)!.state).toBe('generating');
    });

    it('refuses queue attempts (they are cancelled with mesh_queue_cancel)', async () => {
        const f = fixture('mesh_queue');
        expect(await meshDirectCancel(ctx, { attemptId: f.attempt.attemptId })).toMatchObject({ success: false, code: 'not_direct_attempt' });
        expect(f.ledger.getAttempt(f.attempt.attemptId)!.state).toBe('generating');
    });

    it('rejects malformed requests', async () => {
        fixture();
        expect(await meshDirectCancel(ctx, {})).toMatchObject({ success: false, code: 'bad_request' });
        expect(await meshDirectCancel(ctx, { taskId: 'a', attemptId: 'b' })).toMatchObject({ success: false, code: 'bad_request' });
        expect(await meshDirectCancel(ctx, { taskId: 'a', reason: 'because I said so' })).toMatchObject({ success: false, code: 'bad_request' });
    });

    it('reports an unavailable ledger', async () => {
        expect(await meshDirectCancel(ctx, { taskId: 'a' })).toMatchObject({ success: false, code: 'turn_ledger_unavailable' });
    });
});
