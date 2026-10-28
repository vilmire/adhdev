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
        writerStopRequestId: 'stop-1', writerStopConfirmed: false, writerStopTerminalPresent: false, reportPresent: false,
        reclaimCount: 0, holdsRevision: 'hold-rev-1', ownerRevision: 'owner-rev-1', queueRevision: 'queue-rev-1' };
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
        queueRevision: 'reassigned', ownerRevision: 'owner-transferred', holdsRevision: 'hold-change',
        writerStopRequestId: 'changed-stop', writerStopConfirmed: true, writerStopTerminalPresent: true, reportPresent: true, reclaimCount: 1 })) {
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

describe('checkpoint71c6ed40 one-use and refusal fidelity', () => {
    it('burns one grant at invocation even for refused concurrent queries', async () => {
        const f = fixture(); const g = f.grant(); let calls = 0;
        f.peer.requestPhysicalProof = async nonce => { calls++; return { ...f.peer.binding, protocol: 1,
            verdict: 'UNKNOWN', reason: 'fixture unknown', nonce, fenceDigest: f.peer.fenceDigest,
            sessionId: target.sessionId, providerSessionId: target.providerSessionId }; };
        try {
            await Promise.allSettled([f.ledger.recover(g, f.peer), f.ledger.recover(g, f.peer)]);
            expect(calls).toBe(1); await expect(f.ledger.recover(g, f.peer)).rejects.toThrow('grant_rejected');
        } finally { f.db.close(); }
    });
    it('preserves primary refusal when persistence becomes unavailable', async () => {
        const f = fixture(); f.peer.requestPhysicalProof = async () => { f.db.close(); throw Error('primary_observation_failure'); };
        await expect(f.ledger.recover(f.grant(), f.peer)).rejects.toThrow('primary_observation_failure');
        expect(() => f.ledger.revoke()).not.toThrow();
    });
    it('revokes persisted prior-instance challenges', () => {
        const f = fixture();
        f.db.prepare('INSERT INTO operator_recovery_challenges_v1 VALUES (?,?,?,?,?)').run('old', 'target', 'oldboot', 'oldassignment', 'issued');
        new OperatorRecoveryAnchors({ db: f.db, owner: f.admission, coordinatorBootId: 'freshboot',
            readCurrentAssignment: () => { throw Error('unused'); }, assertAntiRollback: () => {} });
        expect(f.db.prepare('SELECT state FROM operator_recovery_challenges_v1').get()).toEqual({ state: 'revoked' }); f.db.close();
    });
});

it('operation-scoped reservation burns on wrong scope and keeps original expiry/revocation', () => {
    const f = fixture();
    try {
        const wrong = f.grant(); expect(() => f.admission.reserve(wrong, 'fence_install')).toThrow('operation_rejected');
        expect(() => f.admission.reserve(wrong, 'anchor_recover')).toThrow('grant_rejected');
        const g = f.grant(); const continuation = f.admission.reserve(g, 'anchor_recover'); continuation();
        expect(() => f.admission.reserve(g, 'anchor_recover')).toThrow('grant_rejected');
        f.setNow(30100); expect(continuation).toThrow('grant_rejected');
    } finally { f.db.close(); }
});
