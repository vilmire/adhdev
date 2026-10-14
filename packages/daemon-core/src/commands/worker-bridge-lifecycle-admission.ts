import { assertMaintenanceLifecycle } from '../maintenance/cooperative-gate.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { getConfigDir } from '../config/config.js';
import { loadBetterSqlite3 } from '../system/load-better-sqlite3.js';

const observedStrict = new Set<string>();

function refuse(reason: string): never {
    throw Object.assign(new Error('strict_bridge_lifecycle_authority_unavailable'), {
        code: 'strict_bridge_lifecycle_authority_unavailable', reason,
    });
}

function hasPolicy(db: Database.Database): boolean {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_bridge_policy'").get();
    return !!table && !!db.prepare('SELECT 1 FROM worker_bridge_policy LIMIT 1').get();
}

/**
 * Containment only: metadata cannot grant native lifecycle authority. No force,
 * claimed authority, released journal or unfrozen policy bypasses strict state.
 * A detached helper checks both its own namespace and the requested target.
 * Never initialize/migrate the store, read worker content or repair unknown state.
 */
export function assertWorkerBridgeLifecycleAdmission(
    operation: string, requestedConfigDir?: string, trustedDb?: Database.Database,
): void {
    const current = getConfigDir();
    for (const candidate of new Set([current, requestedConfigDir ?? current])) {
        let root = path.resolve(candidate);
        try {
            let rootStat: fs.Stats | undefined;
            try { rootStat = fs.lstatSync(root); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            if (rootStat) {
                if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) refuse('instance_namespace_unknown');
                root = fs.realpathSync(root);
            }
            if (observedStrict.has(root)) refuse('previously_observed_strict_instance');
            if (trustedDb && hasPolicy(trustedDb)) {
                observedStrict.add(root);
                refuse(operation);
            }
            for (const name of [
                'worker-bridge-supervisor.json', 'worker-bridge-launchd-exclusion.json',
                'worker-bridge-lifecycle-fence.json', 'session-host/upgrade-lease.json',
            ]) {
                try {
                    fs.lstatSync(path.join(root, name));
                    observedStrict.add(root);
                    refuse('bridge_journal_present');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
            const dir = path.join(root, 'mesh-ledger');
            let stat: fs.Stats;
            try { stat = fs.lstatSync(dir); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
            }
            if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('ledger_namespace_unknown');
            let found = false;
            for (const name of ['mesh-runtime.db', 'beads.db']) {
                const file = path.join(dir, name);
                let fileStat: fs.Stats;
                try { fileStat = fs.lstatSync(file); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                    throw error;
                }
                found = true;
                if (!fileStat.isFile() || fileStat.isSymbolicLink()) refuse('ledger_file_unknown');
                const Ctor = loadBetterSqlite3();
                const db = new Ctor(file, { readonly: true, fileMustExist: true });
                try {
                    if (hasPolicy(db)) { observedStrict.add(root); refuse(operation); }
                } finally { db.close(); }
            }
            if (!found) refuse('ledger_missing_not_proven_ordinary');
        } catch (error) {
            if ((error as { code?: string }).code === 'strict_bridge_lifecycle_authority_unavailable') throw error;
            refuse('bridge_state_unreadable');
        }
    }
    // Independent cooperative gate; never authorizes or modifies strict state.
    for (const candidate of new Set([current, requestedConfigDir ?? current])) assertMaintenanceLifecycle(operation, candidate);
}
