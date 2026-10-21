// ---------------------------------------------------------------------------
// mesh-refine-lanes — REFINE-LANES executor: runs a validated schedule
// (refine-schedule.ts) phase by phase, lanes in parallel, and on the first
// failure cancels every other running lane by killing its WHOLE process tree.
//
// Why the whole tree: a gate is usually `npm run x`, i.e. npm → sh → node →
// workers (vitest forks, node --test file processes, and the detached fixture
// children some suites launch). Killing only the npm pid leaves the rest
// running — still writing dists, still holding ports and CPU — after the
// Refinery has already moved on (the orphan lesson). So scheduled commands are
// spawned as their own process group, and cancel snapshots the descendant tree
// (by ppid, which also catches setsid'ed grandchildren a group kill misses)
// before signalling it: SIGTERM, a short grace, then SIGKILL.
//
// This module owns only scheduling and cancellation. Spawning, output capture
// and result recording stay in mesh-refine-gates.ts (passed in as `runCommand`)
// so a scheduled gate is recorded exactly like a serial one.
// ---------------------------------------------------------------------------

import { execFile, spawn } from 'node:child_process';
import type { MeshRefineValidationCommandPlan } from './refine-config.js';

export type RefineLaneCommandOutcome = 'passed' | 'failed' | 'blocked' | 'cancelled';

/** Per-command handle: the executor registers its child so cancel can reach it. */
export interface RefineLaneCommandHandle {
    /** True once the run has been aborted (by another lane's failure). */
    readonly aborted: boolean;
    /** Register the spawned child (call once, right after spawn). */
    attach(child: { pid?: number } | undefined): void;
}

export interface ScheduledRefinePhase {
    id: string;
    concurrency: number;
    lanes: Array<{ id: string; env?: Record<string, string>; commands: MeshRefineValidationCommandPlan[] }>;
}

export interface ScheduledRefineRunReport {
    aborted: boolean;
    phases: Array<{ id: string; durationMs: number; lanes: Array<{ id: string; durationMs: number; commands: string[]; outcome: 'passed' | 'failed' | 'cancelled' | 'not_started' }> }>;
}

const KILL_GRACE_MS = 3_000;

function listDescendantPids(rootPid: number): Promise<number[]> {
    return new Promise(resolve => {
        execFile('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }, (error, stdout) => {
            if (error || typeof stdout !== 'string') { resolve([]); return; }
            const children = new Map<number, number[]>();
            for (const line of stdout.split('\n')) {
                const [pid, ppid] = line.trim().split(/\s+/).map(n => Number.parseInt(n, 10));
                if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
                const list = children.get(ppid) || [];
                list.push(pid);
                children.set(ppid, list);
            }
            const out: number[] = [];
            const queue = [rootPid];
            while (queue.length) {
                const next = queue.shift() as number;
                for (const child of children.get(next) || []) {
                    if (!out.includes(child) && child !== rootPid) { out.push(child); queue.push(child); }
                }
            }
            resolve(out);
        });
    });
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
    try { process.kill(pid, signal); } catch { /* already gone */ }
}

/**
 * Kill a scheduled gate's whole process tree. POSIX: the child leads its own
 * process group (spawned detached), so signal the group AND every descendant
 * found by ppid walk (a setsid'ed grandchild leaves the group but keeps its
 * ppid). win32: `taskkill /T /F` walks the tree itself.
 */
export async function killRefineProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (platform === 'win32') {
        await new Promise<void>(resolve => {
            execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => resolve());
        });
        return;
    }
    const descendants = await listDescendantPids(pid);
    signalPid(-pid, 'SIGTERM');
    for (const child of descendants) signalPid(child, 'SIGTERM');
    await new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS));
    // Re-walk from the survivors too: a process that forked during the grace
    // window is caught by this second pass.
    const late = await listDescendantPids(pid);
    signalPid(-pid, 'SIGKILL');
    for (const child of new Set([...descendants, ...late])) signalPid(child, 'SIGKILL');
}

/**
 * execFile-compatible runner that starts the child as its own process group
 * (POSIX `detached`; execFile itself drops that option, so it cannot be used
 * here). Same callback contract the gate already relies on: a non-zero exit
 * yields an Error carrying numeric `code`, `signal`, `killed`, `stdout`,
 * `stderr`; a spawn failure yields the spawn error (e.g. ENOENT); exceeding
 * `maxBuffer` kills the tree and reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
 */
