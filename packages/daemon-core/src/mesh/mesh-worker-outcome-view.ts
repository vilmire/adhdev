/**
 * Read-only compatibility for the old worker blocked → failed mapping.
 * Never changes queue/output/turn history. A branch label alone proves nothing:
 * require the latest attempt's tool-report terminal AND its immutable output.
 * A later runtime failure, retry, or unproven record remains failed.
 */
import type { MeshRuntimeStore } from './mesh-runtime-store.js';

export interface WorkerBlockedProvenance {
    storedStatus: 'failed';
    derivedFrom: 'worker_tool_report';
    attemptId: string;
    generation: number;
    outputVersion: number;
}

export function legacyWorkerBlockedTasks(store: Pick<MeshRuntimeStore, 'db'>, meshId: string): Map<string, WorkerBlockedProvenance> {
    // Older/partial stores may lack an output plane: absence never proves blocked.
    if ((store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('mesh_queue', 'mesh_task_outputs', 'turn_attempts', 'turn_events')").get() as { n: number }).n !== 4) return new Map();
    const rows = store.db.prepare(`
        SELECT q.id, a.attempt_id, a.generation, a.attempt_no, a.session_id, a.data_json,
               o.version, o.attempt, o.envelope_json
        FROM mesh_queue q
        JOIN turn_attempts a ON a.mesh_id = q.mesh_id AND a.task_id = q.id
        JOIN mesh_task_outputs o ON o.mesh_id = q.mesh_id AND o.task_id = q.id
        WHERE q.mesh_id = ? AND q.status = 'failed'
          AND a.attempt_no = (SELECT MAX(x.attempt_no) FROM turn_attempts x WHERE x.mesh_id = q.mesh_id AND x.task_id = q.id)
          AND a.terminal_outcome = 'failed' AND a.terminal_reason = 'worker_reported' AND a.terminal_strength = 'tool_report'
          AND o.version = (SELECT MAX(x.version) FROM mesh_task_outputs x WHERE x.task_id = q.id)
          AND o.status = 'failed'
          AND EXISTS (SELECT 1 FROM turn_events e WHERE e.attempt_id = a.attempt_id AND e.generation = a.generation
                      AND e.kind = 'worker_tool_report' AND e.source = 'worker_tool' AND e.verdict = 'recorded'
                      AND e.session_id = a.session_id AND CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$.outcome') END = 'blocked')
    `).all(meshId) as Array<{ id: string; attempt_id: string; generation: number; attempt_no: number; session_id: string; data_json: string; version: number; attempt: number; envelope_json: string }>;
    const out = new Map<string, WorkerBlockedProvenance>();
    for (const row of rows) {
        try {
            const data = JSON.parse(row.data_json);
            const envelope = JSON.parse(row.envelope_json);
            if (envelope.task_id !== row.id || data.report?.generation !== row.generation || data.report?.outcome !== 'blocked'
                || row.attempt !== row.attempt_no + 1 || envelope.status !== 'failed'
                || envelope.evidence?.summarySource !== 'tool_report' || envelope.evidence?.reportedOutcome !== 'blocked'
                || envelope.evidence?.mayBeTruncated !== false || envelope.source?.session_id !== row.session_id) continue;
            out.set(row.id, { storedStatus: 'failed', derivedFrom: 'worker_tool_report', attemptId: row.attempt_id, generation: row.generation, outputVersion: row.version });
        } catch { /* malformed or incomplete evidence cannot relabel a failure */ }
    }
    return out;
}

export function projectWorkerOutcomeViews<T extends { id: string; status: string }>(store: MeshRuntimeStore, meshId: string, tasks: readonly T[]): T[] {
    if (!tasks.some(t => t.status === 'failed')) return [...tasks];
    const proven = legacyWorkerBlockedTasks(store, meshId);
    return tasks.map(task => {
        const statusProvenance = proven.get(task.id);
        return task.status === 'failed' && statusProvenance ? { ...task, status: 'blocked', statusProvenance } : task;
    });
}
