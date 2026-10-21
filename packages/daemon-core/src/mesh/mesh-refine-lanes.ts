// ---------------------------------------------------------------------------
// mesh-refine-lanes — REFINE-LANES executor: runs a validated schedule
// (refine-schedule.ts) phase by phase, lanes in parallel, and on the first
// failure cancels every other running lane.
//
// Process ownership (the rule — a standing mesh rule): this module only ever
// signals a process through the ChildProcess HANDLE it spawned and holds,
// via child.kill(). That is exactly what execFile does for the serial path on
// main, so it is no regression. It never signals a numeric pid, a process
// group or a tree: neither "the leader is still un-reaped" (libuv may reap
// before JS sees the exit fields) nor Windows `taskkill /T` proves ownership.
//
// So a cancelled / timed-out / overflowing gate gets: child.kill('SIGTERM')
// on its handle, its stdout/stderr destroyed (as execFile does on overflow),
// a bounded wait for 'exit', then child.kill('SIGKILL') on the same handle if
// it is still running — and the result settles on 'exit' plus a bounded grace
// for buffered output, never on an unbounded 'close'/pipe EOF (a descendant
// holding the pipes cannot hang the Refinery).
//
// Descendants of the gate are NOT killed. A read-only ps census taken before
// the kill and after the grace reports the ones still alive (`escaped`) on the
// gate error and the schedule report. Gates that start long-lived children
// must give them their own lifeline (the cooperative-maintenance tier does).
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
    kill(signal?: NodeJS.Signals): boolean;
    stdout?: { destroy(): unknown } | null;
    stderr?: { destroy(): unknown } | null;
}

export interface RefineEscapedProcess {
    pid: number;
    command: string;
    reason: 'outlived_gate';
}

/** Per-command handle: the executor registers its child so cancel can reach it. */
export interface RefineLaneCommandHandle {
    /** True once the run has been aborted (by another lane's failure). */
    readonly aborted: boolean;
    /** True once the executor asked THIS command's child to terminate. */
    readonly cancelRequested: boolean;
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
    /** Descendants still alive after a gate was terminated. Reported, never signalled. */
    escaped?: RefineEscapedProcess[];
}

const KILL_GRACE_MS = 3_000;
const KILL_WAIT_MS = 5_000;

export interface RefineChildTerminationDeps {
    /** Read-only process listing, used ONLY to report escapees. */
    listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>;
    graceMs?: number;
}

function listProcessesPs(): Promise<Array<{ pid: number; ppid: number; command: string }>> {
    if (process.platform === 'win32') return Promise.resolve([]);
    return new Promise(resolve => {
        execFile('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
            if (error || typeof stdout !== 'string') { resolve([]); return; }
            const rows = [];
            for (const line of stdout.split('\n')) {
                const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
                if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
            }
            resolve(rows);
        });
    });
}

function exited(child: RefineGroupChild): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: RefineGroupChild, ms: number): Promise<boolean> {
    if (exited(child)) return Promise.resolve(true);
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(exited(child)), ms);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
}

/**
 * Terminate one scheduled gate through its handle (never a pid) and report the
 * descendants that are still alive afterwards. Resolves after the bounded
 * waits — callers await it before returning a gate result.
 */
export async function terminateRefineChild(child: RefineGroupChild, deps: RefineChildTerminationDeps = {}): Promise<{ signals: NodeJS.Signals[]; escaped: RefineEscapedProcess[] }> {
    const listProcesses = deps.listProcesses ?? listProcessesPs;
    const signals: NodeJS.Signals[] = [];
    const rootPid = child.pid;
    // Read-only census of the gate's tree, for REPORTING only.
    const before = rootPid ? await listProcesses() : [];
    const tree = new Map<number, string>();
    const queue = rootPid ? [rootPid] : [];
    while (queue.length) {
        const parent = queue.shift() as number;
        for (const row of before) {
            if (row.ppid === parent && row.pid !== rootPid && !tree.has(row.pid)) { tree.set(row.pid, row.command); queue.push(row.pid); }
        }
    }
    const killHandle = (s: NodeJS.Signals) => {
        if (exited(child)) return;
        try { if (child.kill(s)) signals.push(s); } catch { /* already gone */ }
    };
    killHandle('SIGTERM');
    try { child.stdout?.destroy(); } catch { /* ignore */ }
    try { child.stderr?.destroy(); } catch { /* ignore */ }
    if (!(await waitForExit(child, deps.graceMs ?? KILL_GRACE_MS))) {
        killHandle('SIGKILL');
        await waitForExit(child, KILL_WAIT_MS);
    }
    const escaped: RefineEscapedProcess[] = [];
    if (tree.size) {
        for (const row of await listProcesses()) {
            if (tree.get(row.pid) === row.command) escaped.push({ pid: row.pid, command: row.command, reason: 'outlived_gate' });
        }
    }
    return { signals, escaped };
}

