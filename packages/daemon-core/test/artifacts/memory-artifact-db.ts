/**
 * Minimal in-memory SQLite stand-in for ArtifactStore unit tests when the
 * workspace better-sqlite3 native binding ABI does not match the Node runtime.
 * Supports only the SQL shapes ArtifactStore uses for register/list/get/prune.
 */

type Row = Record<string, unknown>;

function normalizeRel(rel: string): string {
    return String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
}

export class MemoryArtifactDb {
    private rows: Row[] = [];
    private nextRowid = 1;

    exec(_sql: string): void {
        // CREATE TABLE / INDEX / ALTER — no-op for the in-memory table.
    }

    prepare<RowType = any>(sql: string): {
        run(...params: unknown[]): { changes: number; lastInsertRowid?: number };
        get(...params: unknown[]): RowType | undefined;
        all(...params: unknown[]): RowType[];
    } {
        const text = sql.replace(/\s+/g, ' ').trim();
        return {
            run: (...params: unknown[]) => this.run(text, params),
            get: (...params: unknown[]) => this.get(text, params) as RowType | undefined,
            all: (...params: unknown[]) => this.all(text, params) as RowType[],
        };
    }

    transaction<T extends (...args: any[]) => any>(fn: T): T & { immediate: T } {
        const wrapped = ((...args: any[]) => fn(...args)) as T & { immediate: T };
        wrapped.immediate = wrapped;
        return wrapped;
    }

    private run(sql: string, params: unknown[]): { changes: number; lastInsertRowid?: number } {
        if (sql.startsWith('INSERT INTO session_artifacts')) {
            const row: Row = {
                rowid: this.nextRowid++,
                artifact_id: params[0],
                session_id: params[1],
                task_id: params[2],
                mesh_id: params[3],
                mission_id: params[4],
                producer_role: params[5],
                origin_daemon_id: params[6],
                workspace_root: params[7],
                rel_path: normalizeRel(String(params[8])),
                kind: params[9],
                mime: params[10],
                title: params[11],
                size_bytes: params[12],
                sha256: params[13],
                preview_text: params[14],
                created_at: params[15],
                updated_at: params[16],
            };
            this.rows.push(row);
            return { changes: 1, lastInsertRowid: row.rowid as number };
        }
        if (sql.startsWith('UPDATE session_artifacts')) {
            if (sql.includes('SET task_id = ?, mesh_id = ?, mission_id = ?, producer_role = ?, origin_daemon_id = ?')) {
                // forwarded/update short form ends with WHERE artifact_id = ?
                const artifactId = params[params.length - 1];
                const row = this.rows.find((r) => r.artifact_id === artifactId);
                if (!row) return { changes: 0 };
                row.task_id = params[0];
                row.mesh_id = params[1];
                row.mission_id = params[2];
                row.producer_role = params[3];
                row.origin_daemon_id = params[4];
                row.workspace_root = params[5];
                row.kind = params[6];
                row.mime = params[7];
                row.title = params[8];
                row.size_bytes = params[9];
                row.sha256 = params[10];
                row.preview_text = params[11];
                row.updated_at = params[12];
                return { changes: 1 };
            }
            const artifactId = params[params.length - 1];
            const row = this.rows.find((r) => r.artifact_id === artifactId);
            if (!row) return { changes: 0 };
            row.task_id = params[0];
            row.mesh_id = params[1];
            row.mission_id = params[2];
            row.producer_role = params[3];
            row.origin_daemon_id = params[4];
            row.workspace_root = params[5];
            row.kind = params[6];
            row.mime = params[7];
            row.title = params[8];
            row.size_bytes = params[9];
            row.sha256 = params[10];
            row.preview_text = params[11];
            row.updated_at = params[12];
            return { changes: 1 };
        }
        if (sql.startsWith('DELETE FROM session_artifacts')) {
            // Preservation path should not call this; keep fail-safe no-op for tests.
            return { changes: 0 };
        }
        return { changes: 0 };
    }

    private get(sql: string, params: unknown[]): Row | undefined {
        if (sql.includes('PRAGMA table_info')) {
            return undefined;
        }
        if (sql.includes('SELECT workspace_root FROM session_artifacts WHERE session_id = ? LIMIT 1')) {
            const row = this.rows.find((r) => r.session_id === params[0]);
            return row ? { workspace_root: row.workspace_root } : undefined;
        }
        if (sql.includes('SELECT * FROM session_artifacts WHERE session_id = ? AND rel_path = ?')) {
            return this.rows.find(
                (r) => r.session_id === params[0] && r.rel_path === normalizeRel(String(params[1])),
            );
        }
        if (sql.includes('SELECT 1 AS one FROM session_artifacts WHERE artifact_id = ?')) {
            return this.rows.some((r) => r.artifact_id === params[0]) ? { one: 1 } : undefined;
        }
        if (sql.includes('SELECT * FROM session_artifacts WHERE artifact_id = ?')) {
            return this.rows.find((r) => r.artifact_id === params[0]);
        }
        if (sql.includes('SELECT artifact_id, mesh_id, created_at FROM session_artifacts WHERE artifact_id = ?')) {
            const row = this.rows.find((r) => r.artifact_id === params[0]);
            return row
                ? { artifact_id: row.artifact_id, mesh_id: row.mesh_id ?? null, created_at: row.created_at }
                : undefined;
        }
        if (sql.includes('SELECT COUNT(*) AS count FROM session_artifacts WHERE session_id = ?')) {
            return { count: this.rows.filter((r) => r.session_id === params[0]).length };
        }
        if (sql.includes('SELECT COUNT(*) AS row_count')) {
            return this.admissionTotals();
        }
        if (sql.includes('SELECT artifact_id FROM session_artifacts WHERE mission_id = ? ORDER BY created_at ASC LIMIT 1')) {
            const rows = this.rows
                .filter((r) => r.mission_id === params[0])
                .sort((a, b) => Number(a.created_at) - Number(b.created_at) || Number(a.rowid) - Number(b.rowid));
            return rows[0] ? { artifact_id: rows[0].artifact_id } : undefined;
        }
        return undefined;
    }

