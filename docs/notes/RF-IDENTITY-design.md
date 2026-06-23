# RF-IDENTITY — Daemon-id normalization: single-source design note

**Status:** investigation + design only (no code change in this branch).
**Scope:** the daemon-id *normalization helpers*, not the server identity-*space*
model. The latter (the `mach_` / `mreg_` / raw-hex three-space problem) is a
separate, already-landed effort — see
`docs/refactoring/2026-06-15-daemon-identity-unification-plan.md`. This note is
strictly about the **string-form collapsing helpers** that the task flagged as
duplicated in three places.

> **Headline finding:** the "3-way split" is already ~90 % unified. The mesh-shared
> helper is the de-facto single source and is adopted everywhere that matters. The
> oss-local pair in `mesh-events-utils.ts` is **dead orphan code with zero live
> callers**, and the server helper is **not a duplicate at all** — it solves a
> different problem (DB-backed cross-space translation). The residual work is much
> smaller than "large-scale refactor": delete the dead pair, document the boundary.

---

## 1. The three call sites, compared

| | **mesh-shared** (canonical) | **oss-local** (duplicate) | **server** (different concern) |
|---|---|---|---|
| File | `oss/packages/mesh-shared/src/daemon-normalize.ts` | `oss/packages/daemon-core/src/mesh/mesh-events-utils.ts:21–31` | `packages/server/src/utils/canonical-daemon-id.ts` |
| Exports | `machineCoreFromDaemonId`, `daemonIdsEquivalent`, `expandDaemonIdForms` | `canonicalDaemonId`, `sameDaemonId` | `canonicalDaemonIdFromLocalMachineId`, `resolveCanonicalDaemonId` (+ private `stripDaemonPrefix`, `isRawHex`) |
| Job | Collapse the three **interchangeable forms of one machine core** (`mach_X` ↔ `daemon_mach_X` ↔ `standalone_mach_X`) and **expand** a self-id set to all forms | Collapse `daemon_`/`standalone_` prefix to bare id; equality of two ids | Translate across **three identity SPACES** (`mach_` / `mreg_` / raw 64-hex DO id) into canonical `daemon_mach_*`, using the D1 `machines` table as the hub |
| Sync/async | sync, pure string | sync, pure string | **async**, D1-DB-backed, user-scoped |
| Direction | strips to machine core | strips to bare core | **adds** the `daemon_` prefix |
| Prefix handling | `startsWith` over `['daemon_','standalone_']` | regex `^(?:daemon\|standalone)_` | `daemon_` only (no `standalone_`) |
| Empty input | returns `undefined` | returns `''` | returns `null` |
| Input type | `string \| null \| undefined` | `unknown` (self-coerces) | `string` |
| Extra capability | `expandDaemonIdForms` (set expansion) — the reconcile/drain path needs it | none | `mreg_`/raw-hex DB lookups — the mesh-shared pair cannot do this |

### Behavioral equivalence (mesh-shared vs oss-local)

`canonicalDaemonId` ≈ `machineCoreFromDaemonId`, and `sameDaemonId` ≈
`daemonIdsEquivalent`. They are semantically identical (collapse one `daemon_`/
`standalone_` prefix; equality requires both non-empty and equal). The only
differences are cosmetic: the empty-return sentinel (`''` vs `undefined`) and the
declared input type (`unknown` vs `string|null|undefined`). mesh-shared
internally routes through `readString`, so it already tolerates non-string input
in practice; there is **no behavioral case where the oss-local pair does
something mesh-shared cannot**.

### The server helper is NOT a duplicate

`resolveCanonicalDaemonId` is a different concern and is **not substitutable** by
mesh-shared:
- It crosses **identity spaces** (`mreg_` PK, raw-hex DO id) that the pure-string
  helpers know nothing about, via D1 `machines`-table lookups.
- It is **async + user-scoped** and **adds** the `daemon_` prefix (mesh-shared
  strips it).
- Its only string-level overlap is the private one-liner `stripDaemonPrefix`,
  which handles `daemon_` **only** (the server space never carries `standalone_`).

So the genuine duplication is a **2-way** issue (mesh-shared vs oss-local), not
3-way. The server helper should stay where it is.

---

## 2. Current adoption (what already uses mesh-shared)

mesh-shared is already the single source in every live path:

- `oss/packages/daemon-core/src/index.ts:192` **re-exports**
  `expandDaemonIdForms, daemonIdsEquivalent, machineCoreFromDaemonId` from
  `@adhdev/mesh-shared`.
- `daemon-core/src/commands/router.ts` — self-forward / remote-vs-self gates use
  `daemonIdsEquivalent` (multiple call sites).
