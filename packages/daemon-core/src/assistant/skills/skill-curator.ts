/**
 * Assistant store curator — status maintenance only, no LLM, never edits
 * skill content and never deletes skill files.
 *
 * Design: docs/design/2026-10-07-assistant-layer.md §4.10.6.
 *  - last view (or creation) ≥ 30 days → stale, ≥ 90 days → archived; pinned
 *    skills are skipped. `skill_view` by name revives to active (skill store).
 *  - housekeeping: journal lines older than 90 days (skill + memory journals),
 *    staged writes older than 14 days (skill + memory) are discarded.
 *
 * `startAssistantCuratorTimer` is the 24 h loop (single-flight, unref). It is
 * intentionally NOT wired into boot here — the boot `startLoops` stage adds it
 * when the assistant registry lands.
 */

import { existsSync, readFileSync } from 'fs';
import { writeFileAtomic600 } from '../store-guards.js';
import { STAGED_WRITE_MAX_AGE_MS, type AssistantMemoryStore } from '../memory/memory-store.js';
import type { AssistantSkillStore } from './skill-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const CURATOR_RULES = {
    staleAfterMs: 30 * DAY_MS,
    archiveAfterMs: 90 * DAY_MS,
    journalRetentionMs: 90 * DAY_MS,
    stagedMaxAgeMs: STAGED_WRITE_MAX_AGE_MS,
    intervalMs: DAY_MS,
} as const;

export interface CuratorReport {
    staled: string[];
    archived: string[];
    journalLinesPruned: { skills: number; memory: number };
    stagedExpired: { skills: string[]; memory: string[] };
}

/**
 * Drop JSONL lines whose `ts` is older than `cutoffMs`. Lines without a
 * parseable `ts` are kept (an audit trail errs on keeping). Rewrites the file
 * atomically at 0600 only when something was dropped. Returns lines dropped.
 */
export function pruneJsonlByTs(path: string, cutoffMs: number): number {
    if (!existsSync(path)) return 0;
    const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim());
    const kept = lines.filter((l) => {
        try {
            const t = Date.parse((JSON.parse(l) as { ts?: unknown }).ts as string);
            return !Number.isFinite(t) || t >= cutoffMs;
        } catch {
            return true;
        }
    });
    const dropped = lines.length - kept.length;
    if (dropped > 0) writeFileAtomic600(path, kept.length ? `${kept.join('\n')}\n` : '');
    return dropped;
}

export class AssistantCurator {
    constructor(
        private readonly skills: AssistantSkillStore,
        private readonly memory: AssistantMemoryStore | null,
        private readonly rules: typeof CURATOR_RULES = CURATOR_RULES,
    ) {}

    /**
     * One pass. `now` must be the stores' clock (they are constructed with an
     * injectable `now`); it is used here for the journal cutoff.
     */
    runCurator(now: Date): CuratorReport {
        const { staled, archived } = this.skills.curateStatuses(this.rules.staleAfterMs, this.rules.archiveAfterMs);
        const stagedExpired = {
            skills: this.skills.expireStaged(this.rules.stagedMaxAgeMs),
            memory: this.memory ? this.memory.expireStaged(this.rules.stagedMaxAgeMs) : [],
        };
        // Prune after expiring so the expiry lines of this pass survive.
        const cutoff = now.getTime() - this.rules.journalRetentionMs;
        const journalLinesPruned = {
            skills: pruneJsonlByTs(this.skills.journal.path, cutoff),
            memory: this.memory ? pruneJsonlByTs(this.memory.journalPath, cutoff) : 0,
        };
        return { staled, archived, journalLinesPruned, stagedExpired };
    }
}

export interface CuratorTimerOptions {
    intervalMs?: number;
    now?: () => Date;
    onReport?: (r: CuratorReport) => void;
    onError?: (err: unknown) => void;
    /** Injected for tests. */
    setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
    clearInterval?: (handle: unknown) => void;
}

/**
 * 24 h curator loop. Single-flight: a tick while a pass is still running is
 * skipped. The timer is unref'd so it never holds the daemon open. Returns a
 * stop function plus `tick` (runs one pass now, same single-flight guard).
 */
export function startAssistantCuratorTimer(
    curator: Pick<AssistantCurator, 'runCurator'>,
    opts: CuratorTimerOptions = {},
): { stop: () => void; tick: () => CuratorReport | null } {
    const now = opts.now ?? (() => new Date());
    let running = false;
    const tick = (): CuratorReport | null => {
        if (running) return null;
        running = true;
        try {
            const r = curator.runCurator(now());
            opts.onReport?.(r);
            return r;
        } catch (err) {
            opts.onError?.(err);
            return null;
        } finally {
            running = false;
        }
    };
    const set = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const clear = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
    const handle = set(() => void tick(), opts.intervalMs ?? CURATOR_RULES.intervalMs);
    handle.unref?.();
    return { stop: () => clear(handle), tick };
}
