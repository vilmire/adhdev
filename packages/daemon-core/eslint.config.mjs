// Minimal, daemon-core-scoped ESLint flat config.
//
// Its ONLY job right now is the canon-identity guard for src/mesh/**: mesh node
// and daemon identifiers flow through several serialization forms (config `id`,
// wire `nodeId`, DB `node_id`; `mach_` / `daemon_mach_` / `standalone_mach_`), so
// a raw `a.nodeId === b.nodeId` / `x.daemonId === y.daemonId` comparison only
// happens to work when both sides landed in the same form. The moment an upstream
// form is mixed in, the comparison silently drops a node — a recurring defect
// class. The SSOT comparators live in @adhdev/mesh-shared
// (meshNodeIdMatches / daemonIdsEquivalent, re-exported from daemon-core's
// index.ts). This rule makes the raw form a lint error so new sites can't
// reintroduce the drift.
//
// Deliberately narrow: it does not lint the whole package (no formatting / style
// opinions), only the identity-comparison syntax under src/mesh/**. Existing
// intentional local-pool canonical comparisons are individually opted out with an
// inline eslint-disable + reason at the site — never bulk --fix'd away.
//
// Run by `npm run lint` (daemon-core) / `npm run lint` (root), which is wired
// into BOTH the CI chain and `.adhdev/refine.json`. Pre-existing violation sites
// are frozen in `eslint-suppressions.json`; see the rule comment below.

import tseslint from 'typescript-eslint';

// Raw identifier comparisons that must go through the shared normalizer instead.
// Matches `<obj>.<prop> === …` / `!==` (and the mirrored `… === <obj>.<prop>`)
// for the identity-bearing property names. Computed access (`a['nodeId']`) and
// helper calls are intentionally out of scope — the common raw form is the
// member-access `===`, which is exactly the drift-prone shape we want to block.
const IDENTITY_PROPS = ['nodeId', 'daemonId'];
const identityComparisonSelectors = IDENTITY_PROPS.flatMap((prop) => [
  `BinaryExpression[operator=/^[!=]==$/] > MemberExpression.left[property.name='${prop}']`,
  `BinaryExpression[operator=/^[!=]==$/] > MemberExpression.right[property.name='${prop}']`,
]);

const IDENTITY_MESSAGE =
  'Raw identifier comparison (.nodeId/.daemonId === …) is form-fragile: mesh ids ' +
  'flow in several forms (id/nodeId/node_id, mach_/daemon_mach_). Use ' +
  'meshNodeIdMatches() / daemonIdsEquivalent() from @adhdev/mesh-shared instead of ' +
  'raw identifier comparison. If this is a verified same-source canonical (normalized) ' +
  'comparison, add an inline // eslint-disable-next-line with a reason.';

export default tseslint.config({
  files: ['src/mesh/**/*.ts'],
  linterOptions: {
    // This config runs a single rule; it is not the arbiter of every
    // eslint-disable directive in the files. Pre-existing directives for rules we
    // don't enable here (e.g. @typescript-eslint/no-require-imports) would
    // otherwise be flagged "unused". Leave directive-hygiene to whatever full
    // lint pass owns those rules.
    reportUnusedDisableDirectives: false,
  },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      // Syntax-only: no type information needed for this AST-shape rule, so skip
      // the (slow) full type-check project wiring.
      project: false,
    },
  },
  plugins: {
    // Registered but with NO rules enabled — this only makes the plugin's rule
    // namespace known so a pre-existing inline `eslint-disable
    // @typescript-eslint/...` directive elsewhere in src/mesh/** resolves instead
    // of erroring as an "unknown rule". We deliberately do not turn on any
    // typescript-eslint rule here (this config's sole purpose is the identity guard).
    '@typescript-eslint': tseslint.plugin,
  },
  rules: {
    'no-restricted-syntax': [
      // ERROR (2026-08-24). This landed as 'warn' on 2026-07-04 with a "flip it in
      // a follow-up" note; the follow-up did not come for 50 days and `npm run
      // lint` was in no chain, so the guard never held anything. It is now an
      // error, and the pre-existing sites are frozen in
      // `eslint-suppressions.json` (ESLint native bulk suppressions) rather than
      // left as warnings — a baseline can only shrink, a warning stays forever.
      //
      // To clear a frozen site: fix it, then `npm run lint:prune` to drop its
      // suppression. Unused suppressions FAIL the gate, so the baseline ratchets
      // down and can never silently absorb a new violation. Do NOT bulk --fix,
      // and do NOT re-run `--suppress-all` to make a new violation go away.
      'error',
      ...identityComparisonSelectors.map((selector) => ({
        selector,
        message: IDENTITY_MESSAGE,
      })),
    ],
  },
});
