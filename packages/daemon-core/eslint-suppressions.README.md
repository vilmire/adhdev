# `eslint-suppressions.json` — frozen baseline (2026-08-24)

`eslint-suppressions.json` is written and read by ESLint itself (native bulk
suppressions, `--suppress-all`), so it is strict JSON with no room for comments.
This file is the comment.

## Why this exists

The canon-identity guard in `eslint.config.mjs` (`no-restricted-syntax` over
`src/mesh/**`) landed on **2026-07-04 as `'warn'`** with a note saying the
remaining sites would be "flipped to `'error'` in a follow-up". The follow-up did
not arrive for 50 days, and `npm run lint` was registered in **no** chain — not
`npm run ci`, not `.adhdev/refine.json` — so the rule was never executed by any
automated path. It guarded nothing.

On **2026-08-24** the rule was flipped to `'error'` and `lint` was registered in
both chains. The 15 pre-existing violations were frozen here rather than fixed in
the same change (fixing them is a semantic change to mesh identity comparison and
belongs in its own reviewed commit) and rather than left as warnings.

**A baseline can only shrink. A warning stays forever.** That is the whole reason
this is a suppressions file and not a lowered severity. It matches the pattern
already used by `check:file-sizes` and `check:boundaries` in this repo.

## What is frozen (15 sites, 7 files)

| File | Count | Class |
|---|---|---|
| `mesh-graph-transition-runner.ts` | 7 | task-graph ids |
| `mesh-graph-gates.ts` | 3 | task-graph ids |
| `mesh-graph-view.ts` | 1 | task-graph ids |
| `mesh-graph-workspace-ports.ts` | 1 | cross-form (`n.id === req.nodeId`) |
| `mesh-onboarding-plan.ts` | 1 | cross-form (`node.id === duplicate.nodeId`) |
| `mesh-refine-inflight.ts` | 1 | same-source ledger id |
| `mesh-refine-terminal-guard.ts` | 1 | same-source ledger id |

The three classes are not equally urgent, and a future cleanup should treat them
differently:

- **task-graph ids (12)** — `mesh-graph-*` compares `edge.fromNodeId` /
  `edge.toNodeId` against `node.nodeId` within a single task graph. These are
  graph-internal row ids, a *different namespace* from mesh network node ids;
  they never carry the `mach_` / `daemon_mach_` / `standalone_mach_` prefixes the
  rule guards against. The rule matches on property *name* alone, so it cannot
  tell the two namespaces apart. Lowest risk — arguably the rule's selector, not
  the call sites, is what should change here.
- **same-source ledger ids (2)** — `mesh-refine-*` compares real mesh node ids,
  but both sides provably come from the same ledger spelling, and each site
  already carries a comment saying so. These are the "verified same-source
  canonical comparison" case the rule's own message points at; converting them to
  an inline `eslint-disable` + reason would be a faithful cleanup.
- **cross-form (2)** — `node.id === duplicate.nodeId` and
  `n?.id === req.nodeId` compare an `id` field against a `nodeId` field. This is
  exactly the drift shape the rule exists to catch, and these two are the real
  candidates for `meshNodeIdMatches()`.

## Working with the baseline

```bash
npm run lint         # gate: new violations fail; frozen ones are silent
npm run lint:prune   # after fixing a site, drop its now-unused suppression
```

Unused suppressions **fail** the gate (ESLint's default — this repo does not pass
`--pass-on-unpruned-suppressions`). That is the ratchet: fix a site and the gate
tells you to shrink the baseline, so the count can never drift back up quietly.

**Do not** re-run `--suppress-all` to make a newly introduced violation go away.
That is the failure this whole change exists to close.