export function spawnRefineProcessGroup(
    file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: any, stdout: string, stderr: string) => void,
): ReturnType<typeof spawn> {
    const { maxBuffer, timeout: _timeout, encoding: _encoding, ...spawnOptions } = options;
    const limit = typeof maxBuffer === 'number' && maxBuffer > 0 ? maxBuffer : Infinity;
    const child = spawn(file, args, { ...spawnOptions, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] } as any);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let overflow: any;
    const finish = (error: any) => {
        if (settled) return;
        settled = true;
        callback(error, stdout, stderr);
    };
    const collect = (which: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
        if (overflow) return;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (which === 'stdout') stdout += text; else stderr += text;
        if (stdout.length > limit || stderr.length > limit) {
            overflow = Object.assign(new Error(`${which} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
            if (child.pid) void killRefineProcessTree(child.pid);
        }
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    child.on('error', error => finish(error));
    child.on('close', (code, signal) => {
        if (overflow) { finish(overflow); return; }
        if (code === 0) { finish(null); return; }
        const error: any = new Error(`Command failed: ${[file, ...args].join(' ')}\n${stderr}`);
        error.code = code;
        error.signal = signal;
        error.killed = !!signal;
        finish(error);
    });
    return child;
}

/**
 * Run the scheduled phases. `runCommand` executes + records one command and
 * reports its outcome; it must record a genuine failure synchronously before
 * resolving 'failed' so the first failure is the first `passed:false` record.
 */
export async function runScheduledRefinePhases(
    phases: ScheduledRefinePhase[],
    runCommand: (candidate: MeshRefineValidationCommandPlan, laneEnv: Record<string, string> | undefined, handle: RefineLaneCommandHandle) => Promise<RefineLaneCommandOutcome>,
    killTree: (pid: number) => Promise<void> = killRefineProcessTree,
): Promise<ScheduledRefineRunReport> {
    let aborted = false;
    const live = new Set<number>();
    const kills: Promise<void>[] = [];
    const abort = () => {
        if (aborted) return;
        aborted = true;
        for (const pid of live) kills.push(killTree(pid));
    };
    const report: ScheduledRefineRunReport = { aborted: false, phases: [] };

    for (const phase of phases) {
        if (aborted) break;
        const phaseStarted = Date.now();
        const laneReports = phase.lanes.map(lane => ({ id: lane.id, durationMs: 0, commands: lane.commands.map(c => c.displayCommand), outcome: 'not_started' as ScheduledRefineRunReport['phases'][number]['lanes'][number]['outcome'] }));
        let nextLane = 0;
        const worker = async () => {
            while (!aborted && nextLane < phase.lanes.length) {
                const index = nextLane++;
                const lane = phase.lanes[index];
                const laneStarted = Date.now();
                let outcome: 'passed' | 'failed' | 'cancelled' = 'passed';
                for (const candidate of lane.commands) {
                    if (aborted) { outcome = 'cancelled'; break; }
                    let pid: number | undefined;
                    const handle: RefineLaneCommandHandle = {
                        get aborted() { return aborted; },
                        attach(child) {
                            if (!child?.pid) return;
                            pid = child.pid;
                            live.add(pid);
                            // A child that spawns after the abort is killed at once.
                            if (aborted) kills.push(killTree(pid));
                        },
                    };
                    let result: RefineLaneCommandOutcome;
                    try {
                        result = await runCommand(candidate, lane.env, handle);
                    } finally {
                        if (pid !== undefined) live.delete(pid);
                    }
                    if (result === 'failed') { outcome = 'failed'; abort(); break; }
                    if (result === 'cancelled') { outcome = 'cancelled'; break; }
                }
                laneReports[index].durationMs = Date.now() - laneStarted;
                laneReports[index].outcome = outcome;
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(phase.concurrency, phase.lanes.length)) }, worker));
        report.phases.push({ id: phase.id, durationMs: Date.now() - phaseStarted, lanes: laneReports });
    }
    // Never return while a cancelled tree may still be dying.
    await Promise.all(kills);
    report.aborted = aborted;
    return report;
}