    private all(sql: string, params: unknown[]): Row[] {
        if (sql.includes('PRAGMA table_info')) {
            return [
                { name: 'artifact_id' },
                { name: 'session_id' },
                { name: 'task_id' },
                { name: 'mesh_id' },
                { name: 'mission_id' },
                { name: 'producer_role' },
                { name: 'origin_daemon_id' },
                { name: 'workspace_root' },
                { name: 'rel_path' },
                { name: 'kind' },
                { name: 'mime' },
                { name: 'title' },
                { name: 'size_bytes' },
                { name: 'sha256' },
                { name: 'preview_text' },
                { name: 'created_at' },
                { name: 'updated_at' },
            ];
        }
        if (sql.includes('WHERE session_id = ?') && sql.includes('ORDER BY created_at ASC, rowid ASC')) {
            const limit = Number(params[1] ?? 50);
            return this.rows
                .filter((r) => r.session_id === params[0])
                .sort((a, b) => Number(a.created_at) - Number(b.created_at) || Number(a.rowid) - Number(b.rowid))
                .slice(0, limit);
        }
        if (sql.includes('WHERE mission_id = ?') && sql.includes('ORDER BY created_at DESC, window_rowid DESC')) {
            // newestWindowSql wrapper — mission list
            const limit = Number(params[params.length - 1] ?? 200);
            const missionId = params[0];
            const meshId = params.length > 2 ? params[1] : undefined;
            let rows = this.rows.filter((r) => r.mission_id === missionId);
            if (typeof meshId === 'string') rows = rows.filter((r) => r.mesh_id === meshId);
            return rows
                .sort((a, b) => Number(b.created_at) - Number(a.created_at) || Number(b.rowid) - Number(a.rowid))
                .slice(0, limit)
                .sort((a, b) => Number(a.created_at) - Number(b.created_at) || Number(a.rowid) - Number(b.rowid))
                .map((r) => ({ ...r, window_rowid: r.rowid }));
        }
        if (sql.includes('WHERE mesh_id = ?') && sql.includes('ORDER BY created_at DESC, window_rowid DESC')) {
            const limit = Number(params[params.length - 1] ?? 500);
            const meshId = params[0];
            return this.rows
                .filter((r) => r.mesh_id === meshId)
                .sort((a, b) => Number(b.created_at) - Number(a.created_at) || Number(b.rowid) - Number(a.rowid))
                .slice(0, limit)
                .sort((a, b) => Number(a.created_at) - Number(b.created_at) || Number(a.rowid) - Number(b.rowid))
                .map((r) => ({ ...r, window_rowid: r.rowid }));
        }
        if (sql.includes('artifact_id DESC')) {
            // keyset list — params: meshId, [sessionId], [missionId], [kind], [cursor×3], limit
            let rows = this.rows.filter((r) => r.mesh_id === params[0]);
            let p = 1;
            if (sql.includes('session_id = ?')) {
                rows = rows.filter((r) => r.session_id === params[p++]);
            }
            if (sql.includes('AND mission_id = ?') || sql.includes('WHERE mission_id = ?')) {
                rows = rows.filter((r) => r.mission_id === params[p++]);
            }
            if (sql.includes('AND kind = ?') || sql.includes('WHERE kind = ?')) {
                rows = rows.filter((r) => r.kind === params[p++]);
            }
            if (sql.includes('created_at < ?')) {
                const createdAt = Number(params[p]);
                const artifactId = String(params[p + 2]);
                rows = rows.filter(
                    (r) =>
                        Number(r.created_at) < createdAt ||
                        (Number(r.created_at) === createdAt && String(r.artifact_id) < artifactId),
                );
                p += 3;
            }
            const limit = Number(params[params.length - 1]);
            return rows
                .sort(
                    (a, b) =>
                        Number(b.created_at) - Number(a.created_at) ||
                        String(b.artifact_id).localeCompare(String(a.artifact_id)),
                )
                .slice(0, limit);
        }
        return [];
    }

    private admissionTotals(): Row {
        let payload = 0;
        let metadata = 0;
        for (const r of this.rows) {
            payload += Number(r.size_bytes ?? 0);
            const parts = [
                r.artifact_id,
                r.session_id,
                r.task_id,
                r.mesh_id,
                r.mission_id,
                r.producer_role,
                r.origin_daemon_id,
                r.workspace_root,
                r.rel_path,
                r.kind,
                r.mime,
                r.title,
                r.sha256,
                r.preview_text,
            ];
            let utf8 = 48;
            for (const p of parts) {
                if (typeof p === 'string' && p.length) utf8 += Buffer.byteLength(p, 'utf8');
            }
            metadata += Math.max(4096, utf8);
        }
        return { row_count: this.rows.length, payload_bytes: payload, metadata_bytes: metadata };
    }
}
