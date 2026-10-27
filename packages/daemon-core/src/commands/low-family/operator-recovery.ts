import { generateKeyPairSync, randomUUID, randomBytes, sign, type KeyObject } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OPERATOR_RECOVERY_TARGET as target, RecoveryOwnerAdmission, SessionHostClient, getDefaultSessionHostEndpoint,
    type RecoveryPhysicalProof, type RecoveryHostBinding } from '@adhdev/session-host-core';
import { getProcessInstanceContext } from '../../config/instance-context.js';
import { getConfigDir } from '../../config/config.js';
import { getActiveTurnLedger } from '../../mesh/turn-ledger/active-ledger.js';
import { RecoveryWitness } from '../../mesh/turn-ledger/operator-recovery-witness.js';
import { installRecoveryHostFence } from '../../session-host/recovery-owner-channel.js';
import { isNondelegatedLocalOwnerIngress } from '../command-args.js';
import { readMeshSender } from '../mesh-sender.js';
import { defineCommandSpecs } from '../command-registry.js';
import type { LowFamilyContext } from './types.js';

interface Enrollment { owner: RecoveryOwnerAdmission; key: KeyObject; boot: string; witness: RecoveryWitness; message: string }
const enrollments = new WeakMap<object, Enrollment>();
const ownerGenerations = new WeakMap<object, string>();
function endpoint() {
    const i = getProcessInstanceContext();
    return getDefaultSessionHostEndpoint(i.sessionHostAppName, { ipcKey: i.ipcKey });
}
function requireOwner(args: unknown): void {
    if (!isNondelegatedLocalOwnerIngress(args)) throw new Error('recovery_nondelegated_local_owner_required');
}
function mint(e: Pick<Enrollment, 'owner' | 'key'>, message: string) {
    return e.owner.authorize(message, sign(null, Buffer.from(message), e.key).toString('hex'));
}
function restoreSnapshot(ctx: LowFamilyContext): string {
    const s = ctx.deps.cliManager.operatorRecoveryReadiness();
    if (s.hostedRestoreState !== 'ready' || s.hostedFullRestoreState !== 'ready' ||
        s.hostedPartialRestoreCount !== 0 || s.adapterCensus !== 'absent') throw new Error('recovery_full_restore_and_adapter_closure_required');
    return JSON.stringify(s);
}
/** Supported surface: verified password-session owner enrolls an operation-local
 * in-memory signer. Neither a config token nor internal MCP grants enrollment.
 * Every subsequent operation ALSO requires the current nondelegated channel. */