const CLOSE_GRACE_MS = 2_000;

/**
 * execFile-compatible runner used for scheduled gates (spawn, so the lane
 * executor gets the handle). Same contract as execFile: a non-zero exit yields
 * an Error carrying numeric `code`, `signal`, `killed`, `stdout`, `stderr`; a
 * spawn failure yields the spawn error (e.g. ENOENT); output is decoded as a
 * utf8 stream (split multibyte sequences are joined) and each stream is
 * limited to `maxBuffer` BYTES — exceeding it truncates that stream at the
 * byte limit, terminates the child through its handle and reports
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER (with any escaped descendants).
 *
 * Settles on 'exit' plus at most CLOSE_GRACE_MS for buffered output: a
 * descendant still holding the pipes cannot keep the gate open.
 */
export function spawnRefineGateChild(
    file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: any, stdout: string, stderr: string) => void,
): ReturnType<typeof spawn> {
    const { maxBuffer, timeout: _timeout, encoding: _encoding, detached: _detached, ...spawnOptions } = options;
    const limit = typeof maxBuffer === 'number' && maxBuffer > 0 ? maxBuffer : Infinity;
    const child = spawn(file, args, { ...spawnOptions, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] } as any);
    const out = { stdout: '', stderr: '' };
    const bytes = { stdout: 0, stderr: 0 };
    let settled = false;
    let overflow: any;
    let cleanup: Promise<{ escaped: RefineEscapedProcess[] }> | undefined;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: any) => {
        if (settled) return;
        settled = true;
        if (closeTimer) clearTimeout(closeTimer);
        void Promise.resolve(cleanup).then(result => {
            if (error && result?.escaped.length) error.escapedProcesses = result.escaped;
            callback(error, out.stdout, out.stderr);
        });
    };
    const settleFromExit = () => {
        if (overflow) { finish(overflow); return; }
        const { code, signal } = exitInfo ?? { code: null, signal: null };
        if (code === 0) { finish(null); return; }
        const cmd = [file, ...args].join(' ');
        const error: any = new Error(`Command failed: ${cmd}\n${out.stderr}`);
        error.code = code;
        error.signal = signal;
        // Like execFile: `killed` means OUR runner killed it (child.killed is set
        // only when our child.kill() delivered a signal) — never inferred from an
        // exit signal, so a natural SIGSEGV is not mistaken for a timeout.
        error.killed = child.killed === true;
        error.cmd = cmd;
        finish(error);
    };
    const collect = (which: 'stdout' | 'stderr') => (chunk: string) => {
        if (overflow) return;
        const length = Buffer.byteLength(chunk, 'utf8');
        bytes[which] += length;
        if (bytes[which] > limit) {
            // Same truncation rule as execFile: keep the chunk up to the limit.
            const truncatedLen = limit - (bytes[which] - length);
            out[which] += chunk.slice(0, truncatedLen);
            // Same shape as execFile's ERR_CHILD_PROCESS_STDIO_MAXBUFFER (a RangeError).
            overflow = Object.assign(new RangeError(`${which} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', cmd: [file, ...args].join(' ') });
            cleanup = terminateRefineChild(child);
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
    child.on('exit', (code, signal) => {
        exitInfo = { code, signal };
        // Bounded wait for the pipes to drain; a descendant holding them must
        // not keep the gate open.
        closeTimer = setTimeout(() => {
            try { child.stdout?.destroy(); } catch { /* ignore */ }
            try { child.stderr?.destroy(); } catch { /* ignore */ }
            settleFromExit();
        }, CLOSE_GRACE_MS);
    });
    child.on('close', () => { if (exitInfo) settleFromExit(); });
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
    terminate: (child: RefineGroupChild) => Promise<{ escaped: RefineEscapedProcess[] }> = child => terminateRefineChild(child),
): Promise<ScheduledRefineRunReport> {
    let aborted = false;
    const live = new Set<RefineGroupChild>();
    const kills: Promise<void>[] = [];
    const escaped: RefineEscapedProcess[] = [];
    const cancelled = new WeakSet<RefineGroupChild>();
    const cancel = (child: RefineGroupChild) => {
        cancelled.add(child);
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
                        get cancelRequested() { return !!attached && cancelled.has(attached); },
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
    // Never return while a cancelled gate may still be dying.
    await Promise.all(kills);
    report.aborted = aborted;
    if (escaped.length) report.escaped = escaped;
    return report;
}
