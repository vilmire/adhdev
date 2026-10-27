import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { generateKeyPairSync, sign } from 'node:crypto';
import { RecoveryOwnerAdmission, OPERATOR_RECOVERY_TARGET as target } from '@adhdev/session-host-core';
import { OperatorRecoveryAnchors, type RecoveryCurrentAssignment, type RecoveryPeerPort } from '../../src/mesh/turn-ledger/operator-recovery.js';

function fixture() {
    const db = new Database(':memory:');
    const pair = generateKeyPairSync('ed25519');
    let now = 100; let currentOwner = true; let currentPeer = true; let witness = true;
    const admission = new RecoveryOwnerAdmission({
        publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        enrollmentId: 'separate-owner-signer', coordinatorBootId: 'coordinator-boot', authEpoch: 'auth-1',
        verifyCurrent: () => currentOwner,
    }, () => now);
    const grant = () => {
        const c = admission.challenge();
        return admission.authorize(c.message, sign(null, Buffer.from(c.message), pair.privateKey).toString('hex'));
    };
    // Disposable state and explicitly FAKE physical proof; no real host or socket.
    let assignment: RecoveryCurrentAssignment = { ...target, state: 'stopping', queueStatus: 'assigned',
        queueNodeId: target.nodeId, queueSessionId: target.sessionId,
        ownerRevision: 'owner-rev-1', queueRevision: 'queue-rev-1' };
    const ledger = new OperatorRecoveryAnchors({ db, owner: admission, coordinatorBootId: 'coordinator-boot',
        readCurrentAssignment: () => { expect(db.inTransaction).toBe(true); return assignment; },
        assertAntiRollback: () => { if (!witness) throw Error('witness_missing'); }, clock: () => now });
    const peer: RecoveryPeerPort = {
        peerId: target.workerDaemonId, connectionEpoch: 'peer-epoch-1', fenceDigest: 'f'.repeat(64),
        binding: { namespace: target.namespace, workerDaemonId: target.workerDaemonId, hostBootId: 'worker-boot',
            endpoint: `/fixture/adhdev-preview-session-host-${target.namespace}.sock` },
        isCurrent: () => currentPeer,
        async requestPhysicalProof(nonce) { return { ...peer.binding, protocol: 1, verdict: 'ABSENT', reason: 'FAKE physical proof',
            nonce, fenceDigest: peer.fenceDigest, sessionId: target.sessionId, providerSessionId: target.providerSessionId }; },
    };
    return { db, admission, grant, ledger, peer, pair,
        setNow: (n: number) => { now = n; }, revokeOwner: () => { currentOwner = false; },
        revokePeer: () => { currentPeer = false; }, revokeWitness: () => { witness = false; },
        reassign: (over: Partial<RecoveryCurrentAssignment>) => { assignment = { ...assignment, ...over }; } };
}

