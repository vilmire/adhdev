import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { OPERATOR_RECOVERY_TARGET as t, RecoveryOwnerAdmission } from '@adhdev/session-host-core';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { RecoveryWitness } from '../../src/mesh/turn-ledger/operator-recovery-witness.js';
import { readRecoveryCurrentAssignment } from '../../src/mesh/turn-ledger/operator-recovery-store.js';
import { makeAttempt } from './fixtures.js';
import { getMeshConfigPath, withRecoveryMeshOwnershipFence } from '../../src/config/mesh-config-store.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { operatorRecoveryCommand } from '../../src/commands/low-family/operator-recovery.js';
import { applyRouterCommandIngressProvenance, issueTrustedOwnerIngressProof } from '../../src/commands/command-args.js';
import { SessionHostServer } from '../../../session-host-daemon/src/server.js';
import type { RecoveryPeerPort } from '../../src/mesh/turn-ledger/operator-recovery.js';
let originalConfig: string | undefined;
beforeEach(() => { originalConfig = process.env.ADHDEV_CONFIG_DIR; MeshRuntimeStore.resetForTests();
    process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'recovery-real-ledger-')); });
afterEach(() => { MeshRuntimeStore.resetForTests(); process.env.ADHDEV_CONFIG_DIR = originalConfig; });
function fixture() {
    const store = MeshRuntimeStore.getInstance(); const db = store.db;
    writeFileSync(getMeshConfigPath(), JSON.stringify({ meshes: [{ id: t.meshId, meshHost: { role: 'host', hostDaemonId: t.ownerDaemonId } }] }));
    expect(db.name.startsWith(process.env.ADHDEV_CONFIG_DIR!)).toBe(true);
    store.turnStore().upsertAttempt(makeAttempt('stopping', { ...t, scope: 'mesh_queue', attemptNo: 0,
        messageId: t.deliveryId, prevGeneration: null, data: { writerStop: { requestId: 'original-stop',
            reason: 'dispatch_failed', requestedAt: 100, tries: 3, escalated: true } } }), 1000);
    const payload = { id: t.taskId, meshId: t.meshId, status: 'assigned', title: 'Fixture only',
        assignedNodeId: t.nodeId, assignedSessionId: t.sessionId, dispatchNonce: t.dispatchNonce,
        createdAt: 'fixture-created', updatedAt: 'fixture-updated', difficulty: 'easy', mode: 'code_change' };
    db.prepare('INSERT INTO mesh_queue (id,mesh_id,status,assigned_node_id,assigned_session_id,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?,?)')
        .run(t.taskId, t.meshId, 'assigned', t.nodeId, t.sessionId, 'fixture-created', 'fixture-updated', JSON.stringify(payload));
    const pair = generateKeyPairSync('ed25519');
    const owner = new RecoveryOwnerAdmission({ publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        enrollmentId: 'fixture-owner-channel', coordinatorBootId: 'fixture-boot', authEpoch: '1', verifyCurrent: () => true });
    const grant = (operation: 'anchor_recover' | 'witness_enroll' = 'anchor_recover') => { const c = owner.challenge(operation); return owner.authorize(c.message, sign(null, Buffer.from(c.message), pair.privateKey).toString('hex')); };
    const witnessRoot = join(process.env.ADHDEV_CONFIG_DIR!, 'independent-witness');
    const witness = RecoveryWitness.enroll(witnessRoot, owner, grant('witness_enroll'));
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: t.ownerDaemonId, publisher: null, now: () => 1100 });
    const peer: RecoveryPeerPort = { peerId: t.workerDaemonId, connectionEpoch: 'fixture-channel',
        binding: { namespace: t.namespace, workerDaemonId: t.workerDaemonId, hostBootId: 'fixture-host-boot',
            endpoint: `/fixture/adhdev-preview-session-host-${t.namespace}.sock` },
        fenceDigest: 'f'.repeat(64), isCurrent: () => true,
        // Synthetic observation controls SQL integration; NOT physical evidence.
        async requestPhysicalProof(nonce) { return { ...peer.binding, nonce, fenceDigest: peer.fenceDigest,
            protocol: 1, verdict: 'ABSENT', reason: 'SYNTHETIC transaction control',
            sessionId: t.sessionId, providerSessionId: t.providerSessionId }; } };
    const recover = () => ledger.recoverOperatorAssertedLegacy({ owner, grant: grant(), peer, witness, coordinatorBootId: 'fixture-boot' });
    return { db, owner, grant, witness, witnessRoot, ledger, peer, recover };
}
describe.skipIf(process.platform === 'win32')('real runtime ledger operator recovery integration', () => {
    it('runs actual owner enrollment/command/SQLite ports and refuses the real native UNKNOWN collector', async () => {
        const f = fixture();
        setActiveTurnLedger(f.ledger);
        try {
            const root = mkdtempSync(join(tmpdir(), 'recovery-owner-native-'));
            const host = new SessionHostServer({ storageRootDir: root, instanceConfigDir: root });
            f.peer.requestPhysicalProof = async nonce => host.collectRecoveryCensus(nonce, f.peer.fenceDigest);
            const ctx = { deps: { statusInstanceId: t.ownerDaemonId, captureRecoveryPeer: () => f.peer } } as any;
            const args = (body: Record<string, unknown>) => {
                const proof = issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true,
                    nondelegatedLocalOwner: true, verifyCurrent: () => true });
                applyRouterCommandIngressProvenance({}, body, 'standalone', undefined, { ownerProof: proof }, false, 'operator_recovery');
                return body;
            };
            const enrolled = await operatorRecoveryCommand(ctx, args({ action: 'enroll' })) as any;
            expect(enrolled.success).toBe(true);
            const result = await operatorRecoveryCommand(ctx, args({ action: 'execute', message: enrolled.result.message,
                binding: f.peer.binding, fenceDigest: f.peer.fenceDigest }));
            expect(result.success).toBe(false); expect(result.error).toBe('recovery_physical_proof_refused');
            expect(f.ledger.getAttempt(t.attemptId)?.state).toBe('stopping');
            expect(f.db.prepare('SELECT status FROM mesh_queue WHERE id=?').get(t.taskId)).toEqual({ status: 'assigned' });
        } finally { setActiveTurnLedger(null); }
    });

    it('accepts bare config machine identity but rejects standalone and wrong-machine aliases on the actual owner reader', () => {
        const f = fixture();
        const owner = t.ownerDaemonId.slice('daemon_'.length);
        for (const [id, accepted] of [[owner, true], [t.ownerDaemonId, true], ['standalone_'+owner, false], ['daemon_'+t.ownerDaemonId, false], [owner.toUpperCase(), false]] as const) {
            writeFileSync(getMeshConfigPath(), JSON.stringify({meshes:[{id:t.meshId,meshHost:{role:'host',hostDaemonId:id}}]}));
            const read = () => withRecoveryMeshOwnershipFence(() => f.db.transaction(() => readRecoveryCurrentAssignment(f.db,t.ownerDaemonId)).immediate());
            if (accepted) expect(read().ownerDaemonId).toBe(t.ownerDaemonId);
            else expect(read).toThrow('current_mesh_owner_mismatch');
        }
    });

    it('commits actual queue failure/output/reducer/audit/nonce together, without a stop confirmation', async () => {
        const f = fixture(); await f.recover();
        const a = f.ledger.getAttempt(t.attemptId)!;
        expect(a.state).toBe('failed'); expect(a.terminal).toMatchObject({ outcome: 'failed', strength: 'genuine', reason: 'operator_update' });
        expect(a.data.writerStop?.confirmed).not.toBe(true);
        expect(f.db.prepare('SELECT status FROM mesh_queue WHERE id=?').get(t.taskId)).toEqual({ status: 'failed' });
        expect(f.db.prepare('SELECT state FROM operator_recovery_challenges_v1').get()).toEqual({ state: 'consumed' });
        const audit = f.db.prepare("SELECT payload_json FROM turn_events WHERE rule='operator_recovery_settled'").get() as any;
        expect(JSON.parse(audit.payload_json).operatorRecoveryAnchor.association).toBe('operator_asserted');
        expect(JSON.parse(audit.payload_json)).not.toHaveProperty('writerStopReceipt');
        expect(() => new RecoveryWitness(f.witnessRoot)).toThrow();
    });
    it('UNKNOWN leaves real task, writer and anchor unchanged', async () => {
        const f = fixture(); const original = f.peer.requestPhysicalProof;
        f.peer.requestPhysicalProof = async n => ({ ...await original(n), verdict: 'UNKNOWN' });
        await expect(f.recover()).rejects.toThrow('physical_proof_refused');
        expect(f.ledger.getAttempt(t.attemptId)?.state).toBe('stopping');
        expect(f.db.prepare('SELECT status FROM mesh_queue WHERE id=?').get(t.taskId)).toEqual({ status: 'assigned' });
        expect(f.db.prepare('SELECT COUNT(*) n FROM operator_recovery_anchors_v1').get()).toEqual({ n: 0 });
        f.witness.assertAvailable();
    });
    it('refuses a real persisted mesh-owner transfer during observation', async () => {
        const f = fixture(); const original = f.peer.requestPhysicalProof;
        f.peer.requestPhysicalProof = async n => {
            const r = await original(n);
            writeFileSync(getMeshConfigPath(), JSON.stringify({ meshes: [{ id: t.meshId, meshHost: { role: 'host', hostDaemonId: 'transferred-owner' } }] }));
            return r;
        };
        await expect(f.recover()).rejects.toThrow('current_mesh_owner_mismatch');
        expect(f.ledger.getAttempt(t.attemptId)?.state).toBe('stopping');
        f.witness.assertAvailable();
    });
    it('rejects persisted owner transfer-and-return ABA even if final owner fields match', async () => {
        const f = fixture(); const original = f.peer.requestPhysicalProof;
        f.peer.requestPhysicalProof = async n => {
            const r = await original(n); const old = readFileSync(getMeshConfigPath(), 'utf8');
            writeFileSync(getMeshConfigPath(), old.replace(t.ownerDaemonId, 'temporary-owner'));
            writeFileSync(getMeshConfigPath(), old);
            return r;
        };
        await expect(f.recover()).rejects.toThrow('expired_revoked_or_reassigned');
        expect(f.ledger.getAttempt(t.attemptId)?.state).toBe('stopping'); f.witness.assertAvailable();
    });
    it('rereads the actual SQL queue assignment after observation', async () => {
        const f = fixture(); const original = f.peer.requestPhysicalProof;
        f.peer.requestPhysicalProof = async n => { const r = await original(n); f.db.prepare('UPDATE mesh_queue SET assigned_session_id=? WHERE id=?').run('reassigned', t.taskId); return r; };
        await expect(f.recover()).rejects.toThrow(); expect(f.ledger.getAttempt(t.attemptId)?.state).toBe('stopping');
    });
    it('SQL failure rolls back every leg while the independent witness stays spent', async () => {
        const f = fixture(); f.db.exec("CREATE TRIGGER fail_fixture_queue BEFORE UPDATE ON mesh_queue BEGIN SELECT RAISE(ABORT,'fixture_queue_failure'); END;");
        await expect(f.recover()).rejects.toThrow('fixture_queue_failure');
        expect(f.ledger.getAttempt(t.attemptId)?.state).toBe('stopping');
        expect(f.db.prepare('SELECT COUNT(*) n FROM operator_recovery_anchors_v1').get()).toEqual({ n: 0 });
        expect(f.db.prepare("SELECT COUNT(*) n FROM turn_events WHERE rule='operator_recovery_settled'").get()).toEqual({ n: 0 });
        expect(readFileSync(join(f.witnessRoot, 'consumed.json'), 'utf8')).toContain(t.taskId);
        expect(() => new RecoveryWitness(f.witnessRoot)).toThrow();
    });
    it('actual assignment reader requires the transaction and returns latest retry truth', () => {
        const f = fixture(); expect(() => readRecoveryCurrentAssignment(f.db, t.ownerDaemonId)).toThrow('transaction_required');
        expect(withRecoveryMeshOwnershipFence(() => f.db.transaction(() => readRecoveryCurrentAssignment(f.db, t.ownerDaemonId)).immediate()).deliveryId).toBe(t.deliveryId);
        const newer = makeAttempt('accepted', { ...t, attemptId: t.attemptId + '-retry', attemptNo: 1, sessionId: 'new-session', messageId: 'new-delivery' });
        f.ledger.store.upsertAttempt(newer, 1200);
        expect(() => withRecoveryMeshOwnershipFence(() => f.db.transaction(() => readRecoveryCurrentAssignment(f.db, t.ownerDaemonId)).immediate())).toThrow('stopping_state_unsafe');
    });
});

