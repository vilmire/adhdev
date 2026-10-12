import type { Database } from 'better-sqlite3';
import { pageAttemptReport } from './report-continuation.js';
export interface TaskReportCursor { taskId: string; outputVersion?: number; reportId?: string; offset: number }
export function readTaskReportPage(db: Database, meshId: string, cursor: TaskReportCursor): Record<string, unknown> {
    const row = db.prepare(`SELECT version,attempt,status,created_at,
        CASE WHEN length(envelope_json)<=1048576 THEN envelope_json ELSE NULL END envelope_json
        FROM mesh_task_outputs WHERE mesh_id=? AND task_id=? ${cursor.outputVersion === undefined ? '' : 'AND version=?'} ORDER BY version DESC LIMIT 1`)
        .get(...[meshId, cursor.taskId, ...(cursor.outputVersion === undefined ? [] : [cursor.outputVersion])]) as { version: number; attempt: number; status: string; created_at: string; envelope_json: string | null } | undefined;
    if (!row) return { success: false, code: 'original_report_unavailable', reason: 'exact_task_output_not_found' };
    if (!row.envelope_json) return { success: false, code: 'original_report_unavailable', reason: 'task_output_exceeds_recovery_bound' };
    let envelope: any;
    try { envelope = JSON.parse(row.envelope_json); } catch { return { success: false, code: 'original_report_unavailable', reason: 'task_output_invalid' }; }
    if (typeof envelope?.final_summary !== 'string') return { success: false, code: 'original_report_unavailable', reason: 'task_output_has_no_original_summary' };
    const page = pageAttemptReport(envelope.final_summary, { attemptId: String(row.attempt), coordinatorSessionId: '', offset: cursor.offset, reportId: cursor.reportId }, 'mesh_task_outputs');
    if (!page.success) return page;
    const { attemptId: _attemptId, coordinatorSessionId: _sessionId, ...result } = page;
    const sourceComplete = envelope.evidence?.mayBeTruncated === false;
    return { ...result, meshId, taskId: cursor.taskId, outputVersion: row.version, attempt: row.attempt, status: row.status,
        createdAt: row.created_at, sourceComplete, complete: result.complete && sourceComplete,
        ...(sourceComplete ? {} : { originalCompleteness: envelope.evidence?.mayBeTruncated === true ? 'truncated_at_source' : 'unknown', unavailableReason: 'source_does_not_prove_complete_original' }),
        sourceSessionId: typeof envelope.source?.session_id === 'string' ? envelope.source.session_id : null,
        sourceNodeId: typeof envelope.source?.node_id === 'string' ? envelope.source.node_id : null };
}
