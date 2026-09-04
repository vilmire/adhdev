// Single source of truth for WHAT feeds the vendored bundles, and in WHAT ORDER.
//
// Two things used to be hard-coded independently in three places — the pre-commit
// hook (scripts/vendor-precommit.mjs), the CI gate (scripts/check-vendor-drift.mjs)
// and the unified re-sync (scripts/bundle-vendor-all.mjs):
//
//   1. the list of oss packages that must be rebuilt before vendoring, and
//   2. which source paths mean "a vendored bundle would change".
//
// They drifted, and the drift is the defect class this module exists to close.
// The gate rebuilt the whole chain; the hook rebuilt only mcp-server, against a
// possibly-stale daemon-core dist; and the hook's trigger predicate looked at
// mcp-server paths ALONE. Since oss/packages/mcp-server/tsup.config.ts inlines
// daemon-core (`noExternal` + an alias onto ../daemon-core/dist/index.js), a
// commit that touches ONLY daemon-core changes the vendored bytes but was
// invisible to the hook — so the copy went to origin/main stale and CI found it
// later, which is the expensive way to find it.
//
// Import from here rather than re-listing. A test pins hook and gate to this
// module so they cannot diverge again.
//
// WHY THIS LIVES IN oss/scripts/ AND NOT scripts/. Both layers must share it, and
// oss is independently publishable: oss/scripts/check-vendor-drift.mjs cannot
// import upward out of the submodule (it has no repo root above it in the OSS
// checkout). The dependency only works one way, so the module has to sit at the
// bottom — here — where the oss gate reaches it as a sibling and the root scripts
// reach it by descending into oss/. Everything it describes is oss-owned anyway;
// the root repo contributes no source to a vendored bundle.

// Rebuild order for the oss packages that feed the vendored bundles.
//
// Topologically ordered — each entry may consume the dist of the ones before it.
// mesh-shared and session-host-core are leaves; daemon-core consumes them; the
// terminal-mux chain builds on core→control→cli; session-host-daemon and
// mcp-server are the vendored endpoints (mcp-server inlines daemon-core's dist,
// hence its position last).
//
// Paths are oss-relative. Root callers prefix them with `oss/` (both spellings
// are workspace-addressable from the repo root because `oss/packages/*` is a
// workspace glob); the oss submodule uses them as-is.
export const VENDOR_BUILD_CHAIN = [
  'packages/mesh-shared',
  'packages/session-host-core',
  'packages/daemon-core',
  'packages/terminal-mux-core',
  'packages/terminal-mux-control',
  'packages/terminal-mux-cli',
  'packages/session-host-daemon',
  'packages/mcp-server',
];

// Source prefixes whose change can alter a vendored bundle's bytes.
//
// This is intentionally WIDER than "the packages that are literally copied into
// vendor/". mcp-server's bundle inlines daemon-core, which in turn bundles
// mesh-shared, session-host-core and seqscribe — so a daemon-core-only edit is a
// real vendor change even though no file under packages/mcp-server/ moved. That
// exact gap is what shipped stale.
//
// oss-relative, prefix-matched. `oss/vendor/seqscribe` is the nested submodule
// daemon-core bundles as a `file:` dependency.
export const VENDOR_SOURCE_PREFIXES = [
  'packages/mcp-server/',
  'packages/daemon-core/',
  'packages/mesh-shared/',
  'packages/session-host-core/',
  'packages/session-host-daemon/',
  'packages/terminal-mux-core/',
  'packages/terminal-mux-control/',
  'packages/terminal-mux-cli/',
  'vendor/seqscribe/',
];

/**
 * Does an oss-relative staged path feed a vendored bundle?
 *
 * Deliberately a prefix test over an explicit allow-list, not a "not in this
 * denylist" test: a new oss package must be opted IN here consciously. The
 * failure mode of a missing entry (stale vendor, caught by CI) is far cheaper
 * than the failure mode of a too-broad predicate (every docs-only commit
 * rebuilds the chain), and the control-group test pins the latter.
 */
export function isVendorSourcePath(ossRelativePath) {
  return VENDOR_SOURCE_PREFIXES.some((prefix) => ossRelativePath.startsWith(prefix));
}

/**
 * The chain as npm workspace specs, for a caller running from a given layer.
 *
 * `layer: 'root'` yields `oss/packages/...` (the repo root sees oss as a
 * subdirectory workspace); `layer: 'oss'` yields the bare oss-relative spec.
 */
export function vendorBuildChainFor(layer) {
  return layer === 'oss' ? [...VENDOR_BUILD_CHAIN] : VENDOR_BUILD_CHAIN.map((p) => `oss/${p}`);
}
