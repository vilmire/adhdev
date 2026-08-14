/**
 * Semver precedence comparison — the single version-ordering primitive for the
 * daemon's upgrade paths.
 *
 * Why this exists: the upgrade path used to decide "is this a no-op?" with a
 * raw string equality check (`currentInstalled === latest`) and nothing else.
 * Equality answers "is it the same version?" but never "which one is newer?",
 * so any target that merely differed from the running build was installed —
 * including one that is OLDER. That is how a node running `1.0.49-rc.2`
 * silently got rolled back to `1.0.48`.
 *
 * String comparison cannot fix it either: `'1.0.49-rc.2' < '1.0.48'` is TRUE
 * lexicographically (the '4' in "-rc.2"'s prefix never gets that far — '9' vs
 * '8' at index 4 decides it, and even where it works `rc.10` sorts below
 * `rc.9`). Only field-wise numeric comparison with semver §11 prerelease rules
 * gives the right answer.
 *
 * This module is a PURE LEAF: zero imports, no I/O, so the boot/upgrade paths
 * can use it without cycles. It mirrors the semantics of
 * `packages/server/src/utils/version-policy.ts` `compareSemver`, which lives in
 * the proprietary Workers package and therefore cannot be imported from OSS
 * daemon-core; the two are independent implementations of the same spec.
 *
 * NOTE ON PRERELEASE SEMANTICS: this is STRICT semver §11 — `1.0.49-rc.2` is
 * BELOW `1.0.49`, because a prerelease precedes its own release. That is the
 * correct rule for "would installing this move me backwards?", which is the
 * only question this module is used to answer. It deliberately differs from
 * `oss/packages/web-core/src/utils/version-update.ts`, whose
 * `isDaemonBehindTarget` treats an rc as up-to-date against its own base
 * release so the dashboard does not nag preview users with an update banner.
 * Those are two different questions; do not collapse them into one helper.
 */

/** Parsed semver fields. Build metadata (`+…`) is discarded: it never affects precedence (§10). */
export interface ParsedSemver {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    /** Dot-separated prerelease identifiers; empty for a release build. */
    readonly prerelease: readonly string[];
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

/**
 * Parse a semver string, tolerating a leading `v` (npm/CLI output carries it
 * inconsistently). Returns null for anything unparsable so callers can fail
 * closed rather than guess.
 */
export function parseSemver(version: unknown): ParsedSemver | null {
    if (typeof version !== 'string') return null;
    const match = version.trim().replace(/^v/, '').match(SEMVER_PATTERN);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ? match[4].split('.') : [],
    };
}

/**
 * Semver §11 prerelease precedence: a release outranks its own prereleases;
 * numeric identifiers compare numerically (so rc.10 > rc.9) and rank below
 * alphanumeric ones; alphanumerics compare lexically; a shorter identifier
 * list ranks below an otherwise-equal longer one.
 */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
    if (a.length === 0 && b.length === 0) return 0;
    // An empty prerelease list means "release build", which outranks any prerelease.
    if (a.length === 0) return 1;
    if (b.length === 0) return -1;
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
        const idA = a[i];
        const idB = b[i];
        if (idA === idB) continue;
        const numA = NUMERIC_IDENTIFIER.test(idA);
        const numB = NUMERIC_IDENTIFIER.test(idB);
        if (numA && numB) return Number(idA) < Number(idB) ? -1 : 1;
        if (numA) return -1;
        if (numB) return 1;
        return idA < idB ? -1 : 1;
    }
    return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

/**
 * Compare two versions by semver precedence.
 *
 * @returns -1 when `a` precedes `b`, 0 when equal, 1 when `a` succeeds `b`, and
 *   **null when either side is unparsable** — callers MUST treat null as
 *   "direction unknown" and fail closed rather than coercing it to a number
 *   (`null` compares as `0` in JS numeric contexts, which would read as "equal").
 */
export function compareSemver(a: unknown, b: unknown): number | null {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return null;
    if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
    if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
    if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
    return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * Would installing `target` move a daemon currently on `current` BACKWARDS?
 *
 * Returns false when the direction cannot be established (either version
 * unparsable) — an unknown direction must never block an upgrade, because the
 * cost of a false block (the whole fleet can no longer be upgraded) is far
 * higher than the cost of a missed downgrade guard. Equal versions are NOT a
 * downgrade, so a same-version reinstall stays allowed.
 */
export function isDowngrade(current: unknown, target: unknown): boolean {
    const direction = compareSemver(target, current);
    if (direction === null) return false;
    return direction < 0;
}
