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

// ── Re-export shim (fragmentation audit) ────────────────────────────────────
// The implementation moved to @adhdev/mesh-shared (semver-compare.ts) so the
// proprietary server's byte-identical copy can be deleted in favor of one
// shared leaf. This path stays valid for every existing daemon-core import.
export { parseSemver, compareSemver, isDowngrade } from '@adhdev/mesh-shared';
export type { ParsedSemver } from '@adhdev/mesh-shared';
