# CLI State Detection — `adhdev:cli/spec@4` FSM Guide

ADHDev decides whether a CLI agent session is **idle**, **busy**, or **waiting
for approval** by running a declarative finite-state machine against the
agent's terminal screen. The spec id is `adhdev:cli/spec@4`. This guide covers
the engine, the spec shape, and how to author and debug specs.

The engine lives in OSS at
`oss/packages/daemon-core/src/providers/spec/`. Per-provider spec JSON lives in
the `adhdev-providers` repo at `cli/<type>/specs/<version>.json`. The root
`docs/ARCHITECTURE.md` (proprietary superproject) notes that the FSM is the
single authority for CLI status; this is the full reference for that engine.

## 1. Concept — a declarative FSM

A v4 spec describes a finite state machine the way a Unity animator layer does:
**states are nodes, transitions are guarded directed edges.** The engine
(`fsm-driver.ts`) holds ZERO CLI-specific knowledge — it carries exactly one
piece of runtime state (the current FSM node) and on every screen change asks
the evaluator "which outgoing transition fires?".

Everything that used to live in the driver as a hard-coded debounce — startup
grace, busy hold, completion-marker stability, idle hold — is now expressed
declaratively as a state, a transition condition, or a per-edge guard. **To
support a new CLI you write a spec; you never touch the engine.** The only way
the engine can be "wrong" is if a spec's transitions are wrong, and every
evaluation is fully inspectable (see §6). The contract is: *debug the spec, not
the engine.*

This replaces the prior script-based detection, where each provider shipped
imperative JS that the daemon executed to classify the screen. That logic is now
data.

## 2. Spec anatomy

A `CliSpecV4` (see `fsm-types.ts`) has:

- `$schema: "adhdev:cli/spec@4"`, `id`, `name`, `binary`, optional `spawn_args` /
  `env` / `cli_version_range`.
- `send_message: { submit_key, delay_ms_before_submit?, delay_ms_per_char? }`.
- `send_on_spawn?` / `send_on_spawn_delay_ms?` — raw byte sequences written once
  after spawn to wake focus-gated TUIs (e.g. antigravity's Ink `useFocus` input
  box that drops the first programmatic write until it gets `ESC [ I`).
- `sections: Record<string, SectionDef>` — named screen regions (see §3).
- `states: FsmState[]` and `transitions: FsmTransition[]` — the FSM.
- Optional `control_bar`, `notifications`, `delegate`, `native_history`,
  `requiresFinalAssistantBeforeIdle`.

### States

```ts
interface FsmState {
  id: string;
  label: string;
  initial?: boolean;   // exactly one state must be initial:true
  modal?: boolean;     // approval/picker — surfaced distinctly in the dashboard
  status?: 'idle' | 'generating' | 'approval';
  extract?: { title?: ExtractTitle; buttons?: ExtractButtons };  // modal title/buttons
}
```

`status` defaults when omitted: `modal → approval`, `initial → idle`,
`id === 'busy' | 'generating' → generating`, else `idle` (`statusForState()`).

### Transitions

```ts
interface FsmTransition {
  from: string | string[] | '*';   // source state(s), or wildcard
  to: string;                      // destination state
  when?: FsmCondition;             // guard; omitted → always eligible
  min_hold_ms?: number;            // min time in `from` before this edge can fire
  priority?: number;               // higher evaluated first; ties = declaration order
  label?: string;                  // for the debugger
}
```

On each frame the evaluator walks the current state's outgoing transitions in
priority order and fires the **first** one whose `min_hold_ms` is satisfied and
whose `when` condition is true (`evaluateFsm()` in `fsm-evaluator.ts`). If none
fire, the machine stays put.

### Conditions

`FsmCondition` is a superset of the shared screen-content conditions plus two
time leaves. The evaluator (`fsm-evaluator.ts`) recognizes exactly these kinds:

| Kind | Shape | Meaning |
| --- | --- | --- |
| `regex` | `{ section?, matches, flags?, cursor_row_min?/max?, cursor_col_min?/max? }` | A regex matches within a section (or whole screen), optionally gated by cursor position. |
| `changed` | `{ cursor_above, changed, stable_ms? }` | The N lines above the cursor did / did not change since last frame. |
| `elapsed_ms` | `{ elapsed_ms }` | True once N ms passed since the **current state** was entered (replaces startup grace). |
| `stable_ms` | `{ stable_ms, cursor_above? }` | True once the `cursor_above` region has been **unchanged** for N ms (replaces screen-active hold). |
| `all` | `{ all: [...] }` | Every child true. |
| `any` | `{ any: [...] }` | Any child true. |
| `not` | `{ not: <cond> }` | Inner condition false. |

`regex` and `changed` are delegated to the shared content evaluator
(`evaluator.ts`); `elapsed_ms` and `stable_ms` are evaluated against the clock
the driver owns (`now`, `stateEnteredAt`, per-region last-changed timestamps), so
the evaluator stays pure. Each leaf also reports a `remainingMs` countdown for
the debugger.

## 3. Section / modal detection

Sections (`SectionDef` in `types.ts`) carve the screen into named regions that
conditions match against. Anchoring options:

- `from_top` / `from_bottom` — a **fixed-offset window** from the top/bottom of
  the screen, optionally bounded by `until` (a section id or `^`-regex).