describe('exact operator recovery admission and consumption', () => {
    it('rejects ordinary IPC/MCP objects and copied grants; accepts enrolled signer only', () => {
        const f = fixture();
        try {
            for (const forgery of [{ ownerVerified: true }, { source: 'standalone' }, { purpose: 'operator_recovery_v1' }, {}])
                expect(() => f.admission.assertGrant(forgery)).toThrow();
            const g = f.grant(); f.admission.assertGrant(g);
            expect(() => f.admission.assertGrant({ ...g })).toThrow();
            f.admission.consume(g); expect(() => f.admission.assertGrant(g)).toThrow();
        } finally { f.db.close(); }
    });
    it('burns failed signatures and rejects wrong signer and expired owner challenge', () => {
        const f = fixture();
        try {
            const c = f.admission.challenge(); const other = generateKeyPairSync('ed25519');
            expect(() => f.admission.authorize(c.message, sign(null, Buffer.from(c.message), other.privateKey).toString('hex'))).toThrow();
            expect(() => f.admission.authorize(c.message, sign(null, Buffer.from(c.message), f.pair.privateKey).toString('hex'))).toThrow();
            const next = f.admission.challenge(); f.setNow(30100);
            expect(() => f.admission.authorize(next.message, sign(null, Buffer.from(next.message), f.pair.privateKey).toString('hex'))).toThrow();
        } finally { f.db.close(); }
    });
    it('consumes one operator_asserted anchor atomically, with no stop receipt', async () => {
        const f = fixture();
        try {
            const anchor = await f.ledger.recover(f.grant(), f.peer);
            expect(f.ledger.ownsAnchor(anchor)).toBe(true);
            expect(f.ledger.ownsAnchor(JSON.parse(JSON.stringify(anchor)))).toBe(false);
            expect(anchor.association).toBe('operator_asserted'); expect(anchor).not.toHaveProperty('writerStopReceipt');
            expect(f.db.prepare('SELECT state FROM operator_recovery_challenges_v1').get()).toEqual({ state: 'consumed' });
            await expect(f.ledger.recover(f.grant(), f.peer)).rejects.toThrow('already_consumed');
            expect(f.db.prepare('SELECT COUNT(*) AS n FROM operator_recovery_anchors_v1').get()).toEqual({ n: 1 });
        } finally { f.db.close(); }
    });
    for (const [key, value] of Object.entries({ ownerDaemonId: 'other', taskId: 'other', attemptId: 'other',
        generation: 1, dispatchNonce: 2, sessionId: 'other', nodeId: 'other', deliveryId: 'other', meshId: 'other',
        queueNodeId: 'other', queueSessionId: 'other', state: 'generating', queueStatus: 'completed',
        queueRevision: 'reassigned', ownerRevision: 'owner-transferred' })) {
        it(`rechecks ${key} in the consumption transaction after observation`, async () => {
            const f = fixture();
            try {
                const original = f.peer.requestPhysicalProof;
                f.peer.requestPhysicalProof = async nonce => { const p = await original(nonce); f.reassign({ [key]: value }); return p; };
                await expect(f.ledger.recover(f.grant(), f.peer)).rejects.toThrow();
                expect(f.db.prepare('SELECT COUNT(*) AS n FROM operator_recovery_anchors_v1').get()).toEqual({ n: 0 });
                expect(f.db.prepare('SELECT state FROM operator_recovery_challenges_v1').get()).toEqual({ state: 'revoked' });
            } finally { f.db.close(); }
        });
    }
    for (const [key, value] of Object.entries({ verdict: 'UNKNOWN', protocol: 2, nonce: 'replay', hostBootId: 'prior-boot',
        providerSessionId: 'wrong-provider', sessionId: 'wrong-session', workerDaemonId: 'other-peer', namespace: '',
        endpoint: 'other-endpoint', fenceDigest: 'old-fence' })) {
        it(`refuses physical proof ${key}=${value}`, async () => {
            const f = fixture();
            try {
                const original = f.peer.requestPhysicalProof;
                f.peer.requestPhysicalProof = async nonce => ({ ...await original(nonce), [key]: value } as any);
                await expect(f.ledger.recover(f.grant(), f.peer)).rejects.toThrow('physical_proof_refused');
                expect(f.db.prepare('SELECT COUNT(*) AS n FROM operator_recovery_anchors_v1').get()).toEqual({ n: 0 });
            } finally { f.db.close(); }
        });
    }
    for (const scenario of ['expiry', 'clock-rollback', 'peer-revoked', 'owner-revoked', 'witness-missing', 'explicit-revoke', 'db-replay']) {
        it(`refuses ${scenario} during an in-flight query`, async () => {
            const f = fixture();
            try {
                const original = f.peer.requestPhysicalProof;
                f.peer.requestPhysicalProof = async nonce => {
                    const p = await original(nonce);
                    if (scenario === 'expiry') f.setNow(30100);
                    if (scenario === 'clock-rollback') f.setNow(99);
                    if (scenario === 'peer-revoked') f.revokePeer();
                    if (scenario === 'owner-revoked') f.revokeOwner();
                    if (scenario === 'witness-missing') f.revokeWitness();
                    if (scenario === 'explicit-revoke') f.ledger.revoke();
                    if (scenario === 'db-replay') f.db.prepare("UPDATE operator_recovery_challenges_v1 SET coordinator_boot='old-boot'").run();
                    return p;
                };
                await expect(f.ledger.recover(f.grant(), f.peer)).rejects.toThrow();
                expect(f.db.prepare('SELECT COUNT(*) AS n FROM operator_recovery_anchors_v1').get()).toEqual({ n: 0 });
            } finally { f.db.close(); }
        });
    }
    it('serializes concurrent consumption of the same exact target', async () => {
        const f = fixture();
        try {
            const results = await Promise.allSettled([f.ledger.recover(f.grant(), f.peer), f.ledger.recover(f.grant(), f.peer)]);
            expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
            expect(f.db.prepare('SELECT COUNT(*) AS n FROM operator_recovery_anchors_v1').get()).toEqual({ n: 1 });
        } finally { f.db.close(); }
    });
});
