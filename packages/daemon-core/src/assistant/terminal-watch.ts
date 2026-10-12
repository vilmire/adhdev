/** Durable subscriptions/receipts over existing mesh records. Metadata only; no event producer or authority. */
import { createHash, randomBytes } from 'crypto';
import { readTurnTerminalViews } from '../mesh/mesh-local-records.js';
import type { Database } from 'better-sqlite3';
export const TERMINAL_WATCH_TTL_MS = 24 * 60 * 60_000;
export const TERMINAL_WATCH_MAX = 32;
export interface TerminalEvent { eventId: string; meshId: string; taskId: string | null; missionId: string | null; sessionId: string | null; nodeId: string | null; kind: string; at: number; sourceMeshId?: string; sourceDaemonId?: string | null; outcome?: string; strength?: string; evidenceLevel?: string; attemptId?: string }
export interface TerminalWatch { watch_id: string; mesh_id: string; kind: 'task' | 'mission'; entity_id: string; recipient: string; created_at: number; expires_at: number }
export interface TerminalDeliveryIntent { watch_id: string; event_id: string; recipient_session_id: string; token: string; started_at: number }
export function terminalRetryIdentity(intent: TerminalDeliveryIntent): string {
    return createHash('sha256').update(JSON.stringify([intent.watch_id, intent.event_id, intent.recipient_session_id, intent.token])).digest('hex');
}
export const TERMINAL_WATCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS assistant_terminal_watches (
 watch_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 recipient TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_terminal_receipts (
 watch_id TEXT NOT NULL, event_id TEXT NOT NULL, delivered_at INTEGER NOT NULL, PRIMARY KEY(watch_id,event_id));
CREATE TABLE IF NOT EXISTS assistant_terminal_inflight (
 watch_id TEXT NOT NULL, event_id TEXT NOT NULL, recipient_session_id TEXT NOT NULL, token TEXT NOT NULL, started_at INTEGER NOT NULL, PRIMARY KEY(watch_id,event_id));`;

export class TerminalWatchStore {
    constructor(readonly db: Database) { db.exec(TERMINAL_WATCH_SCHEMA); }
    subscribe(meshId: string, kind: 'task' | 'mission', entityId: string, recipient: string, now = Date.now()) {
        this.prune(now);
        const watchId = createHash('sha256').update(JSON.stringify([meshId, kind, entityId, recipient])).digest('hex');
        const existing = this.get(watchId);
        if (existing) return { success: true, watchId, expiresAt: existing.expires_at, duplicate: true };
        const count = this.db.prepare('SELECT COUNT(*) n FROM assistant_terminal_watches WHERE expires_at > ?').get(now) as { n: number };
        if (count.n >= TERMINAL_WATCH_MAX) return { success: false, code: 'terminal_watch_capacity' };
        this.db.prepare('INSERT INTO assistant_terminal_watches VALUES (?,?,?,?,?,?,?)').run(watchId, meshId, kind, entityId, recipient, now, now + TERMINAL_WATCH_TTL_MS);
        return { success: true, watchId, expiresAt: now + TERMINAL_WATCH_TTL_MS, duplicate: false };
    }
    get(id: string): TerminalWatch | undefined { return this.db.prepare('SELECT * FROM assistant_terminal_watches WHERE watch_id=?').get(id) as TerminalWatch | undefined; }
    list(recipient: string, now = Date.now()): TerminalWatch[] {
        return this.db.prepare('SELECT * FROM assistant_terminal_watches WHERE recipient=? AND expires_at>? ORDER BY created_at,watch_id LIMIT 32').all(recipient, now) as TerminalWatch[];
    }
    receipts(id: string): string[] {
        return (this.db.prepare('SELECT event_id FROM assistant_terminal_receipts WHERE watch_id=? ORDER BY delivered_at,event_id LIMIT 256').all(id) as { event_id: string }[]).map(r => r.event_id);
    }
    intent(id: string, eventId: string): TerminalDeliveryIntent | undefined {
        return this.db.prepare('SELECT * FROM assistant_terminal_inflight WHERE watch_id=? AND event_id=?').get(id, eventId) as TerminalDeliveryIntent | undefined;
    }
    beginDelivery(id: string, eventId: string, sid: string): TerminalDeliveryIntent {
        this.db.prepare('INSERT OR IGNORE INTO assistant_terminal_inflight VALUES (?,?,?,?,?)').run(id, eventId, sid, randomBytes(24).toString('hex'), Date.now());
        return this.intent(id, eventId)!;
    }
    retryDelivery(id: string, eventId: string): void { this.db.prepare('DELETE FROM assistant_terminal_inflight WHERE watch_id=? AND event_id=?').run(id, eventId); }
    acknowledge(id: string, eventId: string, now = Date.now()): void {
        this.db.transaction(() => {
            this.db.prepare('INSERT OR IGNORE INTO assistant_terminal_receipts VALUES (?,?,?)').run(id, eventId, now);
            this.retryDelivery(id, eventId);
        })();
    }
    unsubscribe(id: string): void { this.db.prepare('UPDATE assistant_terminal_watches SET expires_at=0 WHERE watch_id=?').run(id); }
    prune(now: number): void {
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM assistant_terminal_inflight WHERE watch_id IN (SELECT watch_id FROM assistant_terminal_watches WHERE created_at < ?)').run(now - 7 * TERMINAL_WATCH_TTL_MS);
            this.db.prepare('DELETE FROM assistant_terminal_receipts WHERE watch_id IN (SELECT watch_id FROM assistant_terminal_watches WHERE created_at < ?)').run(now - 7 * TERMINAL_WATCH_TTL_MS);
            this.db.prepare('DELETE FROM assistant_terminal_watches WHERE created_at < ?').run(now - 7 * TERMINAL_WATCH_TTL_MS);
        })();
    }
}

/** SQL filters BEFORE LIMIT. No titles, summaries, reasons, prompts, provider/account errors. */
export function readTerminalEvents(db: Database, meshId: string, kind: 'task' | 'mission', entityId: string, since: number, receipts: readonly string[]): TerminalEvent[] {
    const ids = receipts.slice(0, 256);
    const hasTurns = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_attempts'").get();
    const receiptAliases = kind === 'task' && hasTurns && ids.length ? (db.prepare(`SELECT DISTINCT t.attempt_id || '#committed' id
        FROM turn_attempts t JOIN mesh_local_records l ON l.mesh_id=t.mesh_id AND l.task_id=t.task_id
        AND (json_extract(l.payload_json,'$.attemptId')=t.attempt_id OR l.event_id=t.attempt_id || '#committed'
            OR (json_extract(l.payload_json,'$.attemptId') IS NULL AND l.session_id=t.session_id AND l.at_ms=t.terminal_at AND l.kind='task_' || t.terminal_outcome
                AND (SELECT COUNT(*) FROM turn_attempts x WHERE x.mesh_id=t.mesh_id AND x.task_id=t.task_id AND x.session_id=t.session_id AND x.terminal_at=t.terminal_at AND x.terminal_outcome=t.terminal_outcome)=1))
        WHERE t.mesh_id=? AND t.task_id=? AND l.event_id IN (${ids.map(() => '?').join(',')})`).all(meshId, entityId, ...ids) as { id: string }[]).map(r => r.id) : [];
    const taskViews = kind === 'task' && hasTurns
        ? readTurnTerminalViews(meshId, { db, taskId: entityId, sinceMs: since, tail: 16, excludeIds: [...ids, ...receiptAliases], oldestFirst: true }) : [];
    const exclude = ids.length ? ` AND event_id NOT IN (${ids.map(() => '?').join(',')})` : '';
    const filter = kind === 'task' ? "task_id=? AND kind IN ('task_completed','task_failed','task_cancelled')"
        : "json_extract(payload_json,'$.missionId')=? AND kind IN ('mission_status_changed','mission_created') AND COALESCE(json_extract(payload_json,'$.toStatus'),json_extract(payload_json,'$.status')) IN ('completed','abandoned')";
    const migrationFilter = kind === 'task' && hasTurns
        ? ` AND NOT EXISTS (SELECT 1 FROM turn_attempts t WHERE t.mesh_id=mesh_local_records.mesh_id
            AND t.task_id=mesh_local_records.task_id AND t.terminal_outcome IS NOT NULL
            AND (t.attempt_id=json_extract(payload_json,'$.attemptId') OR event_id=t.attempt_id || '#committed'
                OR (json_extract(payload_json,'$.attemptId') IS NULL AND t.session_id=mesh_local_records.session_id AND t.terminal_at=mesh_local_records.at_ms AND kind='task_' || t.terminal_outcome
                    AND (SELECT COUNT(*) FROM turn_attempts x WHERE x.mesh_id=t.mesh_id AND x.task_id=t.task_id AND x.session_id=t.session_id AND x.terminal_at=t.terminal_at AND x.terminal_outcome=t.terminal_outcome)=1)))` : '';
    const rows = db.prepare(`SELECT event_id,mesh_id,task_id,session_id,node_id,kind,at_ms,
        json_extract(payload_json,'$.missionId') mission_id, COALESCE(json_extract(payload_json,'$.toStatus'),json_extract(payload_json,'$.status')) mission_outcome FROM mesh_local_records WHERE mesh_id=? AND ${filter} AND at_ms>=?${migrationFilter}${exclude} ORDER BY at_ms,event_id LIMIT 16`).all(meshId, entityId, since, ...ids) as any[];
    const legacy = rows.map(r => ({ eventId: r.event_id, meshId: r.mesh_id, taskId: r.task_id ?? null, missionId: r.mission_id ?? null,
        sessionId: r.session_id ?? null, nodeId: r.node_id ?? null, kind: r.kind, at: r.at_ms, sourceMeshId: r.mesh_id, ...(kind === 'task' ? { strength: 'unknown', evidenceLevel: 'weak' } : {}), outcome: kind === 'task' ? r.kind.slice(5) : r.mission_outcome }));
    const durable: TerminalEvent[] = taskViews.map(v => ({ eventId: v.id, meshId, taskId: v.taskId ?? null, missionId: null,
        sessionId: v.sessionId ?? null, nodeId: v.nodeId ?? null, kind: v.kind, at: Date.parse(v.timestamp), sourceMeshId: meshId,
        outcome: String(v.payload.outcome), attemptId: String(v.payload.attemptId), strength: String(v.payload.strength ?? 'unknown'),
        evidenceLevel: ['genuine', 'tool_report', 'operator'].includes(String(v.payload.strength)) ? 'strong' : 'weak' }));
    return [...new Map([...legacy, ...durable].map(e => [e.eventId, e])).values()]
        .sort((a, b) => a.at - b.at || a.eventId.localeCompare(b.eventId)).slice(0, 16);
}

/** Same id on retry, record delivery only after the submit funnel confirms it left the FIFO. */
export async function deliverTerminalEvents(events: readonly TerminalEvent[], watch: TerminalWatch,
    submit: (messageId: string, text: string) => Promise<boolean>, store: TerminalWatchStore,
    opts: { recipient?: string; confirm?: (intent: TerminalDeliveryIntent) => Promise<boolean>; uncertain?: (intent: TerminalDeliveryIntent) => Promise<void> } = {}): Promise<void> {
    const recorded = new Set(store.receipts(watch.watch_id));
    for (const event of events) {
        if (recorded.has(event.eventId)) continue;
        const id = `assistant-terminal:${watch.watch_id}:${event.eventId}`;
        const existing = store.intent(watch.watch_id, event.eventId);
        if (existing) {
            // Crash/queue uncertainty: only exact native delivery evidence may settle it automatically.
            if (!await opts.confirm?.(existing)) {
                if (opts.recipient && opts.recipient !== existing.recipient_session_id) await opts.uncertain?.(existing);
                break;
            }
        } else {
            const intent = store.beginDelivery(watch.watch_id, event.eventId, opts.recipient ?? watch.recipient);
            if (!await submit(id, `[ADHDev task/mission terminal] ${JSON.stringify({ watchId: watch.watch_id, ...event, deliveryToken: intent.token })}`)) break;
        }
        store.acknowledge(watch.watch_id, event.eventId);
        recorded.add(event.eventId);
    }
}
