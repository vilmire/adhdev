/**
 * Typed reads over the loose `args: any` bag every command handler receives.
 *
 * Wiring-unification Phase D (docs/design/2026-09-23-wiring-unification.md §6,
 * D1-D3) / workstream D-daemon. This file does NOT change behaviour — every
 * helper here reproduces exactly what the untyped call sites already do,
 * just with one typed reader instead of N inline `(args as any)?.foo`
 * casts. See `scratchpad/phase-D-daemon-brief.md` §2 row 4-6 and the B-residue
 * inventory (general-purpose agent report, 2026-09-23) for the untyped sites
 * this consolidates.
 *
 * ★ `_meshDirectDispatch` — ONE reader and ONE writer, here.
 * `readMeshDirectDispatchFlag` answers "was this dispatch already forwarded
 * once, so do not forward it again"; `withMeshDirectDispatch` builds the args
 * of every forwarded / self-pinned dispatch (router session forwarding, the
 * mesh med/low-family remote forwards, the queue's local dispatch, cloud's
 * incoming P2P mesh command). Pinned by
 * test/commands/mesh-direct-dispatch-single-writer.test.ts.
 *
 * ★ `SendPolicy`/`messageId`/`OutboundMessage` — one vocabulary, mesh-shared's
 * (`outbound-message.ts`); daemon-core does not fork it. `readSendPolicy` reads
 * `policy.mode`; the legacy booleans are a one-release mapped fallback (D3
 * cut-compat), logged at DEBUG by the caller. Every send origin turns these
 * reads into ONE `OutboundMessage` for `SessionInputService.submit`
 * (sessions/session-input-service.ts).
 */

import { isOutboundMessageOrigin, isSendPolicy, mintMessageId, type OutboundMessageOrigin, type SendPolicy } from '@adhdev/mesh-shared'

// ─── MeshCommandContext ─────────────────────────────────────────────────────

/**
 * The `meshContext` bag a mesh dispatch (local `mesh-queue-assignment.ts` or
 * remote via `dispatchMeshCommand`) attaches to an `agent_command` call.
 * Every field here is read somewhere in `cli-manager.ts`'s `agentCommand` —
 * see the field-level comments for the exact call site each one feeds.
 */
export interface MeshCommandContext {
    /** ARCH-REFACTOR R1: per-turn task identity, bound onto the turn so the
     *  worker's completion event is bound to THIS task. */
    taskId?: string
    /** WTCLAIM (B): scopes a nodeId-only dispatch to that node's own session,
     *  refusing findAdapter's provider-only fuzzy fallback. */
    nodeId?: string
    /** Stamped onto the target instance via attachMeshAssignmentToInstance. */
    meshId?: string
    coordinatorDaemonId?: string
    /** SESSION-ISOLATION: routes a worker completion back to the exact
     *  dispatching coordinator SESSION. */
    coordinatorSessionId?: string
    /** REDRIVE-DUP: carried onto the worker session so generating_started
     *  echoes it back for the coordinator's stale-nonce guard. */
    dispatchNonce?: number
    /** TURN-LEDGER (Stage 5): carried onto the worker session so lifecycle
     *  events echo it back for the coordinator's reducer. */
    attemptId?: string
    /** Wiring-unification C4/C5: the ledger generation of `attemptId`, so the
     *  worker's turn evidence carries a full `TurnAttemptRef` (a stale
     *  generation after a reclaim is rejected by the reducer, R28). */
    attemptGeneration?: number
    /** COORDINATOR-SILENT-IDLE: one-shot mute for the single completion that
     *  follows this dispatch. */
    silentIdlePush?: boolean
}

export function isMeshCommandContext(value: unknown): value is MeshCommandContext {
    return !!value && typeof value === 'object'
}

/** Read `args.meshContext`, typed. Returns `undefined` for anything that is
 *  not a non-null object — the same permissiveness every existing inline
 *  `(args as any)?.meshContext` read had. */
export function readMeshContext(args: unknown): MeshCommandContext | undefined {
    const mc = (args as { meshContext?: unknown } | null | undefined)?.meshContext
    return isMeshCommandContext(mc) ? mc : undefined
}

