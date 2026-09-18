/**
 * Refinery policy for REGENERATED VENDOR BUNDLES during the sync_base rebase.
 *
 * ## The false-block this exists to remove
 *
 * Two sibling branches that both touch `mcp-server` (or anything it inlines,
 * i.e. most of `daemon-core`) each commit a re-bundled copy of the vendored
 * output. Whichever lands first advances the base's bundle; the second branch
 * then rebases onto a base whose bundle differs from its own, and git reports a
 * CONTENT CONFLICT inside the generated file. The rebase aborts, sync_base
 * fails, and — because the shared failure path re-probes the patch-equivalence
 * gate for a richer hint — the whole refine surfaces as
 * `patch_equivalence_failed` / `patch_equivalence_classification`. Measured
 * 2026-09-18: twice in one day, with the authored source diff byte-identical
 * (`git patch-id --stable` equal before and after rebase).
 *
 * ## Why this is resolved here and not in the patch-equivalence gate
 *
 * The obvious-looking fix — exclude vendor paths from the gate's patch-id
 * comparison — does not work and is not safe:
 *
 *   - It is the WRONG STAGE. The rebase in sync_base runs BEFORE the gate and
 *     fails on its own; a gate that no longer compares vendor paths never gets
 *     consulted, because sync_base already aborted.
 *   - Excluding only `*.map` is INSUFFICIENT. Measured on a synthetic two-
 *     sibling repro: excluding `.map` alone still fails, because `index.js`
 *     differs between the two sides too. Both files carry the same conflict.
 *   - Hiding the conflict from the gate would let a REAL merge conflict through.
 *     `git merge-tree` writes conflict markers into the merged blob; a gate that
 *     skips those paths would pass a tree whose bundle contains `<<<<<<<`.
 *
 * So the conflict is resolved at its source — the rebase — by taking the BRANCH
 * side of the generated file, exactly as a human would: regenerate rather than
 * hand-merge two bundler outputs.
 *
 * ## Why taking the branch side is safe (and what proves it)
 *
 * Taking `--theirs` deliberately leaves a bundle built from the branch's
 * PRE-REBASE source: correct for the branch's own changes, but missing the
 * sibling's. That staleness is REAL, and it is exactly what `check:vendor`
 * exists to catch — it rebuilds from source and diffs against HEAD. It runs in
 * the `validation` stage, which the Refinery executes AFTER sync_base and
 * BEFORE patch_equivalence, and it is registered in `.adhdev/refine.json`
 * (twice: once at the root, once with `cwd: "oss"`). A stale bundle therefore
 * still blocks the refine — at the gate that can name the problem and tell the
 * worker to run `npm run bundle:vendor:all`, instead of as an opaque rebase
 * conflict.
 *
 * The verification is NOT "the bundle is byte-reproducible". It is not: a
 * re-bundle on the same toolchain is identical, but any source change anywhere
 * in the inlined graph rewrites it. The verification is that a WRONG bundle
 * cannot reach main, because a separate, already-registered gate rebuilds it.
 *
 * ## Scope: why not `vendor/**`
 *
 * Only the paths in {@link REFINE_GENERATED_VENDOR_BUNDLE_PATHS} are emitted by
 * `npm run bundle:vendor:all`. A blanket `vendor/**` rule would also swallow
 * `oss/vendor/seqscribe`, which is a git SUBMODULE (mode 160000), not generated
 * output — gitlinks have their own convergence machinery
 * (`rootRebaseResolvingGitlinks`) and must never be resolved by picking a side.
 * The list is therefore explicit, and {@link isRefineGeneratedVendorBundlePath}
 * additionally requires the conflicting entry to be a regular file, so a gitlink
 * can never match even if a future path overlaps.
 */

/**
 * Repo-relative directories whose contents are emitted by
 * `npm run bundle:vendor:all` (root: `bundle:vendor -w packages/daemon-cloud`;
 * oss: `bundle:vendor -w packages/daemon-standalone`).
 *
 * Paths are matched against BOTH repo roots the Refinery rebases: the cloud
 * monorepo root and the `oss` submodule checkout. In the oss repo the
 * `oss/`-prefixed spelling never appears (its own root IS `oss`), so both
 * spellings are listed rather than prefix-stripped at match time.
 *
 * ★Keep in sync with `VENDOR_PATHS` in `scripts/check-vendor-drift.mjs` and
 * `oss/scripts/check-vendor-drift.mjs` — those gates prove a bundle listed here
 * matches its source, which is what makes resolving its conflict safe. A path
 * added here WITHOUT a corresponding drift check would be resolved silently and
 * never verified.
 */
export const REFINE_GENERATED_VENDOR_BUNDLE_PATHS: readonly string[] = [
    // Cloud monorepo root (packages/daemon-cloud) — verified by scripts/check-vendor-drift.mjs
    'packages/daemon-cloud/vendor/mcp-server',
    'packages/daemon-cloud/vendor/session-host-daemon',
    'packages/daemon-cloud/vendor/terminal-mux-cli',
    // oss submodule (packages/daemon-standalone) — verified by oss/scripts/check-vendor-drift.mjs
    'packages/daemon-standalone/vendor/mcp-server',
    'packages/daemon-standalone/vendor/session-host-daemon',
    // ...as addressed from the cloud monorepo root, where the oss submodule is nested.
    'oss/packages/daemon-standalone/vendor/mcp-server',
    'oss/packages/daemon-standalone/vendor/session-host-daemon',
];

/**
 * True when `candidatePath` lies inside a known generated vendor bundle
 * directory.
 *
 * Deliberately a prefix test over an explicit directory list, NOT a `vendor/`
 * substring match: `oss/vendor/seqscribe` is a submodule, not build output.
 * Callers that resolve a conflict MUST additionally confirm the conflicting
 * index entry is a regular file (see
 * {@link isRefineGeneratedVendorBundlePath}'s use in the rebase resolver) so a
 * gitlink can never be resolved by this path.
 */
export function isRefineGeneratedVendorBundlePath(candidatePath: string): boolean {
    // Normalize win32 separators: `git diff --name-only` always emits forward
    // slashes, but callers may pass an OS-native path.
    const normalized = candidatePath.replace(/\\/g, '/');
    return REFINE_GENERATED_VENDOR_BUNDLE_PATHS.some(
        dir => normalized === dir || normalized.startsWith(`${dir}/`),
    );
}

/**
 * Detail payload for the `generated_bundle_conflict_resolved` refine stage.
 *
 * Kept next to the policy it describes so the stage record and the resolution
 * rule cannot drift apart, and so the sync_base call site stays a single call.
 * `verifiedBy` is recorded deliberately: the resolution takes the branch side and
 * may therefore leave a STALE bundle, and this names the gate that proves it is
 * not (see the module header).
 */
export function buildGeneratedBundleResolutionStageDetail(paths: string[]): {
    paths: string[];
    resolution: 'branch_side';
    verifiedBy: string;
} {
    return { paths, resolution: 'branch_side', verifiedBy: 'check:vendor (validation stage)' };
}
