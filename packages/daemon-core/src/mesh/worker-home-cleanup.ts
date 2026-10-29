/**
 * Worker private-HOME lifecycle: removal at session end + a bounded stale sweep.
 *
 * Why (mission 5800bde3, live 2026-10-29): every delegated launch gets its own HOME under
 * `$TMPDIR/adhdev-worker-home/<provider>-<hash>` (keyed by provider+workspace+session id)
 * and nothing ever removed them — 647 directories / 12 GB. The daemon itself only writes
 * symlinks and a few small config files there; the weight is what the CLI writes into its
 * HOME while it runs (codex: sqlite state/logs, cache, plugins; cursor-agent: its own
 * runtime/cache), so "copy less" is not possible from our side — deleting dead homes is.
 *
 * Owner rule: delete only OLD ones, never wholesale. So:
 *  1. `terminated` (any cause except `daemon_shutdown`, where the hosted worker keeps
 *     running and comes back on restore) removes that session's own home;
 *  2. the hourly housekeeping sweep removes homes that belong to no live session AND
 *     whose newest file is older than `WORKER_HOME_SWEEP_MAX_AGE_MS` (3 h).
 * The sweep touches only directories named `<provider>-<16 hex>` directly under the base
 * dir, never follows symlinks (the imported auth/transcript links point into the owner's
 * real home — `rmSync` unlinks the link, not the target) and re-checks containment.
 */
import { lstatSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { LOG } from '../logging/logger.js';
import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';
import { defaultWorkerHomeBaseDir, workerPrivateHomePath } from './worker-private-home.js';

export const WORKER_HOME_SWEEP_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const HOME_DIR_NAME = /^[a-z0-9][a-z0-9-]*-[0-9a-f]{16}$/;
const MAX_ENTRIES_SCANNED = 400;

/** Remove one home safely: must be a real directory directly under `baseDir` with a home-shaped name. */
export function removeWorkerHomeDir(home: string, baseDir: string = defaultWorkerHomeBaseDir()): boolean {
    const base = path.resolve(baseDir);
    const target = path.resolve(home);
    if (path.dirname(target) !== base || !HOME_DIR_NAME.test(path.basename(target))) return false;
    try {
        if (!lstatSync(target).isDirectory()) return false; // a symlink or file is never ours to recurse into
        rmSync(target, { recursive: true, force: true });
        return true;
    } catch (e: any) {
        if (e?.code !== 'ENOENT') LOG.warn('WorkerHome', `could not remove ${target}: ${e?.message || e}`);
        return false;
    }
}

/** Newest mtime among the home's top-level entries and one level below (lstat — links are not followed). */
export function workerHomeLastUsedMs(home: string): number {
    let newest = 0;
    const visit = (dir: string, depth: number): void => {
        let names: string[];
        try { names = readdirSync(dir); } catch { return; }
        for (const name of names.slice(0, MAX_ENTRIES_SCANNED)) {
            try {
                const st = lstatSync(path.join(dir, name));
                if (st.mtimeMs > newest) newest = st.mtimeMs;
                if (depth < 1 && st.isDirectory()) visit(path.join(dir, name), depth + 1);
            } catch { /* raced with the CLI */ }
        }
    };
    try { newest = lstatSync(home).mtimeMs; } catch { return 0; }
    visit(home, 0);
    return newest;
}

export interface WorkerHomeSweepResult { removed: string[]; keptLive: number; keptRecent: number }

/**
 * Remove homes that are neither in `liveHomes` nor used within `maxAgeMs`. Pure over the
 * filesystem it is pointed at (tests use a temp base dir).
 */
export function sweepStaleWorkerHomes(opts: {
    baseDir?: string;
    liveHomes: ReadonlySet<string>;
    nowMs?: number;
    maxAgeMs?: number;
}): WorkerHomeSweepResult {
    const base = path.resolve(opts.baseDir || defaultWorkerHomeBaseDir());
    const nowMs = opts.nowMs ?? Date.now();
    const maxAgeMs = opts.maxAgeMs ?? WORKER_HOME_SWEEP_MAX_AGE_MS;
    const out: WorkerHomeSweepResult = { removed: [], keptLive: 0, keptRecent: 0 };
    let names: string[];
    try { names = readdirSync(base); } catch { return out; }
    for (const name of names) {
        if (!HOME_DIR_NAME.test(name)) continue;
        const home = path.join(base, name);
        if (opts.liveHomes.has(home)) { out.keptLive++; continue; }
        if (nowMs - workerHomeLastUsedMs(home) <= maxAgeMs) { out.keptRecent++; continue; }
        if (removeWorkerHomeDir(home, base)) out.removed.push(name);
    }
    return out;
}

/**
 * Homes of the sessions that are alive right now. The launch keys a home by the runtime
 * session id (`cli-manager-launch.ts` passes `delegatedSessionKey`), so live state →
 * (type, workspace, instanceId) reproduces the exact path. A session launched with a
 * different key simply is not recognised here and falls back to the age rule.
 */
export function liveWorkerHomes(
    states: ReadonlyArray<{ type?: string; workspace?: string | null; instanceId?: string }> | undefined,
    baseDir?: string,
): Set<string> {
    const live = new Set<string>();
    for (const st of states ?? []) {
        if (!st?.type || !st.instanceId) continue;
        live.add(workerPrivateHomePath(st.type, st.workspace || '', st.instanceId, baseDir));
    }
    return live;
}

/** Session end → remove that session's own home. */
export function subscribeWorkerHomeCleanup(bus: SessionLifecycleBus, baseDir?: string): Unsubscribe {
    return bus.on('terminated', (event) => {
        if (event.cause === 'daemon_shutdown') return;
        try {
            const home = workerPrivateHomePath(event.providerType, event.workspace || '', event.sessionId, baseDir);
            if (removeWorkerHomeDir(home, baseDir)) LOG.info('WorkerHome', `removed private HOME of ended session ${event.sessionId}`);
        } catch (e: any) {
            LOG.warn('WorkerHome', `private HOME cleanup failed for ${event.sessionId}: ${e?.message || e}`);
        }
    }, { name: 'mesh.worker-home-cleanup' });
}
