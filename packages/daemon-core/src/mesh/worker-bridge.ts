/** Strict, mesh-local worker protocol B. Legacy mode is never used as a fallback
 * once the staged upgrade has armed this mesh. Journals are local-only SQLite. */
import { bridgeReceiptTransaction } from './worker-bridge-transaction.js';
import { createHash, randomUUID } from 'node:crypto';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { Database } from 'better-sqlite3';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getDaemonBuildInfo } from '../build-info.js';
import { normalizeWorkerDeliveryId } from './worker-report-idempotency.js';
import { unwrapMeshRelayResult } from '../commands/mesh-relay-result.js';

export const BRIDGE_CAPABILITY_COMMAND = 'worker_bridge_capabilities';
export const BRIDGE_DELIVERY_COMMAND = 'worker_bridge_delivery';
import { BRIDGE_PROTOCOL } from './worker-bridge-protocol.js';
export { BRIDGE_PROTOCOL } from './worker-bridge-protocol.js';
export const BRIDGE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export type BridgeKind = 'report' | 'progress' | 'refusal';
export interface BridgeEnvelope {
    protocol: 1;
    kind: BridgeKind;
    ownerDaemonId: string;
    senderDaemonId: string;
    senderCommit: string;
    senderVersion: string;
    meshId: string;
    nodeId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    generation: number;
    deliveryId: string;
    reportedAtMs: number;
    payload: Record<string, unknown>;
}
export interface BridgePolicy {
    meshId: string;
    rolloutId: string;
    frozen: boolean;
    /** Exact B and F identities admitted by the pinned rollout, never npm tags. */
    builds: Array<{ commit: string; version: string }>;
    ownerDaemonId?: string;
    roster?: Array<{ nodeId: string; daemonId: string }>;
}
export interface BridgeIdentity { daemonId: string; commit: string; version: string }
export type BridgeDispatch = (daemonId: string, command: string, args: Record<string, unknown>) => Promise<unknown>;
type Reply = Record<string, unknown> & { success: boolean };
const sha = /^[a-f0-9]{40}$/;
const version = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v === v.trim();

