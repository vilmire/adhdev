/**
 * REFINE-RESUME-LIVENESS — is the process that dispatched this refine still alive?
 *
 * ★The structural blind spot (root cause of the 2026-08-20 ghost dispatches):
 * `classifyRefineDispatch`'s `isRunning(nodeId)` reads `runningRefineJobs`, an
 * IN-MEMORY map on the router. After a daemon restart that map is EMPTY by
 * construction — the execution it should have found lives in the OLD process. So
 * the boot resume scan asks "is anyone running this?", gets a structurally
 * guaranteed "no", and re-dispatches a job that is very much still running.
 *
 * The `defer_grace` window was the only thing standing between that and a ghost,
 * and it is 60s. ★Sized for an atomic-upgrade handoff overlap, NOT for "the old
 * process is 6 minutes into a validation pipeline" — which is what the two observed
 * dispatches actually were (6m30s and 3m51s). They sailed past grace into `resume`.
 *
 * ★Why not just raise the grace window: the pipeline length is VARIABLE. It runs
 * whatever `.adhdev/refine.json` configures — today ~14 gates including a full
 * daemon-core vitest run; tomorrow whatever someone adds. Any constant is either too
 * short (ghosts return) or so long that a genuinely crashed job wedges its node for
 * that entire duration. A timeout is a proxy for the question; process liveness IS
 * the question.
 *
 * So: the dispatcher stamps its own process identity on the `task_dispatched` row,
 * and the resume scan checks whether that process still exists before resuming.
 *
 * ★STALE LOCKS CANNOT WEDGE A NODE. This is deliberately NOT a lockfile. There is
 * nothing to release, so there is nothing to leak:
 *   - the evidence lives in the dispatch row the ledger already writes;
 *   - liveness is derived at read time from the OS (`process.kill(pid, 0)`), so when
 *     the process dies the answer flips to "dead" on the very next scan with no
 *     cleanup step, no unlock, and no timeout to wait out;
 *   - a dispatch with NO stamp (every row written before this shipped, and any row
 *     from a remote daemon) is classified `unknown`, which resumes exactly as it
 *     does today. An absent stamp must never be read as "alive", or a single
 *     pre-upgrade row would block its node forever — the precise failure this
 *     module is supposed to avoid, not create.
 *   - the zombie cutoff (24h) still runs on top of everything, so even a
 *     pathological "alive forever" answer terminates.
 */

import { hostname } from 'node:os';

/**
 * The process that dispatched a refine job, stamped onto the ledger's
 * `task_dispatched` payload.
 */
export interface RefineExecutorStamp {
    /** os.hostname() — a pid is only meaningful on the machine that minted it. */
    host: string;
    /** process.pid of the daemon that owns the execution. */
    pid: number;
    /**
     * Per-BOOT identity. A pid alone is ambiguous: the OS recycles pids, so a
     * restarted daemon can be handed the dead one's pid and make a genuinely
     * interrupted job look alive forever. This is compared alongside the pid so
     * "same pid, different boot" reads as DEAD, not alive.
     */
    bootId?: string;
    /** ISO-8601 stamp time, for diagnostics only. */
    stampedAt?: string;
}

export type RefineExecutorLiveness =
    /** The stamping process still exists on this host — do NOT resume. */
    | 'alive'
    /** The stamping process is gone — resuming is safe. */
    | 'dead'
    /** No usable stamp, or a stamp from another host — cannot tell from here. */
    | 'unknown';

/**
 * A stable per-boot id for THIS process. Minted once at module load: two calls in
 * the same process must agree, and a restarted process must differ even if the OS
 * reissues the same pid.
 */
