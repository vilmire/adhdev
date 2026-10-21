// ---------------------------------------------------------------------------
// mesh-refine-lanes — REFINE-LANES executor: runs a validated schedule
// (refine-schedule.ts) phase by phase, lanes in parallel, and on the first
// failure cancels every other running lane.
//
// Process ownership (the rule): this module only ever signals a process GROUP
// it created, through the ChildProcess handle it holds, and only while that
// group's leader is still un-reaped. Every scheduled gate is spawned
// `detached` (POSIX), so the child is the leader of its own process group and
// pgid == child.pid. A pid — and therefore that pgid — cannot be reused while
// the leader still exists, alive or as a zombie; and Node reaps the leader
// only inside the same event-loop turn that sets `exitCode`/`signalCode` on
// the handle. So "handle has no exitCode/signalCode" (checked synchronously,
// right before each kill) proves `-pid` still names OUR group.
//
// Numeric pids found any other way (ps snapshots, ppid walks) are NEVER
// signalled — they can be reused by unrelated processes. A descendant that
// leaves the group (setsid/daemonize) or outlives its leader is therefore not
// killed here: gates that daemonize must tie such children to their own
// lifeline (the cooperative-maintenance tier does). Such escapees are only
// DETECTED (read-only ps) and reported on the run.
//
// win32: Node holds an OS process HANDLE for the child until it exits, and a
// Windows pid is not reused while any handle to the process is open, so
// `taskkill /pid <child.pid> /T /F` while the handle reports no exit targets
// our root. Residual risk (documented, not solved): /T walks the tree by
// parent pid, and a descendant whose parent already exited can be missed, or,
// in theory, a reused-pid process parented to a dead tree member be included.
// A Job Object would close that gap; not used here.
//
// This module owns only scheduling and cancellation. Spawning, output capture
// and result recording stay in mesh-refine-gates.ts (passed in as `runCommand`)
// so a scheduled gate is recorded exactly like a serial one.
// ---------------------------------------------------------------------------

import { execFile, spawn } from 'node:child_process';
import type { MeshRefineValidationCommandPlan } from './refine-config.js';

export type RefineLaneCommandOutcome = 'passed' | 'failed' | 'blocked' | 'cancelled';

/** The ChildProcess surface cancellation needs. */
export interface RefineGroupChild {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    once(event: 'exit', listener: (...args: any[]) => void): unknown;
}

export interface RefineEscapedProcess {
    pid: number;
    pgid: number;
    command: string;
    reason: 'left_group' | 'outlived_leader';
}

/** Per-command handle: the executor registers its child so cancel can reach it. */
export interface RefineLaneCommandHandle {
    /** True once the run has been aborted (by another lane's failure). */
    readonly aborted: boolean;
    /** Register the spawned child (call once, right after spawn). */
    attach(child: RefineGroupChild | undefined): void;
}

export interface ScheduledRefinePhase {
    id: string;
    concurrency: number;
    lanes: Array<{ id: string; env?: Record<string, string>; commands: MeshRefineValidationCommandPlan[] }>;
}

export interface ScheduledRefineRunReport {
    aborted: boolean;
    phases: Array<{ id: string; durationMs: number; lanes: Array<{ id: string; durationMs: number; commands: string[]; outcome: 'passed' | 'failed' | 'cancelled' | 'not_started' }> }>;
    /** Processes that left a cancelled gate's group (or outlived its leader). Reported, never signalled. */
    escaped?: RefineEscapedProcess[];
}

const KILL_GRACE_MS = 3_000;
const KILL_WAIT_MS = 5_000;

export interface RefineGroupTerminationDeps {
    platform?: NodeJS.Platform;
    /** process.kill — injectable so tests can prove what is (not) signalled. */
    signal?: (pid: number, signal: NodeJS.Signals) => void;
    /** Read-only process listing, used ONLY to report escapees. */
    listProcesses?: () => Promise<Array<{ pid: number; ppid: number; pgid: number; command: string }>>;
    taskkill?: (pid: number) => Promise<void>;
    graceMs?: number;
}

function listProcessesPs(): Promise<Array<{ pid: number; ppid: number; pgid: number; command: string }>> {
    return new Promise(resolve => {
        execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
            if (error || typeof stdout !== 'string') { resolve([]); return; }
            const rows = [];
            for (const line of stdout.split('\n')) {
                const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
                if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] });
            }
            resolve(rows);
        });
    });
}

function leaderUnreaped(child: RefineGroupChild): boolean {
    return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child: RefineGroupChild, ms: number): Promise<boolean> {
    if (!leaderUnreaped(child)) return Promise.resolve(true);
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(!leaderUnreaped(child)), ms);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
}

/**
 * Terminate a scheduled gate's process group via its handle. Resolves only
 * when the leader has exited (or the bounded waits elapsed) and escapees have
 * been recorded — callers await it before returning a gate result.
 */
