import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { type MeshTurnAttemptRow, meshTurnAttemptFromRow } from './mesh-runtime-store-turn-rows.js';

/** The `better-sqlite3` surface these helpers need. */
export interface UnsettledTerminalQueryDb {
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
    };
}

export function selectUnsettledTerminalQueueRowsAndAttempts(
    db: UnsettledTerminalQueryDb,
    meshId: string,
    terminalOutcomes: string[]
): Array<{ queueRow: MeshWorkQueueEntry; attempt: MeshTurnAttemptRow }> {
    if (!terminalOutcomes.length) return [];
    const placeholders = terminalOutcomes.map(() => '?').join(', ');
    
    const sql = `
        SELECT q.payload AS queue_payload,
               a.*
        FROM mesh_queue q
        INNER JOIN mesh_turn_attempts a ON a.mesh_id = q.mesh_id AND a.task_id = q.id
        WHERE q.mesh_id = ?
          AND q.status IN (${placeholders})
          AND (a.terminal_outcome IS NULL OR a.terminal_outcome = '')
          AND a.stage NOT IN (${placeholders})
          AND a.attempt_seq = (SELECT MAX(attempt_seq) FROM mesh_turn_attempts a2
                               WHERE a2.mesh_id = q.mesh_id AND a2.task_id = q.id)
    `;
    
    const rows = db.prepare(sql).all(
        meshId,
        ...terminalOutcomes,
        ...terminalOutcomes
    ) as Array<Record<string, unknown>>;
    
    return rows.map(r => {
        const queueRow = JSON.parse(r.queue_payload as string) as MeshWorkQueueEntry;
        const attempt = meshTurnAttemptFromRow(r);
        return { queueRow, attempt };
    });
}