export function bridgeIdentity(daemonId: string, statusVersion?: string): BridgeIdentity {
    const build = getDaemonBuildInfo();
    return { daemonId, commit: build.commit, version: statusVersion ?? build.version };
}
export function stableBridgeJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableBridgeJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableBridgeJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}
export function bridgeDigest(envelope: BridgeEnvelope): string {
    return createHash('sha256').update(stableBridgeJson(envelope)).digest('hex');
}
export function ensureBridgeSchema(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS worker_bridge_policy (mesh_id TEXT PRIMARY KEY, policy_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_bridge_delivery (
        side TEXT NOT NULL, sender_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
        mesh_id TEXT NOT NULL, envelope_json TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','quarantined','receipted')),
        receipt_json TEXT, reason TEXT, PRIMARY KEY(side,sender_id,delivery_id));
      CREATE TABLE IF NOT EXISTS worker_bridge_progress_notice(event_id TEXT PRIMARY KEY,mesh_id TEXT NOT NULL,notice_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','delivered')));`);
}
export function readBridgePolicy(db: Database, meshId: string): BridgePolicy | null {
    ensureBridgeSchema(db);
    const row = db.prepare('SELECT policy_json FROM worker_bridge_policy WHERE mesh_id=?').get(meshId) as { policy_json: string } | undefined;
    return row ? JSON.parse(row.policy_json) : null;
}
export function setBridgePolicy(db: Database, policy: BridgePolicy): void {
    if (!id(policy.meshId) || !id(policy.rolloutId) || typeof policy.frozen !== 'boolean' || !Array.isArray(policy.builds)
        || !policy.builds.length || policy.builds.some((b) => !sha.test(b.commit) || !version.test(b.version))) throw new Error('invalid_bridge_policy');
    if (policy.roster && (!id(policy.ownerDaemonId) || !policy.roster.length || policy.roster.some((node) => !id(node.nodeId) || !id(node.daemonId)) || new Set(policy.roster.map((node) => node.nodeId)).size !== policy.roster.length)) throw new Error('invalid_bridge_roster');
    const previous = readBridgePolicy(db, policy.meshId);
    if (previous?.roster && (stableBridgeJson(previous.roster) !== stableBridgeJson(policy.roster) || previous.ownerDaemonId !== policy.ownerDaemonId)) throw new Error('bridge_roster_identity_conflict');
    if (previous && previous.rolloutId !== policy.rolloutId) throw new Error('bridge_rollout_identity_conflict');
    if (previous && previous.builds.some((b) => !policy.builds.some((next) => next.commit === b.commit && next.version === b.version))) throw new Error('bridge_rollback_floor_cannot_be_removed');
    db.prepare('INSERT INTO worker_bridge_policy VALUES (?,?) ON CONFLICT(mesh_id) DO UPDATE SET policy_json=excluded.policy_json').run(policy.meshId, JSON.stringify(policy));
}
export function bridgeDispatchFrozen(db: Database, meshId: string): boolean {
    return readBridgePolicy(db, meshId)?.frozen === true;
}
export function decodeBridgeEnvelope(value: unknown): BridgeEnvelope | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const e = value as BridgeEnvelope;
    const keys = ['protocol','kind','ownerDaemonId','senderDaemonId','senderCommit','senderVersion','meshId','nodeId','taskId','sessionId','attemptId','generation','deliveryId','reportedAtMs','payload'];
    if (Object.keys(e).length !== keys.length || Object.keys(e).some((k) => !keys.includes(k)) || e.protocol !== BRIDGE_PROTOCOL
        || !['report','progress','refusal'].includes(e.kind) || ![e.ownerDaemonId,e.senderDaemonId,e.meshId,e.nodeId,e.taskId,e.sessionId,e.attemptId].every(id)
        || !sha.test(e.senderCommit) || !version.test(e.senderVersion) || !Number.isSafeInteger(e.generation) || e.generation < 0
        || normalizeWorkerDeliveryId(e.deliveryId) !== e.deliveryId || !Number.isSafeInteger(e.reportedAtMs) || e.reportedAtMs <= 0
        || !e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) return null;
    return e;
}
function admitted(policy: BridgePolicy, identity: BridgeIdentity): boolean {
    return policy.builds.some((b) => b.commit === identity.commit && b.version === identity.version);
}
export function bridgeCapability(db: Database, self: BridgeIdentity, meshId: string, nonce: string): Reply {
    const policy = readBridgePolicy(db, meshId);
    if (!policy || !admitted(policy, self) || !id(nonce)) return { success: false, error: 'worker_protocol_unsupported' };
    const open = db.prepare('SELECT COUNT(*) AS n FROM turn_attempts WHERE mesh_id=? AND terminal_outcome IS NULL').get(meshId) as { n: number };
    const holds = db.prepare("SELECT COUNT(*) AS n FROM turn_holds h JOIN turn_attempts a ON a.attempt_id=h.attempt_id WHERE a.mesh_id=? AND h.status='active'").get(meshId) as { n: number };
    const pending = db.prepare("SELECT (SELECT COUNT(*) FROM worker_bridge_delivery WHERE mesh_id=? AND state!='receipted') + (SELECT COUNT(*) FROM worker_bridge_progress_notice WHERE mesh_id=? AND state='pending') AS n").get(meshId, meshId) as { n: number };
    return { success: true, protocol: BRIDGE_PROTOCOL, ...self, meshId, nonce, rolloutId: policy.rolloutId, frozen: policy.frozen, openAttempts: open.n, correctionOrLivenessHolds: holds.n, pendingDeliveries: pending.n };
}
export function bridgeDrainState(db: Database, meshId: string) {
    ensureBridgeSchema(db);
    const attempts = db.prepare('SELECT attempt_id,scope,task_id,node_id,session_id,owner_daemon_id,generation,terminal_outcome,terminal_source,terminal_strength,terminal_at FROM turn_attempts WHERE mesh_id=? ORDER BY attempt_id').all(meshId) as Array<{ terminal_outcome: string | null }>;
    const holds = db.prepare("SELECT h.hold_id,h.generation,h.reason,h.on_expire,h.status,h.until_ms FROM turn_holds h JOIN turn_attempts a ON a.attempt_id=h.attempt_id WHERE a.mesh_id=? AND h.status='active' ORDER BY h.hold_id").all(meshId);
    const pending = db.prepare("SELECT (SELECT COUNT(*) FROM worker_bridge_delivery WHERE mesh_id=? AND state!='receipted') + (SELECT COUNT(*) FROM worker_bridge_progress_notice WHERE mesh_id=? AND state='pending') AS n").get(meshId, meshId) as { n: number };
    return { openAttempts: attempts.filter((a) => a.terminal_outcome === null).length, correctionOrLivenessHolds: holds.length, pendingDeliveries: pending.n,
        ledgerDigest: createHash('sha256').update(stableBridgeJson({ attempts, holds })).digest('hex') };
}
export function findBridgeMemberDelivery(db: Database, senderId: string, deliveryId: string): BridgeEnvelope | null {
    ensureBridgeSchema(db);
    const saved = row(db, 'member', senderId, deliveryId);
    return saved ? JSON.parse(saved.envelope_json) : null;
}
/** Local IPC uses its authenticated prepared credential instead of a peer
 * challenge. The same transaction and receipt discipline covers local workers. */
export function commitLocalBridgeDelivery(db: Database, e: BridgeEnvelope, apply: () => Reply): Reply {
    ensureBridgeSchema(db);
    const prior = row(db, 'local', e.senderDaemonId, e.deliveryId);
    if (prior) {
        const original = JSON.parse(prior.envelope_json) as BridgeEnvelope;
        if (stableBridgeJson({ ...e, senderCommit: original.senderCommit, senderVersion: original.senderVersion }) !== stableBridgeJson(original)) return { success: false, error: 'worker_delivery_identity_conflict' };
        e = original;
    }
    if (prior && prior.digest !== bridgeDigest(e)) return { success: false, error: 'worker_delivery_identity_conflict' };
    try { return bridgeReceiptTransaction(db, () => {
        const saved = put(db, 'local', e);
        if (saved.receipt_json) return JSON.parse(saved.receipt_json) as Reply;
        const reply = apply();
        if (['storage_failed','forward_failed','worker_protocol_unsupported'].includes(String(reply.error))) throw new Error('bridge_apply_not_durable');
        if (reply.success !== true && !(reply.error === 'invalid_report' && (reply.receipt as { recorded?: boolean })?.recorded === true)) return reply;
        db.prepare("UPDATE worker_bridge_delivery SET state='receipted',receipt_json=? WHERE side='local' AND sender_id=? AND delivery_id=?").run(JSON.stringify(reply), e.senderDaemonId, e.deliveryId);
        return reply;
    }); } catch { return { success: false, error: 'storage_failed' }; }
}
export async function queryBridgePeer(dispatch: BridgeDispatch, peerId: string, meshId: string, policy: BridgePolicy): Promise<Record<string, unknown> | null> {
    const nonce = randomUUID();
    const reply = unwrapMeshRelayResult(await dispatch(peerId, BRIDGE_CAPABILITY_COMMAND, { meshId, nonce }), { command: BRIDGE_CAPABILITY_COMMAND, peerDaemonId: peerId });
    const valid = reply.success === true && reply.protocol === BRIDGE_PROTOCOL && reply.meshId === meshId && reply.nonce === nonce
        && reply.rolloutId === policy.rolloutId && typeof reply.daemonId === 'string' && daemonIdsEquivalent(reply.daemonId, peerId)
        && admitted(policy, reply as unknown as BridgeIdentity);
    return valid ? reply : null;
}
interface DeliveryRow { envelope_json: string; digest: string; state: string; receipt_json: string | null; reason: string | null }
function row(db: Database, side: string, senderId: string, deliveryId: string): DeliveryRow | undefined {
    return db.prepare('SELECT * FROM worker_bridge_delivery WHERE side=? AND sender_id=? AND delivery_id=?').get(side, senderId, deliveryId) as DeliveryRow | undefined;
}
function put(db: Database, side: string, envelope: BridgeEnvelope): DeliveryRow {
    ensureBridgeSchema(db);
    const digest = bridgeDigest(envelope), existing = row(db, side, envelope.senderDaemonId, envelope.deliveryId);
    if (existing) {
        if (existing.digest !== digest) throw new Error('worker_delivery_identity_conflict');
        return existing;
    }
    db.prepare("INSERT INTO worker_bridge_delivery(side,sender_id,delivery_id,mesh_id,envelope_json,digest,state) VALUES (?,?,?,?,?,?,'pending')").run(side, envelope.senderDaemonId, envelope.deliveryId, envelope.meshId, stableBridgeJson(envelope), digest);
    return row(db, side, envelope.senderDaemonId, envelope.deliveryId)!;
}
function quarantine(db: Database, e: BridgeEnvelope, reason: string): Reply {
    db.prepare("UPDATE worker_bridge_delivery SET state='quarantined',reason=? WHERE side='member' AND sender_id=? AND delivery_id=?").run(reason, e.senderDaemonId, e.deliveryId);
    return { success: false, error: 'worker_protocol_unsupported', quarantined: true, deliveryId: e.deliveryId, envelopeDigest: bridgeDigest(e), reason };
}
/** Never reconstruct identity on retry. Delivery-id reuse with a changed claim is
 * an error; daemon restart/reassignment cannot retarget the persisted envelope. */
export async function sendBridgeDelivery(db: Database, e: BridgeEnvelope, dispatch: BridgeDispatch, nowMs = Date.now()): Promise<Reply> {
    if (!decodeBridgeEnvelope(e)) return { success: false, error: 'worker_protocol_provenance_required' };
    const saved = put(db, 'member', e);
    if (saved.receipt_json) return JSON.parse(saved.receipt_json);
    if (nowMs - e.reportedAtMs > BRIDGE_MAX_AGE_MS || e.reportedAtMs > nowMs + 60_000) return quarantine(db, e, 'delivery_time_expired');
    const policy = readBridgePolicy(db, e.meshId);
    if (!policy || !admitted(policy, { daemonId: e.senderDaemonId, commit: e.senderCommit, version: e.senderVersion })) return quarantine(db, e, 'build_not_admitted');
    try {
        if (!await queryBridgePeer(dispatch, e.ownerDaemonId, e.meshId, policy)) return quarantine(db, e, 'owner_capability_unconfirmed');
        const reply = unwrapMeshRelayResult(await dispatch(e.ownerDaemonId, BRIDGE_DELIVERY_COMMAND, { meshId: e.meshId, envelope: e }), { command: BRIDGE_DELIVERY_COMMAND, peerDaemonId: e.ownerDaemonId });
        const receipt = reply.deliveryReceipt as Record<string, unknown> | undefined;
        if (!receipt || receipt.digest !== saved.digest || receipt.deliveryId !== e.deliveryId || receipt.protocol !== BRIDGE_PROTOCOL
            || receipt.ownerDaemonId !== e.ownerDaemonId || receipt.taskId !== e.taskId || receipt.attemptId !== e.attemptId
            || receipt.generation !== e.generation || receipt.sessionId !== e.sessionId || receipt.senderDaemonId !== e.senderDaemonId) return quarantine(db, e, 'owner_receipt_unconfirmed');
        db.prepare("UPDATE worker_bridge_delivery SET state='receipted',receipt_json=?,reason=NULL WHERE side='member' AND sender_id=? AND delivery_id=?").run(JSON.stringify(reply), e.senderDaemonId, e.deliveryId);
        return reply as Reply;
    } catch {
        return { success: false, error: 'forward_failed', deliveryId: e.deliveryId };
    }
}
/** Authenticated channel + roster gates run before this body. Commit acceptance
 * and its immutable receipt in ONE transaction on the owner's runtime handle. */
export async function receiveBridgeDelivery(db: Database, raw: unknown, senderId: string, self: BridgeIdentity, dispatch: BridgeDispatch,
    apply: (e: BridgeEnvelope) => Reply, nowMs = Date.now()): Promise<Reply> {
    const e = decodeBridgeEnvelope(raw);
    if (!e || !daemonIdsEquivalent(e.senderDaemonId, senderId) || !daemonIdsEquivalent(e.ownerDaemonId, self.daemonId)) return { success: false, error: 'invalid_worker_bridge_envelope' };
    const policy = readBridgePolicy(db, e.meshId);
    if (!policy || !admitted(policy, self) || !admitted(policy, { daemonId: senderId, commit: e.senderCommit, version: e.senderVersion })) return { success: false, error: 'worker_protocol_unsupported' };
    try {
        if (!await queryBridgePeer(dispatch, senderId, e.meshId, policy)) return { success: false, error: 'worker_protocol_unsupported' };
        return bridgeReceiptTransaction(db, () => {
            const saved = put(db, 'owner', e);
            if (saved.receipt_json) return JSON.parse(saved.receipt_json) as Reply;
            if (nowMs - e.reportedAtMs > BRIDGE_MAX_AGE_MS || e.reportedAtMs > nowMs + 60_000) return { success: false, error: 'stale_report' };
            const reply = apply(e);
            // Storage/transient refusals are not terminal receipts; retry unchanged.
            if (['storage_failed','forward_failed','worker_protocol_unsupported'].includes(String(reply.error))) throw new Error('bridge_apply_not_durable');
            const receipt = { protocol: BRIDGE_PROTOCOL, digest: saved.digest, deliveryId: e.deliveryId, ownerDaemonId: e.ownerDaemonId,
                senderDaemonId: e.senderDaemonId, taskId: e.taskId, attemptId: e.attemptId, generation: e.generation, sessionId: e.sessionId };
            const answer = { ...reply, deliveryReceipt: receipt };
            db.prepare("UPDATE worker_bridge_delivery SET state='receipted',receipt_json=? WHERE side='owner' AND sender_id=? AND delivery_id=?").run(JSON.stringify(answer), e.senderDaemonId, e.deliveryId);
            return answer;
        });
    } catch { return { success: false, error: 'storage_failed' }; }
}
/** A daemon boot pump retries exact persisted envelopes; unsupported/expired
 * deliveries stay queryable and drain-blocking. No bodies are logged. */
export async function resumeBridgeDeliveries(dispatch: BridgeDispatch): Promise<void> {
    const db = MeshRuntimeStore.getInstance().db;
    (await import('./worker-report-progress.js')).resumeBridgeProgressNotices(db);
    ensureBridgeSchema(db);
    const pending = db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member' AND state!='receipted' AND (reason IS NULL OR reason!='delivery_time_expired')").all() as Array<{ envelope_json: string }>;
    for (const item of pending) await sendBridgeDelivery(db, JSON.parse(item.envelope_json), dispatch);
}
