import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { normalizeWorkerDeliveryId } from './worker-report-idempotency.js';
import { stableBridgeJson } from './worker-bridge.js';
export interface PreparedWorkerDelivery {
    meshId: string; taskId: string; attemptId: string; generation: number;
    sessionId: string; nodeId: string; ownerDaemonId: string;
    deliveryId: string; reportedAtMs: number;
}
function schema(db: Database) {
    db.exec('CREATE TABLE IF NOT EXISTS worker_bridge_prepared(credential_hash TEXT NOT NULL,delivery_id TEXT NOT NULL,claim_json TEXT NOT NULL,PRIMARY KEY(credential_hash,delivery_id))');
}
function key(credential: { bind?: unknown; token?: unknown }) {
    const value = credential.bind ?? credential.token;
    return typeof value === 'string' && value ? createHash('sha256').update(value).digest('hex') : '';
}
export function rememberPreparedDelivery(db: Database, credential: { bind?: unknown; token?: unknown }, claim: PreparedWorkerDelivery) {
    schema(db);
    if (!key(credential) || normalizeWorkerDeliveryId(claim.deliveryId) !== claim.deliveryId || !Number.isSafeInteger(claim.reportedAtMs)
        || !Number.isSafeInteger(claim.generation) || claim.generation < 0 || ![claim.meshId,claim.taskId,claim.attemptId,claim.sessionId,claim.nodeId,claim.ownerDaemonId].every((v) => typeof v === 'string' && !!v)) throw new Error('worker_protocol_provenance_required');
    const prior = readPreparedDelivery(db, credential, claim.deliveryId);
    if (prior && stableBridgeJson(prior) !== stableBridgeJson(claim)) throw new Error('worker_delivery_identity_conflict');
    db.prepare('INSERT OR IGNORE INTO worker_bridge_prepared VALUES (?,?,?)').run(key(credential), claim.deliveryId, stableBridgeJson(claim));
    return claim;
}
export function readPreparedDelivery(db: Database, credential: { bind?: unknown; token?: unknown }, deliveryId: unknown): PreparedWorkerDelivery | null {
    schema(db);
    const row = db.prepare('SELECT claim_json FROM worker_bridge_prepared WHERE credential_hash=? AND delivery_id=?').get(key(credential), String(deliveryId)) as { claim_json: string } | undefined;
    return row ? JSON.parse(row.claim_json) : null;
}
export function validatePreparedDelivery(db: Database, args: Record<string, unknown>): PreparedWorkerDelivery | null {
    const saved = readPreparedDelivery(db, args, args.deliveryId);
    return saved && saved.reportedAtMs === args.reportedAtMs && stableBridgeJson(saved) === stableBridgeJson(args.prepared) ? saved : null;
}