// ─── AgentCommandArgs ───────────────────────────────────────────────────────

/**
 * `args` shape for `DaemonCliManager.agentCommand` (`agent_command` action
 * `send_chat` / `clear_history` / `stop` / `interrupt_capability` / ...).
 * Structural and permissive by design — every field is optional because the
 * SAME `agentCommand` handles multiple `action` values, each reading a
 * different subset. This mirrors, field-for-field, what the 8 `as any`
 * cast sites in `cli-manager.ts` already assumed; nothing here narrows or
 * widens the accepted shape.
 */
export interface AgentCommandArgs {
    agentType?: string
    cliType?: string
    action?: string
    dir?: string
    targetSessionId?: string
    cliArgs?: unknown
    initialModel?: string
    input?: unknown
    message?: string
    /** Legacy send-now flag — dashboard only (mesh has no `sendNow` concept
     *  today, see phase-D-daemon-brief.md §1.2's "where the two funnels
     *  diverge"). Superseded by `policy.mode==='send_now'`; read as fallback
     *  by `readSendPolicy`. */
    sendNow?: boolean
    /** Legacy interrupt-alias booleans. Superseded by
     *  `policy.mode==='interrupt'`; read as fallback by `readSendPolicy`. */
    interrupt?: boolean
    force?: boolean
    forceSend?: boolean
    /** D-web's dual-written typed policy — see this file's header. Primary
     *  source once present; today always in agreement with the booleans
     *  above. */
    policy?: SendPolicy
    /** D-web's minted send-side identity (`mesh-shared` `mintMessageId`).
     *  Optional today — no daemon-side call site requires it yet (that is
     *  D2's `SessionInputService`); reading it now, uniformly, is what lets
     *  D2 thread it through without another args-shape pass. */
    messageId?: string
    dispatchSource?: string
    meshContext?: MeshCommandContext
    /** Router-side write; see this file's header. Read via
     *  `readMeshDirectDispatchFlag`, never compared directly. */
    _meshDirectDispatch?: boolean
    buttonIndex?: number
    buttonText?: string
    data?: unknown
    [key: string]: unknown
}

// ─── Guards / readers ───────────────────────────────────────────────────────

/**
 * The one reader for the `_meshDirectDispatch` forwarding-loop guard. Every
 * call site that gates a remote-forward decision on "has this dispatch
 * already been forwarded once" should read the flag through this function
 * instead of its own inline `args?._meshDirectDispatch` — see this file's
 * header for why the WRITE side is intentionally left where it is (owned by
 * the forwarding call site, not this reader).
 */
export function readMeshDirectDispatchFlag(args: unknown): boolean {
    return (args as { _meshDirectDispatch?: unknown } | null | undefined)?._meshDirectDispatch === true
}

/** The args of a dispatch pinned to local execution on the daemon that receives it. */
export type MeshDirectDispatchArgs = Record<string, unknown> & { _meshDirectDispatch: true }

/**
 * The one WRITER of the `_meshDirectDispatch` forwarding-loop guard (the
 * reader is `readMeshDirectDispatchFlag` above). A forwarded command lands on
 * the owning daemon with its args copied, `extra` applied, and the flag set —
 * so the receiver executes locally and never re-forwards (nor P2P self-dials
 * a legacy-form own daemon id). The flag rides the args because it must cross
 * the P2P / IPC hop with them; a non-object `args` contributes nothing.
 */
export function withMeshDirectDispatch(args: unknown, extra: Record<string, unknown> = {}): MeshDirectDispatchArgs {
    const base = typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}
    return { ...base, ...extra, _meshDirectDispatch: true }
}

/** Read `args.messageId`, typed. `undefined` for anything not a non-empty
 *  string — mirrors the permissive `typeof x === 'string' && x.trim()`
 *  pattern used throughout this codebase for optional string args. */