for (const mode of ['missing-stop', 'confirmed', 'terminal', 'late-report', 'reclaimed']) {
    it(`refuses unsafe actual stopping SQL state: ${mode}`, async () => {
        const f = fixture();
        const row = f.db.prepare('SELECT data_json FROM turn_attempts WHERE attempt_id=?').get(t.attemptId) as any;
        const data = JSON.parse(row.data_json);
        if (mode === 'missing-stop') delete data.writerStop.requestId;
        if (mode === 'confirmed') data.writerStop.confirmed = true;
        if (mode === 'terminal') data.writerStop.terminal = { outcome: 'completed' };
        if (mode === 'late-report') data.report = { outcome: 'completed' };
        f.db.prepare('UPDATE turn_attempts SET data_json=?,reclaim_count=? WHERE attempt_id=?')
            .run(JSON.stringify(data), mode === 'reclaimed' ? 1 : 0, t.attemptId);
        await expect(f.recover()).rejects.toThrow();
        expect(f.ledger.getAttempt(t.attemptId)?.state).toBe('stopping'); f.witness.assertAvailable();
    });
}
it('detects an actual hold mutation during observation', async () => {
    const f = fixture(); const original = f.peer.requestPhysicalProof;
    f.peer.requestPhysicalProof = async n => {
        const proof = await original(n);
        f.db.prepare("INSERT INTO turn_holds (hold_id,attempt_id,generation,reason,on_expire,created_at) VALUES (?,?,0,'liveness','probe',100)").run('newhold', t.attemptId);
        return proof;
    };
    await expect(f.recover()).rejects.toThrow('expired_revoked_or_reassigned');
    expect(f.ledger.getAttempt(t.attemptId)?.state).toBe('stopping'); f.witness.assertAvailable();
});
