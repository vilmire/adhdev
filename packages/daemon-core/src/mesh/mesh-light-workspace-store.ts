/**
 * LIGHT-TASK: `mesh_light_workspaces` registry (design §10). Local-only, never
 * projected to the cloud status path. State machine:
 *   preparing -> ready -> in_use -> result_ready -> landed | discarded | failed -> removed
 */
import type { Database as DatabaseHandle } from 'better-sqlite3';

export type LightWorkspaceState =
    | 'preparing' | 'ready' | 'in_use' | 'result_ready' | 'landed' | 'discarded' | 'failed' | 'removed';

export interface LightWorkspaceRow {
    workspaceId: string;
    meshId: string;
    taskId: string;
    repoRoot: string;
    path: string;
    rootBaseSha: string;
    submoduleBases: Record<string, string>;
    branchRefs: Record<string, string>;
    state: LightWorkspaceState;
    createdAt: string;
    updatedAt: string;
    lastError?: string;
    /** Expanded node_modules dirs of the base checkout (from the config at prepare time). */
    linkDirs: string[];
    /** Daemon-held shared-checkout baseline (JSON); the worker can never write it. */
    fingerprintJson?: string;
}

export function ensureLightWorkspaceSchema(db: DatabaseHandle): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS mesh_light_workspaces (
            workspace_id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            repo_root TEXT NOT NULL,
            path TEXT NOT NULL,
            root_base_sha TEXT NOT NULL,
            submodule_bases_json TEXT NOT NULL DEFAULT '{}',
            branch_refs_json TEXT NOT NULL DEFAULT '{}',
            state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_error TEXT,
            link_dirs_json TEXT NOT NULL DEFAULT '[]',
            fingerprint_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mesh_light_workspaces_task ON mesh_light_workspaces(mesh_id, task_id);
        CREATE INDEX IF NOT EXISTS idx_mesh_light_workspaces_state ON mesh_light_workspaces(state);
    `);
    const cols = new Set((db.prepare('PRAGMA table_info(mesh_light_workspaces)').all() as Array<{ name: string }>).map(c => c.name));
    if (!cols.has('link_dirs_json')) db.exec(`ALTER TABLE mesh_light_workspaces ADD COLUMN link_dirs_json TEXT NOT NULL DEFAULT '[]'`);
    if (!cols.has('fingerprint_json')) db.exec('ALTER TABLE mesh_light_workspaces ADD COLUMN fingerprint_json TEXT');
}

function fromRow(r: any): LightWorkspaceRow {
    const parse = (s: string) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
    return {
        workspaceId: r.workspace_id, meshId: r.mesh_id, taskId: r.task_id, repoRoot: r.repo_root, path: r.path,
        rootBaseSha: r.root_base_sha, submoduleBases: parse(r.submodule_bases_json), branchRefs: parse(r.branch_refs_json),
        state: r.state, createdAt: r.created_at, updatedAt: r.updated_at, ...(r.last_error ? { lastError: r.last_error } : {}),
        linkDirs: parse(r.link_dirs_json) instanceof Array ? parse(r.link_dirs_json) : [], ...(r.fingerprint_json ? { fingerprintJson: r.fingerprint_json } : {}),
    };
}

export function upsertLightWorkspace(db: DatabaseHandle, row: LightWorkspaceRow): void {
    db.prepare(`
        INSERT INTO mesh_light_workspaces (workspace_id, mesh_id, task_id, repo_root, path, root_base_sha, submodule_bases_json, branch_refs_json, state, created_at, updated_at, last_error, link_dirs_json)
        VALUES (@workspaceId, @meshId, @taskId, @repoRoot, @path, @rootBaseSha, @sub, @refs, @state, @createdAt, @updatedAt, @lastError, @linkDirs)
        ON CONFLICT(workspace_id) DO UPDATE SET
            path = excluded.path, root_base_sha = excluded.root_base_sha, submodule_bases_json = excluded.submodule_bases_json,
            branch_refs_json = excluded.branch_refs_json, state = excluded.state, updated_at = excluded.updated_at, last_error = excluded.last_error
    `).run({
        ...row, sub: JSON.stringify(row.submoduleBases), refs: JSON.stringify(row.branchRefs), lastError: row.lastError ?? null, linkDirs: JSON.stringify(row.linkDirs),
    });
}

export function setLightWorkspaceState(db: DatabaseHandle, workspaceId: string, state: LightWorkspaceState, lastError?: string): void {
    db.prepare('UPDATE mesh_light_workspaces SET state = ?, updated_at = ?, last_error = COALESCE(?, last_error) WHERE workspace_id = ?')
        .run(state, new Date().toISOString(), lastError ?? null, workspaceId);
}

export function setLightWorkspaceFingerprint(db: DatabaseHandle, workspaceId: string, fingerprint: unknown): void {
    db.prepare('UPDATE mesh_light_workspaces SET fingerprint_json = ? WHERE workspace_id = ?').run(JSON.stringify(fingerprint), workspaceId);
}

export function getLightWorkspace(db: DatabaseHandle, workspaceId: string): LightWorkspaceRow | undefined {
    const r = db.prepare('SELECT * FROM mesh_light_workspaces WHERE workspace_id = ?').get(workspaceId);
    return r ? fromRow(r) : undefined;
}

export function getLightWorkspaceForTask(db: DatabaseHandle, meshId: string, taskId: string): LightWorkspaceRow | undefined {
    const r = db.prepare(`SELECT * FROM mesh_light_workspaces WHERE mesh_id = ? AND task_id = ? AND state != 'removed' ORDER BY created_at DESC LIMIT 1`).get(meshId, taskId);
    return r ? fromRow(r) : undefined;
}

/** The light workspace registered at `wsPath` (removed rows included: the path still marks a light session). */
export function findLightWorkspaceByPath(db: DatabaseHandle, wsPath: string): LightWorkspaceRow | undefined {
    const r = db.prepare('SELECT * FROM mesh_light_workspaces WHERE path = ? ORDER BY created_at DESC LIMIT 1').get(wsPath);
    return r ? fromRow(r) : undefined;
}

export function listLightWorkspaces(db: DatabaseHandle, opts: { states?: LightWorkspaceState[]; excludeRemoved?: boolean } = {}): LightWorkspaceRow[] {
    const rows = db.prepare('SELECT * FROM mesh_light_workspaces ORDER BY created_at ASC').all().map(fromRow);
    return rows.filter(r => (opts.states ? opts.states.includes(r.state) : true) && (opts.excludeRemoved === false ? true : r.state !== 'removed'));
}

export function countLiveLightWorkspaces(db: DatabaseHandle): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM mesh_light_workspaces WHERE state NOT IN ('removed')`).get() as any).n as number;
}