export async function operatorRecoveryCommand(ctx: LowFamilyContext, args: any) {
    try {
        requireOwner(args);
        const action = args.action;
        if (action === 'fence') {
            if (ctx.deps.statusInstanceId !== target.workerDaemonId) throw new Error('recovery_wrong_worker');
            const restore = restoreSnapshot(ctx);
            const fenceDigest = await installRecoveryHostFence(endpoint(), args);
            if (restoreSnapshot(ctx) !== restore) throw new Error('recovery_restore_changed');
            const client = new SessionHostClient({ endpoint: endpoint(), requestTimeoutMs: 5000 });
            try {
                const proof = await client.request<RecoveryPhysicalProof>({ type: 'attest_operator_recovery_v1',
                    payload: { nonce: randomBytes(32).toString('hex'), fenceDigest } });
                if (!proof.success || !proof.result) throw new Error(proof.error || 'recovery_native_identity_unavailable');
                return { success: true, result: { fenceDigest, binding: {
                    namespace: proof.result.namespace, endpoint: proof.result.endpoint, hostBootId: proof.result.hostBootId,
                    workerDaemonId: proof.result.workerDaemonId }, physicalVerdict: proof.result.verdict } };
            } finally { client.disconnect(); }
        }
        const ledger = getActiveTurnLedger();
        if (!ledger || ledger.selfDaemonId !== target.ownerDaemonId) throw new Error('recovery_wrong_coordinator');
        if (action === 'revoke') {
            ownerGenerations.set(ctx.deps, randomUUID());
            enrollments.delete(ctx.deps);
            return { success: true, result: { revoked: true } };
        }
        if (action === 'enroll') {
            if (enrollments.has(ctx.deps)) throw new Error('recovery_owner_already_enrolled_this_boot');
            const boot = randomUUID();
            ownerGenerations.set(ctx.deps, boot);
            const pair = generateKeyPairSync('ed25519');
            const owner = new RecoveryOwnerAdmission({ publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
                enrollmentId: randomUUID(), coordinatorBootId: boot, authEpoch: boot,
                verifyCurrent: () => ownerGenerations.get(ctx.deps) === boot && isNondelegatedLocalOwnerIngress(args) });
            const state = { owner, key: pair.privateKey, boot };
            const witnessRoot = path.join(getConfigDir(), 'operator-recovery-witness-v1');
            const grant = mint(state, owner.challenge().message);
            const witness = fs.existsSync(witnessRoot) ? new RecoveryWitness(witnessRoot) : RecoveryWitness.enroll(witnessRoot, owner, grant);
            owner.consume(grant);
            witness.assertAvailable();
            const message = owner.challenge().message;
            enrollments.set(ctx.deps, { ...state, witness, message });
            return { success: true, result: { message, association: 'operator_asserted', target } };
        }
        if (action === 'execute') {
            const e = enrollments.get(ctx.deps);
            if (!e || args.message !== e.message) throw new Error('recovery_owner_enrollment_or_challenge_missing');
            // Enrollment challenges are burned on any execution attempt; a
            // refused physical census cannot be retried with the same grant.
            enrollments.delete(ctx.deps);
            const grant = mint(e, args.message);
            requireOwner(args);
            const b = args.binding as RecoveryHostBinding;
            if (!b || typeof args.fenceDigest !== 'string') throw new Error('recovery_host_binding_required');
            const peer = ctx.deps.captureRecoveryPeer?.(target.workerDaemonId, b, args.fenceDigest);
            if (!peer) throw new Error('recovery_authenticated_peer_unavailable');
            await ledger.recoverOperatorAssertedLegacy({ owner: e.owner, grant, peer, witness: e.witness, coordinatorBootId: e.boot });
            return { success: true, result: { taskId: target.taskId, status: 'failed', association: 'operator_asserted' } };
        }
        throw new Error('recovery_action_required');
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error), code: 'operator_recovery_refused' }; }
}

/** Inventory only, addressed to the exact original authenticated coordinator.
 * No learning, roster bootstrap, stop capability, or durable mutation. */
export async function operatorRecoveryCensusCommand(ctx: LowFamilyContext, args: any) {
    if (readMeshSender(args) !== target.ownerDaemonId || ctx.deps.statusInstanceId !== target.workerDaemonId) {
        return { success: false, error: 'recovery_exact_authenticated_coordinator_required' };
    }
    const restore = restoreSnapshot(ctx);
    const client = new SessionHostClient({ endpoint: endpoint(), requestTimeoutMs: 5000 });
    try {
        const response = await client.request<RecoveryPhysicalProof>({ type: 'attest_operator_recovery_v1',
            payload: { nonce: args.nonce, fenceDigest: args.fenceDigest } });
        if (restoreSnapshot(ctx) !== restore) throw new Error('recovery_restore_changed');
        return { ...response };
    }
    finally { client.disconnect(); }
}
export const operatorRecoverySpecs = defineCommandSpecs('low', {
    operator_recovery: operatorRecoveryCommand,
    mesh_operator_recovery_census: operatorRecoveryCensusCommand,
}, {
    operator_recovery: { sources: ['standalone', 'ipc', 'p2p'] },
    mesh_operator_recovery_census: { sources: ['mesh'], meshSender: 'authenticated_peer' },
});