export async function terminateRefineProcessGroup(child: RefineGroupChild, deps: RefineGroupTerminationDeps = {}): Promise<{ signals: NodeJS.Signals[]; escaped: RefineEscapedProcess[] }> {
    const platform = deps.platform ?? process.platform;
    const signals: NodeJS.Signals[] = [];
    const pid = child.pid;
    if (!pid || !Number.isInteger(pid) || pid <= 1) return { signals, escaped: [] };
    if (platform === 'win32') {
        if (leaderUnreaped(child)) {
            const taskkill = deps.taskkill ?? ((p: number) => new Promise<void>(resolve => {
                execFile('taskkill', ['/pid', String(p), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => resolve());
            }));
            signals.push('SIGKILL');
            await taskkill(pid);
            await waitForExit(child, KILL_WAIT_MS);
        }
        return { signals, escaped: [] };
    }
    const signal = deps.signal ?? ((p: number, s: NodeJS.Signals) => { process.kill(p, s); });
    const listProcesses = deps.listProcesses ?? listProcessesPs;
    // Read-only snapshot of the tree, for escapee REPORTING only.
    const before = await listProcesses();
    const descendants = new Map<number, { pid: number; pgid: number; command: string }>();
    const queue = [pid];
    while (queue.length) {
        const parent = queue.shift() as number;
        for (const row of before) {
            if (row.ppid === parent && row.pid !== pid && !descendants.has(row.pid)) {
                descendants.set(row.pid, row);
                queue.push(row.pid);
            }
        }
    }
    const sendToGroup = (s: NodeJS.Signals) => {
        // Synchronous ownership check immediately before the signal: no await
        // between the check and the kill, so the leader cannot be reaped in between.
        if (!leaderUnreaped(child)) return;
        try { signal(-pid, s); signals.push(s); } catch { /* group already gone */ }
    };
    sendToGroup('SIGTERM');
    if (!(await waitForExit(child, deps.graceMs ?? KILL_GRACE_MS))) {
        sendToGroup('SIGKILL');
        await waitForExit(child, KILL_WAIT_MS);
    }
    const after = await listProcesses();
    const escaped: RefineEscapedProcess[] = [];
    for (const row of after) {
        const seen = descendants.get(row.pid);
        if (!seen || seen.command !== row.command) continue; // only processes we saw in OUR tree
        escaped.push({ pid: row.pid, pgid: row.pgid, command: row.command, reason: row.pgid === pid ? 'outlived_leader' : 'left_group' });
    }
    return { signals, escaped };
}

/**
 * execFile-compatible runner that starts the child as its own process group
 * (POSIX `detached`; execFile itself drops that option, so it cannot be used
 * here). Same contract as execFile: a non-zero exit yields an Error carrying
 * numeric `code`, `signal`, `killed`, `stdout`, `stderr`; a spawn failure yields
 * the spawn error (e.g. ENOENT); output is decoded as a utf8 stream (split
 * multibyte sequences are joined) and each stream is limited to `maxBuffer`
 * BYTES — exceeding it truncates that stream at the byte limit, terminates the
 * group and reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER. The callback runs only
 * after any termination this wrapper started has completed.
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
    const out = { stdout: '', stderr: '' };
    const bytes = { stdout: 0, stderr: 0 };
    let settled = false;
    let overflow: any;
    let cleanup: Promise<unknown> | undefined;
    const finish = (error: any) => {
        if (settled) return;
        settled = true;
        void Promise.resolve(cleanup).then(() => callback(error, out.stdout, out.stderr));
    };
    const collect = (which: 'stdout' | 'stderr') => (chunk: string) => {
        if (overflow) return;
        const length = Buffer.byteLength(chunk, 'utf8');
        bytes[which] += length;
        if (bytes[which] > limit) {
            // Same truncation rule as execFile: keep the chunk up to the limit.
            const truncatedLen = limit - (bytes[which] - length);
            out[which] += chunk.slice(0, truncatedLen);
            overflow = Object.assign(new Error(`${which} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
            cleanup = terminateRefineProcessGroup(child);
            return;
        }
        out[which] += chunk;
    };
    // setEncoding installs a StringDecoder: a multibyte char split across
    // chunks is emitted whole, never as replacement characters.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    child.on('error', error => finish(error));
    child.on('close', (code, signal) => {
        if (overflow) { finish(overflow); return; }
        if (code === 0) { finish(null); return; }
        const error: any = new Error(`Command failed: ${[file, ...args].join(' ')}\n${out.stderr}`);
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
    terminate: (child: RefineGroupChild) => Promise<{ escaped: RefineEscapedProcess[] }> = child => terminateRefineProcessGroup(child),
): Promise<ScheduledRefineRunReport> {
    let aborted = false;
    const live = new Set<RefineGroupChild>();
    const kills: Promise<void>[] = [];
    const escaped: RefineEscapedProcess[] = [];
    const cancel = (child: RefineGroupChild) => {
        kills.push(terminate(child).then(result => { escaped.push(...result.escaped); }, () => undefined));
    };
    const abort = () => {
        if (aborted) return;
        aborted = true;
        for (const child of live) cancel(child);
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
                    let attached: RefineGroupChild | undefined;
                    const handle: RefineLaneCommandHandle = {
                        get aborted() { return aborted; },
                        attach(child) {
                            if (!child) return;
                            attached = child;
                            live.add(child);
                            // A child that spawns after the abort is terminated at once.
                            if (aborted) cancel(child);
                        },
                    };
                    let result: RefineLaneCommandOutcome;
                    try {
                        result = await runCommand(candidate, lane.env, handle);
                    } finally {
                        if (attached) live.delete(attached);
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
    // Never return while a cancelled group may still be dying.
    await Promise.all(kills);
    report.aborted = aborted;
    if (escaped.length) report.escaped = escaped;
    return report;
}
