// Single source of truth for WHERE the bundled `seqscribe` leaf's transitive deps
// (@noble/hashes, canonicalize) are resolved from — and for when picking the wrong
// place must be a hard failure rather than a silent fallback.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS (the 2026-09-20 incident)
//
// Both oss/packages/daemon-core/tsup.config.ts and oss/packages/mcp-server/
// tsup.config.ts pin those two deps to ONE canonical directory so the emitted
// bundle is byte-identical across machines: esbuild bakes the resolved package
// location into its `__esm`/`__commonJS` module-path comment keys, so "same
// source, different install layout" otherwise yields byte-different output and
// pins check-vendor-drift permanently red. (See each config's `pin-seqscribe-deps`
// plugin for the full background.)
//
// The pin walked a preference order — oss/node_modules, then the repo root — and
// took the first hit. That order is right; the FALLBACK was not. When
// oss/node_modules was missing, the walk fell through to the repo root SILENTLY
// and baked `../../../node_modules/...` into the bundle, where the committed
// bytes encode `../../` (OSS_ROOT, relative to the oss package dir). The
// pre-commit hook re-synced, reported success, committed the wrong paths — and
// the failure surfaced much later as an unexplained Refinery vendor-gate red on a
// branch that had touched nothing related.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY "FAIL WHEN ABSENT FROM BOTH" DOES NOT FIX IT
//
// The dep was present at the repo root. Any rule keyed on "can I find this
// package anywhere" is green in exactly the situation that broke, so it cannot be
// the guard. Nor can the per-package existence probe the old code used: it sees
// only "is @noble/hashes under this base", which is equally false for
//
//   (a) the oss workspace was never installed  — a LEGITIMATE root-only build, and
//   (b) the oss workspace was installed but is missing this dep — CORRUPTION.
//
// Collapsing (a) and (b) is the actual defect. Everything below exists to tell
// them apart.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DISTINGUISHING SIGNAL: the oss install ROOT, not the individual package
//
// `oss/node_modules` is created if and only if an install has been rooted at
// oss/. Verified empirically rather than assumed (darwin, npm workspaces, two
// synthetic monorepos mirroring this one's shape):
//
//   - `npm install` at the repo root, with 'oss/packages/*' in the root
//     `workspaces` glob, creates NO oss/node_modules — not even when the oss
//     packages depend on each other and on the pinned deps. npm hoists the whole
//     tree, oss packages included, into the ROOT node_modules.
//   - `npm install` with cwd=oss creates oss/node_modules and places the deps
//     there, per oss's own package-lock.json.
//
// So the three real states are distinguishable:
//
//   | oss/node_modules | dep in oss/node_modules | state                    | action    |
//   |------------------|-------------------------|--------------------------|-----------|
//   | absent           | —                       | genuine root-only build  | REPO_ROOT |
//   | present          | present                 | oss install (normal)     | OSS_ROOT  |
//   | present          | absent                  | PARTIAL/BROKEN oss install| FAIL      |
//
// Row 3 is the incident, and it is the row the old probe could not see. Row 1 is
// the legitimate case the fallback exists for, and it keeps working — making OSS
// unconditionally mandatory would break real root-only builds, which is why this
// is a three-state rule and not a two-state one.
//
// Refinery is consistent with this: scripts/refine-bootstrap.mjs runs a dedicated
// `npm install` with cwd=oss before any oss package is built, so the vendor-
// producing path is always in row 2.
//
// ─────────────────────────────────────────────────────────────────────────────
// COMMIT-BOUND BUILDS ARE STRICTER STILL
//
// Row 1 is fine for a developer's root-only build, but it is NOT fine for a build
// whose bytes get COMMITTED: the committed vendor bundles encode OSS_ROOT-relative
// paths, so a row-1 build re-vendoring them writes paths that the next
// check-vendor-drift run — on any machine in row 2 — reports as drift. Callers on
// the commit path therefore pass `requireOssInstall: true`, which promotes row 1
// from "allowed" to "fail loudly". That is the exact promotion the incident needed:
// the pre-commit hook was in row 1 and silently produced committable garbage.
//
// The three vendor-producing entry points (scripts/vendor-precommit.mjs,
// scripts/check-vendor-drift.mjs, scripts/bundle-vendor-all.mjs) set
// ADHDEV_VENDOR_COMMIT_BUILD=1, which `isCommitBoundVendorBuild()` reads, so the
// strict mode travels through the `npm run build -w ...` boundary into tsup
// without every config needing its own plumbing.

import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Deps of the bundled `seqscribe` leaf that must resolve from ONE fixed place,
 * regardless of how npm happened to lay out this checkout.
 *
 * Shared so the two tsup configs cannot pin different sets — they bundle the same
 * seqscribe, and mcp-server inlines daemon-core's dist, so a set that differs
 * between them produces exactly the cross-layer byte drift this module prevents.
 */
export const PINNED_SEQSCRIBE_DEPS = ['@noble/hashes', 'canonicalize'];