export function readMessageId(args: unknown): string | undefined {
    const raw = (args as { messageId?: unknown } | null | undefined)?.messageId
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

/**
 * Resolve the effective `SendPolicy` for a send-shaped args bag.
 *
 * `policy.mode` is THE source (wiring-unification D3). The legacy booleans
 * (`sendNow` → `send_now`; `interrupt`/`force`/`forceSend` → `interrupt`, in
 * that precedence — `sendNow` is its own flag, never an alias of interrupt)
 * are accepted for ONE release as a mapped fallback for pre-D dashboards and
 * older peers, and every use is logged at DEBUG through `onLegacy` so the
 * fallback's retirement can be judged from the log. Default `queue`.
 */
export function readSendPolicy(args: unknown, onLegacy?: (flag: string) => void): SendPolicy {
    const a = args as {
        policy?: unknown
        sendNow?: unknown
        interrupt?: unknown
        force?: unknown
        forceSend?: unknown
    } | null | undefined

    if (isSendPolicy(a?.policy)) return a!.policy as SendPolicy

    if (a?.sendNow === true) { onLegacy?.('sendNow'); return { mode: 'send_now' } }
    if (a?.interrupt === true) { onLegacy?.('interrupt'); return { mode: 'interrupt' } }
    if (a?.force === true) { onLegacy?.('force'); return { mode: 'interrupt' } }
    if (a?.forceSend === true) { onLegacy?.('forceSend'); return { mode: 'interrupt' } }
    return { mode: 'queue' }
}

/** `args.origin` when it names a known `OutboundMessageOrigin`, else `fallback`. */
export function readOutboundOrigin(args: unknown, fallback: OutboundMessageOrigin): OutboundMessageOrigin {
    const raw = (args as { origin?: unknown } | null | undefined)?.origin
    return isOutboundMessageOrigin(raw) ? raw : fallback
}

// ─── Refine dry-run/execute precedence ──────────────────────────────────────

/**
 * The single dry-run/execute precedence rule for every refine-family command
 * (`refine_mesh_node`, `batch_refine_mesh_nodes`, and their daemon-side batch
 * job starters). Mirrors `mesh_fast_forward_node`'s contract
 * (`mesh-tools-git.ts` `dry_run_false_requires_execute`):
 *
 *   - `dryRun === true` is a VETO that ALWAYS wins, even alongside
 *     `execute: true`. Before this helper existed, `isDryRun = dryRun !== false
 *     && execute !== true` computed `false` for `{execute:true, dryRun:true}`
 *     (`true !== false` is `true`, but `&&` with `execute !== true` being
 *     `false` flips the whole expression) — so a caller asking for a dry run
 *     alongside `execute:true` silently got the REAL validate→merge→push job.
 *     That is a safety bug, not a preference: dry_run must be able to abort
 *     execution unconditionally.
 *   - `dryRun === false` with no `execute: true` is refused outright — a bare
 *     `dry_run:false` is not itself a request to execute, and honoring it as
 *     one is the DRY-RUN-SILENTLY-IGNORED failure mode from the other
 *     direction (silently running when the caller only declined to preview).
 *   - Otherwise (dryRun undefined, or `false` alongside `execute:true`):
 *     `isDryRun = execute !== true`, i.e. execute must be explicitly `true`
 *     to run anything.
 */
export type DryRunVeto =
    | { refused: false; isDryRun: boolean }
    | { refused: true; code: 'dry_run_false_requires_execute'; error: string }

export function resolveDryRunVeto(args: unknown): DryRunVeto {
    const a = args as { dryRun?: unknown; execute?: unknown } | null | undefined
    const dryRun = a?.dryRun
    const execute = a?.execute
    if (dryRun === true) return { refused: false, isDryRun: true }
    if (dryRun === false && execute !== true) {
        return {
            refused: true,
            code: 'dry_run_false_requires_execute',
            error: 'dry_run:false alone does not execute — it only declines to veto. Pass execute:true to actually apply the refine.',
        }
    }
    return { refused: false, isDryRun: execute !== true }
}

/**
 * A daemon-minted messageId for a send whose origin sent none (pre-D clients,
 * the shortcuts API, `adhdev send`). Unique per call, so such sends are never
 * deduplicated against each other — exactly their pre-D behaviour.
 */
export function mintLegacyMessageId(): string {
    return `legacy:${mintMessageId()}`
}
