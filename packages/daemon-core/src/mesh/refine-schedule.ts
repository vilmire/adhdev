// ---------------------------------------------------------------------------
// refine-schedule — REFINE-LANES: an explicit, config-declared schedule that
// lets the Refinery run independent validation gates in parallel lanes.
//
// Why config-declared and not inferred: which gates can safely overlap is a
// property of the repo (which command rebuilds which dist/, which suite reads
// it), not something the daemon can discover. A wrong guess is the 1.0.81
// `npm pack` ENOENT race — a tsup `clean: true` rebuild wiped daemon-core/dist
// between a concurrent reader's readdir and its lstat. So the schedule is
// opt-in, explicit, and REFUSED (config invalid) whenever it could overlap a
// dist writer with a reader of the same dist.
//
// Shape (validation.schedule):
//   prepare?: command[]   — run serially BEFORE phase 0. Not gate commands: they
//                           establish shared preconditions once (e.g. prebuilding
//                           the dists every lane reads) so no lane has to.
//   phases: [{ id, concurrency?, lanes: [{ id, commands: [<command id>], env? }] }]
//
// Semantics:
//   - phases run one after another (a barrier between phases);
//   - inside a phase, lanes run concurrently (at most `concurrency` at once,
//     default = all of them); inside a lane, commands run in order;
//   - every validation command must carry an `id` and appear in EXACTLY ONE
//     lane — a schedule cannot drop or duplicate a gate (coverage invariant);
//   - in a phase where lanes can overlap, every command must declare `writes`
//     — EVERY repo path it may mutate, [] when none: rebuilt dist/ trees, and
//     also sources a test rewrites and restores (a "--dry-run" that pins
//     package.json versions in place is still a writer while it runs). `reads` defaults to '*'
//     (reads everything) when undeclared. Two commands in different lanes of the
//     same overlapping phase may not share a written path with the other's
//     reads or writes.
//
// A config without `schedule` runs serially exactly as before.
// ---------------------------------------------------------------------------

import type { MeshRefineValidationCommandPlan } from './refine-config.js';

export const REFINE_SCHEDULE_WILDCARD = '*';

export interface MeshRefineScheduleLanePlan {
    id: string;
    /** Command ids, in run order. */
    commands: string[];
    env?: Record<string, string>;
}

export interface MeshRefineSchedulePhasePlan {
    id: string;
    /** Max lanes running at once; always >= 1. */
    concurrency: number;
    lanes: MeshRefineScheduleLanePlan[];
}

export interface MeshRefineSchedulePlan {
    prepare: MeshRefineValidationCommandPlan[];
    phases: MeshRefineSchedulePhasePlan[];
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a `reads`/`writes` declaration. undefined = undeclared.
 *
 * Paths must be CANONICAL repo-relative POSIX paths (or the lone '*'): no
 * leading '/', no drive letter, no backslash, no '.'/'..'/empty segments. A
 * non-canonical spelling (`pkg/../shared`, `.\\shared`, `/abs/shared`) would
 * name the same tree as a canonical one yet slip past the prefix-overlap
 * check, so it is rejected rather than guessed at. A trailing '/' is trimmed.
 */
export function normalizeRefineDistList(value: unknown): { list?: string[]; error?: string } {
    if (value === undefined) return {};
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && v.trim() && !/[\n\r\0]/.test(v))) {
        return { error: 'must be an array of non-empty path strings' };
    }
    const list: string[] = [];
    for (const raw of value as string[]) {
        const v = raw.trim().replace(/\/+$/, '');
        if (v === REFINE_SCHEDULE_WILDCARD) { list.push(v); continue; }
        const segments = v.split('/');
        if (!v || v.startsWith('/') || /^[A-Za-z]:/.test(v) || v.includes('\\') || segments.some(seg => seg === '' || seg === '.' || seg === '..')) {
            return { error: `path "${raw}" is not a canonical repo-relative POSIX path (no leading '/', drive letter, backslash, or '.', '..', empty segments)` };
        }
        list.push(v);
    }
    return { list: [...new Set(list)] };
}

