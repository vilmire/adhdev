/**
 * Session-control tables (design 2026-11-01 §5.3, §2): the deferred assistant
 * request that must survive a daemon restart, and the daily counters for
 * `session_controls` / `quota_failovers_*`. Additive and idempotent, called from
 * one line in mesh-runtime-store-schema.ts.
 */

export interface SchemaDb {
    exec(sql: string): unknown;
    prepare(sql: string): { all(...a: unknown[]): unknown[] };
}

export const SESSION_CONTROL_METRIC_COLUMNS = ['session_controls', 'quota_failovers_proposed', 'quota_failovers_accepted', 'quota_failovers_auto'] as const;

export function ensureSessionControlSchema(db: SchemaDb): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_session_control (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            job_json TEXT NOT NULL,
            requested_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assistant_quota_failover_log (
            at_ms INTEGER NOT NULL,
            role TEXT NOT NULL,
            mesh_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            mode TEXT NOT NULL,
            from_provider TEXT NOT NULL,
            to_provider TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_quota_failover_log_at ON assistant_quota_failover_log(role, mesh_id, at_ms);
    `);
    const cols = new Set((db.prepare('PRAGMA table_info(assistant_metric_daily)').all() as Array<{ name: string }>).map(r => r.name));
    // Absent only before the assistant relay schema ran; ensureAssistantRelaySchema owns that table.
    if (cols.size === 0) return;
    for (const c of SESSION_CONTROL_METRIC_COLUMNS) {
        if (!cols.has(c)) db.exec(`ALTER TABLE assistant_metric_daily ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    }
}