const BOOT_ID = `${process.pid}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;

/** Stamp identifying THIS process as the executor of a refine dispatch. */
export function buildRefineExecutorStamp(nowIso?: string): RefineExecutorStamp {
    return {
        host: hostname(),
        pid: process.pid,
        bootId: BOOT_ID,
        stampedAt: nowIso ?? new Date().toISOString(),
    };
}

/** Exposed so a test can assert same-process stamps compare `alive`. */
export function currentRefineExecutorBootId(): string {
    return BOOT_ID;
}

export interface RefineExecutorLivenessOptions {
    /** os.hostname() of the machine evaluating the stamp. Defaults to this host. */
    localHost?: string;
    /** This process's boot id. Defaults to this process's. */
    localBootId?: string;
    /** This process's pid. Defaults to process.pid. */
    localPid?: number;
    /**
     * Injectable liveness probe. Defaults to `process.kill(pid, 0)`, which sends no
     * signal and only asks "does this pid exist and may I signal it?".
     */
    isPidAlive?: (pid: number) => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        // ESRCH = no such process → definitively dead.
        // EPERM  = it exists but belongs to another user → definitively ALIVE.
        // Anything else is not an answer; treat as unknown-but-not-dead by
        // reporting alive, because wrongly resuming a live job (a ghost) is the
        // failure mode with teeth, while wrongly deferring one costs a boot cycle
        // and is then caught by the zombie cutoff.
        if (e?.code === 'ESRCH') return false;
        return true;
    }
}

/**
 * Evaluate whether the process recorded in `stamp` is still running.
 *
 * ★Ordering note: the SAME-PROCESS check comes first. A dispatch stamped by THIS
 * very process (pid + bootId both match) is trivially alive — but reaching the
 * generic pid probe for that case would also return alive, so the early return is
 * about clarity, not correctness.
 */
export function evaluateRefineExecutorLiveness(
    stamp: unknown,
    opts: RefineExecutorLivenessOptions = {},
): { liveness: RefineExecutorLiveness; reason: string } {
    const s = stamp as RefineExecutorStamp | undefined | null;
    if (!s || typeof s !== 'object') {
        return { liveness: 'unknown', reason: 'no_executor_stamp' };
    }
    const pid = typeof s.pid === 'number' && Number.isInteger(s.pid) && s.pid > 0 ? s.pid : undefined;
    const host = typeof s.host === 'string' && s.host.trim() ? s.host.trim() : undefined;
    if (!pid || !host) {
        return { liveness: 'unknown', reason: 'incomplete_executor_stamp' };
    }

    const localHost = opts.localHost ?? hostname();
    // ★A pid from another machine says nothing here. Never claim 'alive' (that would
    // wedge the node against a process we cannot see) and never claim 'dead' (that
    // would resume a job that may be running there). 'unknown' preserves today's
    // behavior for the remote case exactly.
    if (host !== localHost) {
        return { liveness: 'unknown', reason: `executor_stamp_from_other_host:${host}` };
    }

    const localBootId = opts.localBootId ?? BOOT_ID;
    const localPid = opts.localPid ?? process.pid;
    if (pid === localPid && s.bootId && s.bootId === localBootId) {
        return { liveness: 'alive', reason: 'executor_is_this_process' };
    }
    // ★Same pid, DIFFERENT boot id → the OS recycled the pid onto this very daemon.
    // The original executor is gone; without this check a pid collision after a
    // restart would report 'alive' forever and permanently block the resume.
    if (pid === localPid && s.bootId && s.bootId !== localBootId) {
        return { liveness: 'dead', reason: 'executor_pid_recycled_by_this_process' };
    }

    const probe = opts.isPidAlive ?? defaultIsPidAlive;
    let alive: boolean;
    try {
        alive = probe(pid);
    } catch {
        // A probe that throws is not evidence of death.
        return { liveness: 'unknown', reason: 'liveness_probe_failed' };
    }
    return alive
        ? { liveness: 'alive', reason: `executor_pid_${pid}_alive` }
        : { liveness: 'dead', reason: `executor_pid_${pid}_gone` };
}

/**
 * Read the executor stamp off a `task_dispatched` ledger payload.
 *
 * Tolerant of shape: an absent/garbage stamp yields undefined, which
 * `evaluateRefineExecutorLiveness` maps to 'unknown' (resume as today).
 */
export function readRefineExecutorStamp(payload: unknown): RefineExecutorStamp | undefined {
    const stamp = (payload as any)?.refineJob?.executor ?? (payload as any)?.executor;
    if (!stamp || typeof stamp !== 'object') return undefined;
    return stamp as RefineExecutorStamp;
}