function overlaps(a: string, b: string): boolean {
    if (a === REFINE_SCHEDULE_WILDCARD || b === REFINE_SCHEDULE_WILDCARD) return true;
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Parse and validate `validation.schedule` against the normalized commands.
 * Returns the plan, or the errors that make the config invalid.
 */
export function validateMeshRefineSchedule(
    raw: unknown,
    commands: MeshRefineValidationCommandPlan[],
    normalizePrepare: (entry: unknown, index: number) => { command?: MeshRefineValidationCommandPlan; rejected?: Record<string, unknown> },
): { schedule?: MeshRefineSchedulePlan; errors: string[] } {
    const errors: string[] = [];
    if (!isRecord(raw)) return { errors: ['validation.schedule must be an object'] };

    const prepare: MeshRefineValidationCommandPlan[] = [];
    if (raw.prepare !== undefined) {
        if (!Array.isArray(raw.prepare)) errors.push('validation.schedule.prepare must be an array');
        else raw.prepare.forEach((entry, index) => {
            const normalized = normalizePrepare(entry, index);
            if (normalized.command) prepare.push(normalized.command);
            else errors.push(`validation.schedule.prepare[${index}]: ${String(normalized.rejected?.reason || 'invalid command')}`);
        });
    }

    const byId = new Map<string, MeshRefineValidationCommandPlan>();
    commands.forEach((command, index) => {
        if (!command.id) { errors.push(`validation.commands[${index}] (${command.displayCommand}) needs an id when validation.schedule is set`); return; }
        if (byId.has(command.id)) { errors.push(`duplicate validation command id "${command.id}"`); return; }
        byId.set(command.id, command);
    });

    if (!Array.isArray(raw.phases) || raw.phases.length === 0) {
        errors.push('validation.schedule.phases must be a non-empty array');
        return { errors };
    }

    const placed = new Map<string, string>();
    const phaseIds = new Set<string>();
    const laneIds = new Set<string>();
    const phases: MeshRefineSchedulePhasePlan[] = [];
    raw.phases.forEach((rawPhase, phaseIndex) => {
        const where = `validation.schedule.phases[${phaseIndex}]`;
        if (!isRecord(rawPhase)) { errors.push(`${where} must be an object`); return; }
        const id = typeof rawPhase.id === 'string' ? rawPhase.id : '';
        if (!ID_RE.test(id)) { errors.push(`${where}.id must match ${ID_RE}`); return; }
        if (phaseIds.has(id)) errors.push(`duplicate phase id "${id}"`);
        phaseIds.add(id);
        if (!Array.isArray(rawPhase.lanes) || rawPhase.lanes.length === 0) { errors.push(`${where}.lanes must be a non-empty array`); return; }
        let concurrency = rawPhase.lanes.length;
        if (rawPhase.concurrency !== undefined) {
            if (typeof rawPhase.concurrency !== 'number' || !Number.isInteger(rawPhase.concurrency) || rawPhase.concurrency < 1) {
                errors.push(`${where}.concurrency must be a positive integer`);
            } else {
                concurrency = Math.min(rawPhase.concurrency, rawPhase.lanes.length);
            }
        }
        const lanes: MeshRefineScheduleLanePlan[] = [];
        rawPhase.lanes.forEach((rawLane, laneIndex) => {
            const laneWhere = `${where}.lanes[${laneIndex}]`;
            if (!isRecord(rawLane)) { errors.push(`${laneWhere} must be an object`); return; }
            const laneId = typeof rawLane.id === 'string' ? rawLane.id : '';
            if (!ID_RE.test(laneId)) { errors.push(`${laneWhere}.id must match ${ID_RE}`); return; }
            if (laneIds.has(laneId)) errors.push(`duplicate lane id "${laneId}"`);
            laneIds.add(laneId);
            if (!Array.isArray(rawLane.commands) || rawLane.commands.length === 0 || !rawLane.commands.every(c => typeof c === 'string')) {
                errors.push(`${laneWhere}.commands must be a non-empty array of command ids`);
                return;
            }
            if (rawLane.env !== undefined && (!isRecord(rawLane.env) || !Object.values(rawLane.env).every(v => typeof v === 'string'))) {
                errors.push(`${laneWhere}.env must be an object of string values`);
                return;
            }
            for (const commandId of rawLane.commands as string[]) {
                if (!byId.has(commandId)) errors.push(`${laneWhere} references unknown command id "${commandId}"`);
                else if (placed.has(commandId)) errors.push(`command "${commandId}" is scheduled twice (lanes "${placed.get(commandId)}" and "${laneId}")`);
                else placed.set(commandId, laneId);
            }
            lanes.push({
                id: laneId,
                commands: [...rawLane.commands as string[]],
                ...(isRecord(rawLane.env) ? { env: rawLane.env as Record<string, string> } : {}),
            });
        });
        phases.push({ id, concurrency, lanes });
    });

    // Coverage invariant: no configured gate may be left out of the schedule.
    for (const id of byId.keys()) {
        if (!placed.has(id)) errors.push(`command "${id}" is not scheduled in any lane — a schedule may not drop a gate`);
    }

    // Dist-overlap invariant (the 1.0.81 race): only phases whose lanes can run
    // at the same time need it.
    for (const phase of phases) {
        if (phase.lanes.length < 2 || phase.concurrency < 2) continue;
        const laneAccess = phase.lanes.map(lane => {
            const reads: Array<{ path: string; command: string }> = [];
            const writes: Array<{ path: string; command: string }> = [];
            for (const commandId of lane.commands) {
                const command = byId.get(commandId);
                if (!command) continue;
                if (!command.writes) {
                    errors.push(`command "${commandId}" runs in overlapping phase "${phase.id}" but does not declare "writes" (use [] when it rebuilds no dist)`);
                    continue;
                }
                for (const path of command.writes) writes.push({ path, command: commandId });
                for (const path of command.reads ?? [REFINE_SCHEDULE_WILDCARD]) reads.push({ path, command: commandId });
            }
            return { lane: lane.id, reads, writes };
        });
        for (let i = 0; i < laneAccess.length; i++) {
            for (let j = 0; j < laneAccess.length; j++) {
                if (i === j) continue;
                for (const w of laneAccess[i].writes) {
                    const hit = [...laneAccess[j].reads, ...laneAccess[j].writes].find(other => overlaps(w.path, other.path));
                    if (hit) {
                        errors.push(`schedule refused: in phase "${phase.id}", "${w.command}" (lane ${laneAccess[i].lane}) writes ${w.path} while "${hit.command}" (lane ${laneAccess[j].lane}) may touch ${hit.path} concurrently`);
                    }
                }
            }
        }
    }

    if (errors.length) return { errors: [...new Set(errors)] };
    return { schedule: { prepare, phases }, errors };
}

/**
 * The scheduled command lists after change-scope filtering: commands that were
 * scope-skipped are removed from their lane and empty lanes / phases disappear.
 * Every command in `toRun` lands in exactly one lane (the config validator
 * guarantees every configured id is placed once).
 */
export function planScheduledRefineRun(
    schedule: MeshRefineSchedulePlan,
    toRun: MeshRefineValidationCommandPlan[],
): Array<{ id: string; concurrency: number; lanes: Array<{ id: string; env?: Record<string, string>; commands: MeshRefineValidationCommandPlan[] }> }> {
    const runnable = new Map(toRun.filter(c => c.id).map(c => [c.id as string, c]));
    const phases = [];
    for (const phase of schedule.phases) {
        const lanes = phase.lanes
            .map(lane => ({
                id: lane.id,
                ...(lane.env ? { env: lane.env } : {}),
                commands: lane.commands.map(id => runnable.get(id)).filter((c): c is MeshRefineValidationCommandPlan => !!c),
            }))
            .filter(lane => lane.commands.length > 0);
        if (lanes.length) phases.push({ id: phase.id, concurrency: Math.min(phase.concurrency, lanes.length), lanes });
    }
    return phases;
}
