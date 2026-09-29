# `eslint-suppressions.json` — frozen baseline (2026-08-24)

`eslint-suppressions.json` is written and read by ESLint itself (native bulk
suppressions, `--suppress-all`), so it is strict JSON with no room for comments.
This file is the comment.

## Why this exists

The canon-identity guard in `eslint.config.mjs` (`no-restricted-syntax` over
`src/mesh/**`, widened to all of `src/**` on 2026-09-30 — the five raw sites that
surfaced in `commands/` and `config/` were fixed, not frozen) landed on **2026-07-04 as `'warn'`** with a note saying the
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

## What is frozen (3 sites, 3 files)

The task-graph-id sites (`mesh-graph-*`, 12) and one cross-form site
(`mesh-graph-workspace-ports.ts`) left with graph orchestration on 2026-09-30.

| File | Count | Class |
|---|---|---|
| `mesh-onboarding-plan.ts` | 1 | cross-form (`node.id === duplicate.nodeId`) |
| `mesh-refine-inflight.ts` | 1 | same-source ledger id |
| `mesh-refine-terminal-guard.ts` | 1 | same-source ledger id |

The two classes are not equally urgent, and a future cleanup should treat them
differently:

- **same-source ledger ids (2)** — `mesh-refine-*` compares real mesh node ids,
  but both sides provably come from the same ledger spelling, and each site
  already carries a comment saying so. These are the "verified same-source
  canonical comparison" case the rule's own message points at; converting them to
  an inline `eslint-disable` + reason would be a faithful cleanup.
- **cross-form (1)** — `node.id === duplicate.nodeId` compares an `id` field
  against a `nodeId` field. This is exactly the drift shape the rule exists to
  catch, and it is the real candidate for `meshNodeIdMatches()`.

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