- `anchor` — a regex (or OR-set array) that pins the region to a matching line.
- `anchor_last` — when `true`, the **last** matching line wins; otherwise the
  first.
- `anchor_context` — `prev`/`next` guards around the anchor line.
- `until` / `until_regex` — where the region ends.

**Anchor-relative regions are preferred over fixed `from_bottom: N` windows.** A
fixed window breaks the moment the CLI's layout shifts by a line (a wider footer,
an extra status row); an anchor re-finds its landmark wherever it moved. Use
`from_bottom`/`from_top` only for stable, structurally-fixed strips.

Real example — codex-cli `specs/4.0.json`. The `modal` section anchors on the
**last** of several approval/prompt landmarks and runs until the `footer`
section:

```json
"modal": {
  "anchor": "Would you like to run the following command\\?|Allow command\\?|Allow Codex to|Allow the .+ MCP server to run tool|enter to submit \\| esc to cancel|Select a model",
  "anchor_last": true,
  "until": "footer"
},
"options": {
  "anchor": "^\\s*(?:[›>]\\s*)?\\d+\\.\\s",
  "anchor_last": true,
  "until": "footer"
},
"status": { "from_bottom": 4, "until": "footer" }
```

The `→approval` transition then guards on a regex inside that `modal` section:

```json
{
  "label": "→approval",
  "from": ["starting", "idle", "busy", "mcp_init"],
  "to": "approval",
  "priority": 100,
  "when": { "section": "modal", "matches": "Would you like to run the following command\\?|Allow command\\?|Allow Codex to" }
}
```

And it leaves the modal only when the prompt is gone AND the region has settled —
combining `not` + `stable_ms` so a mid-repaint frame can't false-fire:

```json
{
  "label": "approval→idle",
  "from": ["approval", "trust", "picker"],
  "to": "idle",
  "min_hold_ms": 300,
  "when": { "all": [
    { "not": { "section": "modal", "matches": "Allow command\\?|enter to submit" } },
    { "stable_ms": 800, "cursor_above": 5 }
  ] }
}
```

## 4. State → agent status mapping

`SpecCliAdapter.getStatus()` (`cli-adapter.ts`) maps the committed FSM state's
`status` to the daemon's `CliAdapterStatus.status`:

| FSM `state.status` | Adapter `status` | Notes |
| --- | --- | --- |
| `approval` | `waiting_approval` | Surfaces `activeModal` (title + buttons) when parsed. **Stays `waiting_approval` even if the modal fails to parse that frame** — a PTY repaint must not collapse an approval to idle. |
| `generating` | `generating` (busy) | |
| `idle` (or default) | `idle` | |

Lifecycle states that aren't FSM-driven are handled directly: not yet spawned →
`starting`, process exited → `stopped`. The FSM state is **authoritative** —
status is never inferred from whether a modal happened to parse this frame. This
is what eliminated the false "task completed" events that fired while a session
sat at an approval prompt.

## 5. Authoring / modifying a spec

1. Specs live in the `adhdev-providers` repo at
   `cli/<type>/specs/<version>.json` (e.g.
   `cli/codex-cli/specs/4.0.json`).
2. The provider's `provider.v1.json` points at the active spec
   (`"spec": "specs/4.0.json"`); the daemon resolves a spec via the
   compatibility/`cli_version_range` chain, falling back to `specs/default.json`
   then `spec.json` (`provider-loader.ts` / `spec/route.ts`).
3. A spec must declare exactly one `initial: true` state and a non-empty
   `states[]` + `transitions[]`. Author conditions against named `sections`.
4. `loadFsmSpec()` (`fsm-loader.ts`) validates with **code-based**, human-readable
   errors — `transitions[2].to references unknown state "budy"`, duplicate state
   ids, missing initial state, invalid regex in a `matches`, unknown
   `section` references in conditions / `extract`. Validation is pure
   (`validateFsmSpec()`), so a panel can "validate before save".
5. User overrides live under `~/.adhdev/providers/`; auto-updated upstream specs
   under `~/.adhdev/providers/.upstream/`. User overrides win.

## 6. Debugging with `spec_debug`

Do not ask a human for screen dumps — inspect the live FSM through the daemon's
`spec_debug` MCP tool (handler `spec-debug.ts`; it issues the
`get_spec_debug` daemon command for `targetSessionId`).

```
spec_debug(session_id: "<from list_sessions>", format: "json")
```

The returned `snapshot` reports:

- `spec_id`, `spec_path`, `current_state` (`id (label)`), `idle_hold_pending`,
  `last_busy_at`, `exited`, and `current_modal` when present.
- `sections` — the resolved text of every named region right now (so you can see
  exactly what an anchor captured).
- `stateHistory` — the recent state-change ring (newest first) with how long
  each state was held.

For the full per-transition reasoning, the driver also exposes `getFsmDebug()`:
every outgoing transition from the current state with `eligible` / `holdSatisfied`
+ `holdRemainingMs` / per-condition `CondResult` (`result`, `detail`,
`remainingMs`). That "why did / didn't this edge fire, and when will it" trace is
the whole point — a wrong idle/busy call is a spec bug you can read straight off
the snapshot rather than reproduce by hand.