/**
 * Env flag marking a build whose output gets committed (a vendored bundle).
 *
 * Set by the vendor-producing entry points so it survives the `npm run build -w`
 * hop into tsup. Read via a helper rather than inline so the spelling has one
 * definition on both the setting and the reading side.
 */
export const VENDOR_COMMIT_BUILD_ENV = 'ADHDEV_VENDOR_COMMIT_BUILD';

/** Is this build producing bytes that will be committed? */
export function isCommitBoundVendorBuild(env = process.env) {
  const v = env[VENDOR_COMMIT_BUILD_ENV];
  return v === '1' || v === 'true';
}

/**
 * Has an install been rooted at `oss/`?
 *
 * Presence of oss/node_modules is the signal — see the header table. A root-only
 * install never creates it, so this cleanly separates "oss not installed" from
 * "oss installed but this dep is hoisted/missing".
 */
export function isOssWorkspaceInstalled(ossRoot) {
  return existsSync(path.join(ossRoot, 'node_modules'));
}

/**
 * Resolve the ONE canonical base directory whose `node_modules` the pinned deps
 * must be taken from.
 *
 * @param {string} spec           bare package specifier, e.g. '@noble/hashes'
 * @param {object} opts
 * @param {string} opts.ossRoot   absolute path to `oss/`
 * @param {string} opts.repoRoot  absolute path to the repo root (parent of oss/)
 * @param {boolean} [opts.requireOssInstall]
 *        When true, an absent oss install is an ERROR rather than a fallback.
 *        Set this for builds whose output is committed. Defaults to
 *        `isCommitBoundVendorBuild()`.
 *
 * @returns {{ base: string, dir: string } | undefined}
 *        The base whose node_modules holds `spec`, and the package dir itself.
 *        `undefined` ONLY in the one benign case: a genuine root-only build
 *        (no oss install) where the dep is absent from the repo root too — there
 *        is then nothing to pin and resolution is left to esbuild's default,
 *        which is the pre-existing behavior for that case.
 *
 * @throws  When the layout is one a correct build cannot be produced from:
 *          a present-but-incomplete oss install, or an absent oss install on a
 *          commit-bound build. Both used to fall through silently and bake
 *          repo-root-relative paths into committed bundles.
 */
export function resolvePinnedDepBase(spec, opts) {
  const { ossRoot, repoRoot } = opts;
  const requireOssInstall = opts.requireOssInstall ?? isCommitBoundVendorBuild();

  const ossInstalled = isOssWorkspaceInstalled(ossRoot);
  const ossDir = path.join(ossRoot, 'node_modules', spec);

  if (ossInstalled) {
    if (existsSync(ossDir)) return { base: ossRoot, dir: ossDir };
    // oss IS installed, yet the dep is not in it. Falling back to the repo root
    // here is precisely the 2026-09-20 failure: the repo root very likely HAS the
    // dep (the root lockfile hoists it there too), so the fallback succeeds and
    // bakes `../../../node_modules/...` where the committed bytes need `../../`.
    // There is no reading of this state under which the repo root is the right
    // answer, so it fails regardless of `requireOssInstall`.
    throw new Error(
      `[pinned-dep-base] ${spec} is missing from oss/node_modules, but the oss workspace IS installed.\n` +
        `  Expected: ${ossDir}\n` +
        `  This is a partial or pruned oss install, not a valid layout. Falling back to the repo\n` +
        `  root would bake repo-root-relative module paths ("../../../node_modules/...") into the\n` +
        `  bundle where the canonical form is oss-relative ("../../node_modules/..."), producing a\n` +
        `  vendor bundle that fails check:vendor on every correctly-installed machine.\n` +
        `  Fix: run \`npm install\` with cwd=oss (see scripts/refine-bootstrap.mjs).`,
    );
  }

  if (requireOssInstall) {
    // Row 1 on a commit-bound build. The repo root may well have the dep, but its
    // path is not the one the committed bundle encodes, so producing bytes here is
    // worse than producing none.
    throw new Error(
      `[pinned-dep-base] the oss workspace is not installed (${path.join(ossRoot, 'node_modules')} is absent),\n` +
        `  but this build's output is committed (${VENDOR_COMMIT_BUILD_ENV}=1).\n` +
        `  A root-only install resolves ${spec} from the repo root, which bakes\n` +
        `  "../../../node_modules/..." into the bundle instead of the canonical "../../node_modules/...".\n` +
        `  That drift is silent at build time and surfaces later as an unexplained check:vendor failure.\n` +
        `  Fix: run \`npm install\` with cwd=oss before re-vendoring (see scripts/refine-bootstrap.mjs).`,
    );
  }

  // Genuine root-only build: the repo root is the correct and only base.
  const repoDir = path.join(repoRoot, 'node_modules', spec);
  if (existsSync(repoDir)) return { base: repoRoot, dir: repoDir };

  // Nothing to pin anywhere. Pre-existing behavior: leave it to esbuild.
  return undefined;
}
