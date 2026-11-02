/** Cross-process project approval cut. App writers share this lock with the
 * handoff snapshot boundary; no lock for one project blocks another project. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAssistantProject } from '../../assistant/assistant-projects.js';
import { acquireOwnedLock, type OwnedLockResult } from '../../launch-defaults/owned-lock.js';
import { loadBetterSqlite3 } from '../../system/load-better-sqlite3.js';

function refused(detail: string): never {
    throw Object.assign(new Error(`project_host_handoff_fenced: ${detail}`), { code: 'project_host_handoff_fenced' });
}
function resolveProject(configDir: string, reference: string): string {
    const path = join(configDir, 'meshes.json');
    if (!existsSync(path)) {
        if (existsSync(join(configDir, 'mesh-ledger', 'mesh-runtime.db'))) refused('project inventory unavailable');
        return reference; // Fresh stores without any project inventory/history.
    }
    let config: any;
    try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { refused('project inventory unreadable'); }
    if (!Array.isArray(config?.meshes)) refused('project inventory invalid');
    const resolved = resolveAssistantProject(reference, config.meshes as Array<{ id: string }>);
    if (!resolved.ok) refused('project reference is unavailable or ambiguous');
    return resolved.mesh.id;
}
function assertWritable(configDir: string, meshId: string): void {
    const path = join(configDir, 'meshes.json');
    if (existsSync(path)) {
        let config: any;
        try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { refused('project inventory unreadable'); }
        const mesh = config?.meshes?.find((m: any) => m.id === meshId);
        if (!mesh || mesh.meshHost?.handoffFence !== undefined || mesh.meshHost?.handedOffTo) refused('project is frozen or its approvals moved to another host');
    }
    const mesh = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).meshes.find((m: any) => m.id === meshId) : undefined;
    if (projectHasDurableWriteCut(configDir, meshId, mesh?.meshHost?.hostEpoch ?? 0)) refused('durable project cut is held');
}

/** Read-only and explicitly config-scoped, never the process's inherited config.
 * Config writers need only the transfer cut; old source approval files remain
 * read-only history until a later certified return to a higher epoch. */
export function projectHasDurableWriteCut(configDir: string, meshId: string, epoch: number, includeHistory = true): boolean {
    const database = join(configDir, 'mesh-ledger', 'mesh-runtime.db');
    if (!existsSync(database)) return false;
    let db: import('better-sqlite3').Database | undefined;
    try {
        const Database = loadBetterSqlite3({ allowCwdFallback: false });
        db = new Database(database, { readonly: true, fileMustExist: true, timeout: 500 });
        const has = (table: string) => db!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (has('mesh_host_write_fences') && db.prepare(`SELECT 1 FROM mesh_host_write_fences WHERE mesh_id=? ${includeHistory ? '' : "AND mode!='history'"}`).get(meshId)) return true;
        if (has('mesh_host_handoff')) {
            const source = db.prepare("SELECT epoch,phase FROM mesh_host_handoff WHERE mesh_id=? AND role='source' ORDER BY epoch DESC LIMIT 1").get(meshId) as { epoch: number; phase: string } | undefined;
            const cut = ['frozen', 'exporting', 'exported', 'awaiting_ack', 'acked', 'activating', 'uncertain', ...(includeHistory ? ['committed'] : [])];
            if (source && cut.includes(source.phase) && epoch <= source.epoch) return true;
        }
        return false;
    } catch { return refused('durable project cut is unverifiable'); }
    finally { db?.close(); }

}

export function acquireProjectFileCut(configDir: string, meshId: string): Extract<OwnedLockResult, { ok: true }> {
    const dir = join(configDir, 'assistant', 'project-write-cuts');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(meshId).digest('hex');
    const lock = acquireOwnedLock(join(dir, `${key}.lock`), { probePeerIdentity: true });
    if (!lock.ok) refused('a project approval writer is in flight or its lock is uncertain');
    return lock;
}

/** The lock survives async owner apply callbacks; concurrent calls in this
 * process do not share/reenter the permit. Missing/fenced authority refuses. */
export function withProjectApprovalWrite<T>(configDir: string, reference: string | undefined, operation: () => T): T {
    if (!reference) return operation(); // Global assistant state stays local.
    const meshId = resolveProject(configDir, reference);
    const lock = acquireProjectFileCut(configDir, meshId);
    try {
        assertWritable(configDir, meshId);
        const result = operation();
        if (result && typeof (result as any).then === 'function') return Promise.resolve(result).finally(() => lock.release()) as T;
        lock.release();
        return result;
    } catch (e) { lock.release(); throw e; }
}

export function canWriteProjectApproval(configDir: string, reference: string | undefined): boolean {
    try { return withProjectApprovalWrite(configDir, reference, () => true); } catch { return false; }
}
