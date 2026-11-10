/**
 * Periodic light-workspace sweep (housekeeping). `sweepLightWorkspaces` existed but nothing in production ever
 * called it, so per-task workspaces (1-2 GiB each) leaked on any path that did not remove them inline (worker
 * stopped/reclaimed/cancelled, daemon restart mid-task, result_ready never landed).
 */
import { isMeshTerminalTaskStatus } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { sweepLightWorkspaces, type LightWorkspaceSweepReport } from './light-workspace.js';
import { loadLightWorkspaceConfig } from './light-workspace-config.js';
import { listLightWorkspaces, type LightWorkspaceRow } from './mesh-light-workspace-store.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

export const LIGHT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const LIGHT_STALE_DEFAULT_MS = 6 * 60 * 60 * 1000;

/** `ADHDEV_LIGHT_WORKSPACE_STALE_HOURS`: hours untouched before a not-live workspace is swept; 0 disables the whole sweep. */
export function resolveLightWorkspaceStaleMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.ADHDEV_LIGHT_WORKSPACE_STALE_HOURS;
    if (raw === undefined || raw.trim() === '') return LIGHT_STALE_DEFAULT_MS;
    const hours = Number(raw);
    return Number.isFinite(hours) && hours >= 0 ? hours * 3600_000 : LIGHT_STALE_DEFAULT_MS;
}

/** A task is live when its queue row exists and is not terminal. Unknown task => not live. */
function taskLive(store: MeshRuntimeStore, row: LightWorkspaceRow): boolean {
    try {
        const task = store.findQueueEntryById(row.meshId, row.taskId);
        return !!task && !isMeshTerminalTaskStatus(task.status);
    } catch { return true; } // cannot tell: keep
}

export async function runLightWorkspaceSweep(env: NodeJS.ProcessEnv = process.env): Promise<LightWorkspaceSweepReport[]> {
    const staleMs = resolveLightWorkspaceStaleMs(env);
    if (staleMs === 0) return [];
    let store: MeshRuntimeStore;
    try { store = MeshRuntimeStore.getInstance(); } catch { return []; }
    const reports: LightWorkspaceSweepReport[] = [];
    // Registry rows (any state but removed) name the repos; removed-only repos still need the orphan scan, so include all.
    const repos = new Set(listLightWorkspaces(store.db, { excludeRemoved: false }).map(r => r.repoRoot));
    for (const repoRoot of repos) {
        try {
            const cfg = loadLightWorkspaceConfig(repoRoot);
            reports.push(await sweepLightWorkspaces({
                checkoutRoot: repoRoot, db: store.db, ...(cfg.ok ? { config: cfg.config } : {}),
                staleUntouchedMs: staleMs, isTaskLive: row => taskLive(store, row),
                log: m => LOG.info('LightWorkspace', m),
            }));
        } catch (e: any) {
            LOG.warn('LightWorkspace', `sweep failed for ${repoRoot}: ${e?.message || e}`);
        }
    }
    return reports;
}
