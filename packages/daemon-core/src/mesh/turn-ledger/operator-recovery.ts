import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { bridgeReceiptTransaction } from '../worker-bridge-transaction.js';
import type { Database } from 'better-sqlite3';
import {
    OPERATOR_RECOVERY_TARGET as target, recoveryTargetBytes,
    type RecoveryHostBinding, type RecoveryOwnerAdmission, type RecoveryPhysicalProof,
} from '@adhdev/session-host-core';

export interface RecoveryCurrentAssignment {
    ownerDaemonId: string; meshId: string; taskId: string; attemptId: string;
    generation: number; dispatchNonce: number; sessionId: string; nodeId: string;
    deliveryId: string; state: string;
    queueStatus: string; queueNodeId: string; queueSessionId: string;
    /** Opaque exact revision of the current mesh owner and queue assignment. */
    ownerRevision: string; queueRevision: string;
}
export interface RecoveryPeerPort {
    /** Captured from authenticated transport, never from response payload. */
    readonly peerId: string;
    readonly connectionEpoch: string;
    readonly binding: Readonly<RecoveryHostBinding>;
    readonly fenceDigest: string;
    isCurrent(): boolean;
    requestPhysicalProof(nonce: string): Promise<RecoveryPhysicalProof>;
}
export interface RecoveryAnchor {
    association: 'operator_asserted';
    target: typeof target;
    proof: RecoveryPhysicalProof;
}
interface Pending {
    deadline: number; current: string; grant: unknown; peer: RecoveryPeerPort;
    binding: string; connectionEpoch: string; fenceDigest: string;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** One-use admission with an in-transaction ledger adapter. This module never
 * emits turn state itself; production wires the separate failure reducer and
 * independent witness. It neither accepts nor produces writerStopReceipt. */
export class OperatorRecoveryAnchors {
    private readonly pending = new Map<string, Pending>();
    private readonly anchors = new WeakSet<object>();
    private lastNow = -Infinity;
    constructor(private readonly deps: {
        db: Database;
        owner: RecoveryOwnerAdmission;
        coordinatorBootId: string;
        /** Must synchronously read the owner, latest attempt AND mesh_queue on
         * this same db handle. Called only inside the immediate transaction. */
        readCurrentAssignment: () => RecoveryCurrentAssignment;
        /** Independent durable witness; absence is a refusal, not TOFU. */
        assertAntiRollback: () => void;
        /** Independent irreversible witness is burned before the SQL commit. */
        withOwnershipFence?: <T>(apply: () => T) => T;
        burnWitness?: (nonceHash: string, proofHash: string) => void;
        /** Existing ledger reducer + task/queue effects on THIS transaction. */
        settleInTransaction?: (anchor: RecoveryAnchor) => void;
        clock?: () => number;
    }) {
        if (!deps.coordinatorBootId) throw new Error('recovery_coordinator_boot_required');
        deps.db.exec(`CREATE TABLE IF NOT EXISTS operator_recovery_challenges_v1 (
            nonce_hash TEXT PRIMARY KEY, target TEXT NOT NULL, coordinator_boot TEXT NOT NULL,
            assignment TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('issued','consumed','revoked')));
            CREATE TABLE IF NOT EXISTS operator_recovery_anchors_v1 (
            target TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL UNIQUE, association TEXT NOT NULL,
            proof TEXT NOT NULL, assignment TEXT NOT NULL);`);
    }
    private now(): number {
        const n = (this.deps.clock ?? (() => performance.now()))();
        if (!Number.isFinite(n) || n < this.lastNow) {
            this.pending.clear(); this.lastNow = Infinity;
            throw new Error('recovery_monotonic_clock_rollback');
        }
        this.lastNow = n;
        return n;
    }
    private current(): string {
        this.deps.assertAntiRollback();
        const c = this.deps.readCurrentAssignment();
        for (const key of ['ownerDaemonId', 'meshId', 'taskId', 'attemptId', 'generation',
            'dispatchNonce', 'sessionId', 'nodeId', 'deliveryId'] as const) {
            if (c[key] !== target[key]) throw new Error('recovery_current_assignment_mismatch');
        }
        if (c.state !== 'stopping' || c.queueStatus !== 'assigned' ||
            c.queueNodeId !== target.nodeId || c.queueSessionId !== target.sessionId ||
            !c.ownerRevision || !c.queueRevision) throw new Error('recovery_current_assignment_mismatch');
        return JSON.stringify(c);
    }
    private assertPeer(p: Pending): void {
        if (p.peer.peerId !== target.workerDaemonId || !p.connectionEpoch ||
            p.peer.connectionEpoch !== p.connectionEpoch || !p.peer.isCurrent() ||
            JSON.stringify(p.peer.binding) !== p.binding || p.peer.fenceDigest !== p.fenceDigest ||
            p.peer.binding.workerDaemonId !== target.workerDaemonId ||
            p.peer.binding.namespace !== target.namespace || !p.peer.binding.hostBootId ||
            !p.peer.binding.endpoint.endsWith(`adhdev-preview-session-host-${target.namespace}.sock`) ||
            !/^[a-f0-9]{64}$/.test(p.fenceDigest)) throw new Error('recovery_authenticated_peer_changed');
    }
    revoke(): void {
        // Private nonces are forgotten even if persistence is unavailable.
        this.pending.clear();
        this.deps.db.prepare("UPDATE operator_recovery_challenges_v1 SET state='revoked' WHERE state='issued'").run();
    }
    async recover(grant: unknown, peer: RecoveryPeerPort): Promise<RecoveryAnchor> {
        this.deps.owner.assertGrant(grant);
        const nonce = randomBytes(32).toString('hex');
        const nonceHash = hash(nonce);
        const p: Pending = { deadline: this.now() + 30_000, current: '', grant, peer,
            binding: JSON.stringify(peer.binding), connectionEpoch: peer.connectionEpoch, fenceDigest: peer.fenceDigest };
        this.assertPeer(p);
        (this.deps.withOwnershipFence ?? ((f: () => void) => f()))(() => this.deps.db.transaction(() => {
            p.current = this.current();
            if (this.deps.db.prepare('SELECT 1 FROM operator_recovery_anchors_v1 WHERE target=?').get(recoveryTargetBytes)) {
                throw new Error('recovery_already_consumed');
            }
            this.deps.db.prepare('INSERT INTO operator_recovery_challenges_v1 VALUES (?,?,?,?,?)')
                .run(nonceHash, recoveryTargetBytes, this.deps.coordinatorBootId, p.current, 'issued');
        }).immediate());
        this.pending.set(nonceHash, p);
        try {
            // Only this authenticated port receives the private fresh nonce.
            let timer: ReturnType<typeof setTimeout> | undefined;
            let proof: RecoveryPhysicalProof;
            try {
                proof = await Promise.race([peer.requestPhysicalProof(nonce), new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('recovery_physical_query_timeout')), 30_000);
                })]);
            } finally { if (timer) clearTimeout(timer); }
            const fenced = this.deps.withOwnershipFence ?? (<T>(f: () => T) => f());
            return fenced(() => bridgeReceiptTransaction(this.deps.db, () => {
                this.deps.owner.assertGrant(grant);
                this.assertPeer(p);
                if (this.now() >= p.deadline || this.pending.get(nonceHash) !== p || this.current() !== p.current) {
                    throw new Error('recovery_expired_revoked_or_reassigned');
                }
                const row = this.deps.db.prepare('SELECT * FROM operator_recovery_challenges_v1 WHERE nonce_hash=?')
                    .get(nonceHash) as { state: string; coordinator_boot: string; assignment: string; target: string } | undefined;
                if (!row || row.state !== 'issued' || row.coordinator_boot !== this.deps.coordinatorBootId ||
                    row.assignment !== p.current || row.target !== recoveryTargetBytes) throw new Error('recovery_challenge_replayed');
                if (!proof || proof.protocol !== 1 || proof.verdict !== 'ABSENT' ||
                    proof.nonce !== nonce || proof.fenceDigest !== p.fenceDigest ||
                    proof.sessionId !== target.sessionId || proof.providerSessionId !== target.providerSessionId ||
                    proof.namespace !== peer.binding.namespace || proof.hostBootId !== peer.binding.hostBootId ||
                    proof.workerDaemonId !== peer.peerId || proof.endpoint !== peer.binding.endpoint) {
                    throw new Error('recovery_physical_proof_refused');
                }
                // Whitelist the content-free audit shape. Extra peer fields
                // cannot masquerade as historical binding or a stop receipt.
                const accepted: RecoveryPhysicalProof = {
                    protocol: 1, verdict: 'ABSENT', reason: 'native_dual_uuid_absence', nonce,
                    fenceDigest: p.fenceDigest, sessionId: target.sessionId, providerSessionId: target.providerSessionId,
                    namespace: proof.namespace, hostBootId: proof.hostBootId,
                    workerDaemonId: proof.workerDaemonId, endpoint: proof.endpoint,
                };
                this.deps.burnWitness?.(nonceHash, hash(JSON.stringify(accepted)));
                this.deps.db.prepare('INSERT INTO operator_recovery_anchors_v1 VALUES (?,?,?,?,?)')
                    .run(recoveryTargetBytes, nonceHash, 'operator_asserted', JSON.stringify(accepted), p.current);
                this.deps.db.prepare("UPDATE operator_recovery_challenges_v1 SET state='consumed' WHERE nonce_hash=?").run(nonceHash);
                const anchor = Object.freeze({ association: 'operator_asserted' as const,
                    target, proof: Object.freeze(accepted) });
                this.deps.settleInTransaction?.(anchor);
                this.deps.owner.consume(grant);
                this.anchors.add(anchor);
                return anchor;
            }));
        } finally {
            this.pending.delete(nonceHash);
            this.deps.db.prepare("UPDATE operator_recovery_challenges_v1 SET state='revoked' WHERE nonce_hash=? AND state='issued'")
                .run(nonceHash);
        }
    }
    /** Object identity only; serialized audit rows cannot become authority. */
    ownsAnchor(anchor: unknown): anchor is RecoveryAnchor {
        return typeof anchor === 'object' && anchor !== null && this.anchors.has(anchor);
    }
}
