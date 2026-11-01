// ---------------------------------------------------------------------------
// refine-profile — LIGHT-TASK: run a NAMED validation profile (a subset of the
// configured command ids, `validation.profiles.<name>.commands`) against a
// directory. Shared by the light-task landing path and the review-in-task
// self-check, so "what the fast check runs" is defined once, in the repo's
// refine config, and never re-declared by a caller.
//
// Contract:
//  - A profile only SELECTS existing commands; it never defines one.
//  - Every configured gate NOT in the profile is recorded on the summary as
//    `skipped: true, skipReason: 'skipped_by_profile'`, so what was not
//    verified is always visible in `refineStages`.
//  - An unknown profile name fails the run (`validation_profile_unknown`);
//    it never degrades to "run nothing" or "run everything".
//  - `baseSha` is exported to every selected command as ADHDEV_REFINE_BASE_SHA
//    (consumed by scripts/verify-affected.mjs as its diff base).
// ---------------------------------------------------------------------------

export const REFINE_BASE_SHA_ENV = 'ADHDEV_REFINE_BASE_SHA';
export const REFINE_SKIPPED_BY_PROFILE = 'skipped_by_profile';

interface ProfileCommandLike {
    id?: string;
    command: string;
    args: string[];
    displayCommand: string;
    category: string;
    source: string;
    env?: Record<string, string>;
}

export interface RefineProfileSelection<T extends ProfileCommandLike> {
    /** Commands to execute, in their original order, with ADHDEV_REFINE_BASE_SHA injected when a base was given. */
    run: T[];
    /** Summary records for every command the profile left out. */
    skippedRecords: Array<Record<string, unknown>>;
}

/**
 * Pure selection. Returns an error string when the profile is not declared (or a
 * declared id has no matching command, which the config validator already refuses).
 */
export function selectRefineProfileCommands<T extends ProfileCommandLike>(
    commands: T[],
    profiles: Record<string, { commands: string[] }> | undefined,
    profile: string,
    baseSha?: string,
): RefineProfileSelection<T> | { error: string } {
    const def = profiles?.[profile];
    if (!def) {
        const known = Object.keys(profiles || {});
        return { error: `validation_profile_unknown: "${profile}" is not declared in the refine config validation.profiles${known.length ? ` (declared: ${known.join(', ')})` : ''}` };
    }
    const wanted = new Set(def.commands);
    const run: T[] = [];
    const skippedRecords: Array<Record<string, unknown>> = [];
    for (const candidate of commands) {
        if (candidate.id && wanted.has(candidate.id)) {
            run.push(baseSha ? { ...candidate, env: { ...(candidate.env || {}), [REFINE_BASE_SHA_ENV]: baseSha } } : candidate);
            continue;
        }
        skippedRecords.push({
            command: candidate.command,
            args: candidate.args,
            displayCommand: candidate.displayCommand,
            category: candidate.category,
            source: candidate.source,
            ...(candidate.id ? { id: candidate.id } : {}),
            passed: true,
            skipped: true,
            skipReason: REFINE_SKIPPED_BY_PROFILE,
            profile,
        });
    }
    return { run, skippedRecords };
}

/**
 * Narrow the scope-filtered commands to the profile's selection (keeping the
 * base-sha-injected copies) and append `skipped_by_profile` records for the
 * gates left out — except those the change-scope filter already recorded.
 */
export function applyRefineProfileSelection<T extends ProfileCommandLike>(
    profileRun: RefineProfileSelection<T>,
    commandsToRun: T[],
    commandsRun: Array<Record<string, unknown>>,
): T[] {
    const byId = new Map(profileRun.run.map(c => [c.id, c]));
    const recorded = new Set(commandsRun.map(r => String(r.displayCommand)));
    commandsRun.push(...profileRun.skippedRecords.filter(r => !recorded.has(String(r.displayCommand))));
    return commandsToRun.filter(c => byId.has(c.id)).map(c => byId.get(c.id) as T);
}
