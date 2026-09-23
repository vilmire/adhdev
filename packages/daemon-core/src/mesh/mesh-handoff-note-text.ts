/**
 * WORKER-MCP decision C: handoff note TEXT (`mesh_handoff_note_text`).
 *
 * The note's META index row lives in `turn_events` (C-W8; content-free — lengths
 * and file paths only, written through `TurnStore.insertWorkerEvent`). The TEXT
 * lives in its own local table because the ledger is the meta index by design
 * §9.1 and must not hold authored prose. Split out of the retired
 * `mesh-turn-event-queries.ts` (whose legacy turn-event table queries went with
 * the table); MeshRuntimeStore keeps thin delegators.
 */

/** The `better-sqlite3` surface these helpers need, without importing the driver. */
export interface HandoffNoteTextDb {
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
        run(...params: unknown[]): { changes?: number };
    };
}

// It previously lived only in an in-process Map, which made every note
// undeliverable after a restart while report_completion still claimed it was
// stored.

export interface HandoffNoteTextRow {
    meshId: string;
    taskId: string;
    attemptId?: string;
    nodeId?: string;
    /** JSON-encoded WorkerHandoffNotes. Parsed by the caller that owns the type. */
    notesJson: string;
    recordedAt: string;
}

/** Upsert one note's text. REPLACE so a re-report supersedes rather than duplicates. */
export function upsertHandoffNoteText(db: HandoffNoteTextDb, row: HandoffNoteTextRow): void {
    db.prepare(`
        INSERT OR REPLACE INTO mesh_handoff_note_text (
            mesh_id, task_id, attempt_id, node_id, notes_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        row.meshId, row.taskId, row.attemptId ?? null, row.nodeId ?? null,
        row.notesJson, row.recordedAt,
    );
}

/** One note's text, or null when this daemon never held it. */
export function selectHandoffNoteText(
    db: HandoffNoteTextDb,
    meshId: string,
    taskId: string,
): HandoffNoteTextRow | null {
    const rows = db.prepare(
        'SELECT * FROM mesh_handoff_note_text WHERE mesh_id = ? AND task_id = ? LIMIT 1',
    ).all(meshId, taskId) as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) return null;
    return {
        meshId: r.mesh_id as string,
        taskId: r.task_id as string,
        ...(r.attempt_id ? { attemptId: r.attempt_id as string } : {}),
        ...(r.node_id ? { nodeId: r.node_id as string } : {}),
        notesJson: r.notes_json as string,
        recordedAt: r.recorded_at as string,
    };
}

/**
 * Delete note texts recorded before `cutoffIso`, mirroring the META row's own
 * retention sweep. Returns the row count so the sweep logs what it removed.
 */
export function deleteHandoffNoteTextOlderThan(db: HandoffNoteTextDb, cutoffIso: string): number {
    const res = db.prepare('DELETE FROM mesh_handoff_note_text WHERE recorded_at < ?').run(cutoffIso);
    return res.changes ?? 0;
}
