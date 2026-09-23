/**
 * session-status-ingest — single normalization helper for every web-core
 * status ingestion choke point (wiring-unification A1 follow-up).
 *
 * The daemon normalizes its OWN status vocabulary on its side (mesh-shared
 * `SessionStatus`), but the cloud dashboard also talks to fleet daemons
 * running an older daemon-core build that still emits pre-unification
 * spellings (`running`, `streaming`, `busy`, `working`, `loading`,
 * `loading_reference`, `thinking`, `active`, `initializing`, `waiting`).
 * Those must be folded onto the canonical vocabulary exactly once, at the
 * transport boundary, so every consumer downstream (components, hooks,
 * status-class checks) can compare against `SessionStatus` only.
 *
 * `no_progress` and `long_generating` are DELIBERATELY EXCLUDED from the
 * fold, even though `SESSION_STATUS_ALIASES` maps both onto `'generating'`
 * for CLASSIFICATION purposes (`isBusyStatus` / `isWorkingStatus` /
 * `classifySessionStatus`). They are not legacy spellings — a CURRENT
 * daemon still emits them as live `SessionEntry.status` values (see
 * `oss/packages/daemon-core/src/agent-stream/provider-adapter.ts`'s
 * `validatedStatus` check and `providers/status-monitor.ts`'s
 * `monitor:no_progress` event) to carry a status-LANE refinement of an
 * in-progress turn — "still generating, but stalled" — that
 * `ChatPane.buildBusyChatInputStatusMessage` renders as a DIFFERENT message
 * from plain `generating`. Folding them here would erase that distinction
 * for every daemon, not just old ones, which is a behavior regression, not
 * a cleanup. Classification call sites (isBusyStatus/isWorkingStatus/
 * classifySessionStatus) already treat them as `generating`-class via the
 * alias table directly — this ingestion point only touches the RAW status
 * string surfaced to direct `===` comparisons.
 */
import { SESSION_STATUS_ALIASES, normalizeSessionStatus } from '@adhdev/mesh-shared'

/** Raw wire spellings that must stay un-folded through ingestion — see module doc. */
const PRESERVED_RAW_REFINEMENTS: ReadonlySet<string> = new Set(['no_progress', 'long_generating'])

/**
 * Normalize a raw daemon-reported status string onto the canonical
 * mesh-shared `SessionStatus` vocabulary, except for the preserved
 * status-lane refinements above. An unrecognized spelling (not in
 * `SESSION_STATUS_ALIASES` and not a canonical member) passes through
 * unchanged — fail-open, never coerced to a guessed status.
 */
export function normalizeIncomingSessionStatus<T extends string | undefined>(raw: T): T {
    if (!raw) return raw
    if (PRESERVED_RAW_REFINEMENTS.has(raw)) return raw
    return (normalizeSessionStatus(raw) ?? raw) as T
}

// Re-exported for call sites that need the alias table itself (e.g. the
// top-level CLI/ACP compact-expansion path in BaseDaemonContext.tsx, which
// normalizes inline rather than through the helper above because it must
// preserve its own '|| online' fallback semantics).
export { SESSION_STATUS_ALIASES }