- `daemon-core/src/mesh/mesh-events-coordinator.ts` &
  `mesh/mesh-reconcile-loop.ts` — use `expandDaemonIdForms`.
- `oss/packages/mcp-server/src/tools/mesh-tools.ts` — uses `daemonIdsEquivalent`.
- Proprietary side already depends on mesh-shared too:
  `packages/daemon-cloud/src/adhdev-daemon.ts` imports `daemonIdsEquivalent`;
  `packages/web-cloud` imports other mesh-shared helpers. (`daemon-cloud` bundles
  it via `noExternal: ['@adhdev/mesh-shared']`.)

### The oss-local pair is dead

`canonicalDaemonId` / `sameDaemonId` in `mesh-events-utils.ts`:
- are **not** re-exported through `daemon-core/src/index.ts`;
- have **zero** call sites — `mesh-events-coordinator.ts` imports *other* names
  from `mesh-events-utils.js` (`buildMeshSystemMessage`, `readNonEmptyString`,
  `readRecord`, `resolveEventSessionId`, `readRefineJobId`,
  `readWorkerResultMetadata`, `resolveMeshSurfacedSessionPreview`) but **not**
  these two;
- the only textual reference is a *comment* in `router.ts:6409`
  ("the self-forward gate (mesh-events-coordinator: sameDaemonId)") — the code
  there actually uses `daemonIdsEquivalent`; the comment is stale.

They are a leftover from before the migration to mesh-shared.

---

## 3. Unification plan

### Step 1 — delete the dead oss-local pair (trivial, low-risk)
- Remove `canonicalDaemonId` and `sameDaemonId` from
  `oss/packages/daemon-core/src/mesh/mesh-events-utils.ts`.
- Any future caller that wants form-collapse uses the already-re-exported
  mesh-shared `machineCoreFromDaemonId` / `daemonIdsEquivalent`.
- Update the stale `router.ts:6409` comment to name `daemonIdsEquivalent`.
- **No call-site migration needed** — there are no callers.

### Step 2 — server boundary: document, do not merge
- Leave `resolveCanonicalDaemonId` and `canonicalDaemonIdFromLocalMachineId` in
  `packages/server`. They are a distinct, DB-backed concern.
- **Recommendation: do NOT** pull `stripDaemonPrefix` into mesh-shared. The
  cost/benefit is poor — it is one private line, the server never sees
  `standalone_`, and `packages/server` does not currently depend on mesh-shared
  (unlike `daemon-cloud`/`web-cloud`). Adding an oss-leaf dependency to the
  Cloudflare Worker bundle for a one-liner is not justified.
- If a future change *does* want true single-source for the `daemon_`-strip,
  the clean move is to have the server import `machineCoreFromDaemonId` from
  mesh-shared (it is a dependency-free leaf, Worker-bundle-safe) and keep the
  `mreg_`/raw-hex/DB logic local. Treat this as optional polish, not part of P1.

### Step 3 — guard against regression
- Add a one-line lint/comment convention note: daemon-id form-collapsing lives in
  `@adhdev/mesh-shared/daemon-normalize`; do not re-implement locally.
- The existing `oss/packages/mesh-shared/test/daemon-normalize.test.ts` already
  covers `machineCoreFromDaemonId` / `daemonIdsEquivalent` / `expandDaemonIdForms`
  behavior (empty input, cross-form equivalence, non-`mach_` passthrough). No new
  test is required for Step 1 (pure deletion of unused code), but a quick
  `tsc`/build + `npm run test:daemon-core` confirms nothing referenced the
  deleted names.

---

## 4. Risks

- **Near-zero for Step 1.** Pure dead-code removal. The only thing to double-check
  before deleting is that no *string-based / dynamic* import or generated
  `dist/**.d.ts` re-export references the names. `src/index.ts` does not re-export
  them, and a repo-wide search finds no `canonicalDaemonId(`/`sameDaemonId(` call
  sites; rebuilding `dist` regenerates any stale `.d.ts`.
- **Server (Step 2):** the real risk would be *forcing* a merge that loses the
  `standalone_`-vs-`daemon_` distinction or drags an oss dependency into the
  Worker bundle. Avoid it — document the boundary instead.
- **Convergence:** this branch's oss pointer is currently behind `oss/main`; land
  Step 1 on a branch that is rebased onto the latest `oss/main` so the deletion
  does not conflict with unrelated in-flight mesh work.

---

## 5. Recommendation

RF-IDENTITY is **not** a large-scale refactor. The mesh-shared single-source
migration already happened; what remains is a small, safe cleanup (Step 1) plus a
documented decision to leave the server helper alone (Step 2). Recommend
approving Step 1 as a standalone low-risk PR and explicitly closing out the
"server" leg as "intentionally separate".
