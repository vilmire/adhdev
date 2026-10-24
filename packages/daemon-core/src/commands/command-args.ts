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
import { preserveAuthenticatedMcpCommand } from './mcp-command-ingress.js'

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
    meshWriterStop?: import('../mesh/turn-ledger/effects.js').CancelDispatchRequest;
    holderReconcile?: { operationId: string; phase: 'prepare' | 'commit' | 'rollback' };
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

// ─── Router-stamped command source ─────────────────────────────────────────

/**
 * The router's trusted record of where a command entered (`CommandSource`),
 * for handlers that must tell a person at a dashboard from automation
 * (assistant input attribution, assistant/assistant-human-input.ts). ONE
 * writer: `DaemonCommandRouter.execute` deletes any caller-supplied value and
 * stamps it for the commands in `COMMAND_SOURCE_STAMPED`. Never trust it
 * from anywhere else.
 */
export const COMMAND_SOURCE_ARG = '_commandSource'

/** Commands whose handler reads `COMMAND_SOURCE_ARG`. */
export const COMMAND_SOURCE_STAMPED: ReadonlySet<string> = new Set(['send_chat', 'pty_input', 'interactive_prompt_response', 'assistant_staged_resolve'])

/** The router-stamped source, or undefined (absent → not human, fail-closed). */
export function readCommandSource(args: unknown): string | undefined {
    const raw = (args as Record<string, unknown> | null | undefined)?.[COMMAND_SOURCE_ARG]
    return typeof raw === 'string' && raw ? raw : undefined
}

/**
 * Non-serializable provenance capability stamped ONLY by `DaemonCommandRouter.execute`
 * onto `normalizedArgs` when a command entered via a verified owner transport
 * (`p2p` owner DataChannel or `standalone` HTTP/WS) with explicit positive
 * non-payload proof (`ownerVerified === true` / valid `TrustedOwnerIngressProof`).
 *
 * Because both the transport proof and the router-stamped capability live in
 * module-private `WeakMap`s bound to a live verification predicate, no JSON
 * payload field (`_commandSource`, `source`, `ownerVerified`, etc.) can forge it,
 * object spread (`{ ...args }`) strips it, and auth/channel revocation
 * invalidates it immediately.
 */
export interface TrustedOwnerIngressProof {
    readonly __trustedOwnerIngressProof: unique symbol
    readonly source: 'p2p' | 'standalone'
    readonly peerId?: string
    readonly channelGeneration?: number
    readonly authEpoch?: number
}

export interface TrustedOwnerIngressProofInput {
    readonly source: 'p2p' | 'standalone'
    readonly ownerVerified?: boolean
    readonly peerId?: string
    readonly channelGeneration?: number
    readonly authEpoch?: number
    readonly verifyCurrent?: () => boolean
}

interface StoredOwnerIngressProof {
    readonly source: 'p2p' | 'standalone'
    readonly peerId?: string
    readonly channelGeneration?: number
    readonly authEpoch?: number
    readonly verifyCurrent?: () => boolean
}

const TRUSTED_OWNER_INGRESS_STATE_KEY = Symbol.for('adhdev.daemon-core.trustedOwnerIngressState')

interface TrustedOwnerIngressState {
    readonly issuedOwnerIngressProofs: WeakMap<TrustedOwnerIngressProof, StoredOwnerIngressProof>
    readonly transportAttachedOwnerProofs: WeakMap<Record<string, unknown>, TrustedOwnerIngressProof>
    readonly trustedOwnerIngressArgs: WeakMap<Record<string, unknown>, StoredOwnerIngressProof>
}

function getTrustedOwnerIngressState(): TrustedOwnerIngressState {
    const g = globalThis as Record<symbol, TrustedOwnerIngressState | undefined>
    let state = g[TRUSTED_OWNER_INGRESS_STATE_KEY]
    if (!state) {
        state = Object.freeze({
            issuedOwnerIngressProofs: new WeakMap<TrustedOwnerIngressProof, StoredOwnerIngressProof>(),
            transportAttachedOwnerProofs: new WeakMap<Record<string, unknown>, TrustedOwnerIngressProof>(),
            trustedOwnerIngressArgs: new WeakMap<Record<string, unknown>, StoredOwnerIngressProof>(),
        })
        Object.defineProperty(globalThis, TRUSTED_OWNER_INGRESS_STATE_KEY, {
            value: state,
            writable: false,
            enumerable: false,
            configurable: false,
        })
    }
    return state
}

const {
    issuedOwnerIngressProofs,
    transportAttachedOwnerProofs,
    trustedOwnerIngressArgs,
} = getTrustedOwnerIngressState()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoredProofCurrentlyValid(
    stored: StoredOwnerIngressProof | undefined,
    expectedSource?: 'p2p' | 'standalone',
): stored is StoredOwnerIngressProof {
    if (!stored) return false
    if (expectedSource && stored.source !== expectedSource) return false
    if (stored.source === 'p2p' && (!stored.peerId || !stored.peerId.trim())) return false
    if (typeof stored.verifyCurrent === 'function') {
        try {
            if (stored.verifyCurrent() !== true) return false
        } catch {
            return false
        }
    }
    return true
}

export function issueTrustedOwnerIngressProof(input: TrustedOwnerIngressProofInput): TrustedOwnerIngressProof | null {
    if (!input || typeof input !== 'object' || input.ownerVerified === false) return null
    if (input.source !== 'p2p' && input.source !== 'standalone') return null
    const peerId = typeof input.peerId === 'string' ? input.peerId.trim() : undefined
    if (input.source === 'p2p' && !peerId) return null
    if (input.source === 'standalone' && input.ownerVerified !== true) return null
    const stored: StoredOwnerIngressProof = {
        source: input.source,
        ...(peerId ? { peerId } : {}),
        ...(typeof input.channelGeneration === 'number' ? { channelGeneration: input.channelGeneration } : {}),
        ...(typeof input.authEpoch === 'number' ? { authEpoch: input.authEpoch } : {}),
        ...(typeof input.verifyCurrent === 'function' ? { verifyCurrent: input.verifyCurrent } : {}),
    }
    if (!isStoredProofCurrentlyValid(stored, input.source)) return null
    const token = Object.freeze(
        Object.assign(Object.create(null), {
            source: input.source,
            ...(peerId ? { peerId } : {}),
            ...(typeof input.channelGeneration === 'number' ? { channelGeneration: input.channelGeneration } : {}),
            ...(typeof input.authEpoch === 'number' ? { authEpoch: input.authEpoch } : {}),
        }),
    ) as TrustedOwnerIngressProof
    issuedOwnerIngressProofs.set(token, stored)
    return token
}

export function isValidTrustedOwnerIngressProof(
    proof: unknown,
    expectedSource?: 'p2p' | 'standalone',
): proof is TrustedOwnerIngressProof {
    if (typeof proof !== 'object' || proof === null) return false
    const stored = issuedOwnerIngressProofs.get(proof as TrustedOwnerIngressProof)
    return isStoredProofCurrentlyValid(stored, expectedSource)
}

export function attachTrustedOwnerIngressProof<T extends Record<string, unknown>>(
    args: T,
    proof: TrustedOwnerIngressProof | null | undefined,
): T {
    if (isPlainRecord(args) && isValidTrustedOwnerIngressProof(proof)) {
        transportAttachedOwnerProofs.set(args, proof)
    }
    return args
}

export function readTrustedOwnerIngressProof(
    args: unknown,
    expectedSource?: 'p2p' | 'standalone',
): TrustedOwnerIngressProof | null {
    if (!isPlainRecord(args)) return null
    const proof = transportAttachedOwnerProofs.get(args)
    return isValidTrustedOwnerIngressProof(proof, expectedSource) ? proof : null
}

export function preserveTrustedOwnerTransportProof<T extends Record<string, unknown>>(
    sourceArgs: unknown,
    targetArgs: T,
): T {
    if (isPlainRecord(sourceArgs) && isPlainRecord(targetArgs)) {
        const proof = transportAttachedOwnerProofs.get(sourceArgs)
        if (isValidTrustedOwnerIngressProof(proof)) {
            transportAttachedOwnerProofs.set(targetArgs, proof)
        }
    }
    return preserveAuthenticatedMcpCommand(sourceArgs, targetArgs)
}

export interface RouterCommandIngressMetadata {
    readonly command?: string
    readonly source: string
    readonly ownerVerified?: boolean
    readonly inProcess?: boolean
    readonly hasForgedProvenanceFields?: boolean
    readonly hasRevokedOwnerProof?: boolean
}

const ROUTER_COMMAND_INGRESS_STATE_KEY = Symbol.for('adhdev.daemon-core.routerCommandIngressState')

function getRouterCommandIngressMap(): WeakMap<Record<string, unknown>, RouterCommandIngressMetadata> {
    const g = globalThis as Record<symbol, WeakMap<Record<string, unknown>, RouterCommandIngressMetadata> | undefined>
    let map = g[ROUTER_COMMAND_INGRESS_STATE_KEY]
    if (!map) {
        map = new WeakMap<Record<string, unknown>, RouterCommandIngressMetadata>()
        Object.defineProperty(globalThis, ROUTER_COMMAND_INGRESS_STATE_KEY, {
            value: map,
            writable: false,
            enumerable: false,
            configurable: false,
        })
    }
    return map
}

const routerCommandIngressArgs = getRouterCommandIngressMap()

export function stampRouterCommandIngress<T extends Record<string, unknown>>(
    args: T,
    metadata: RouterCommandIngressMetadata,
): T {
    if (isPlainRecord(args) && metadata && typeof metadata.source === 'string') {
        routerCommandIngressArgs.set(
            args,
            Object.freeze({
                source: metadata.source,
                ...(metadata.command ? { command: metadata.command } : {}),
                ...(metadata.ownerVerified !== undefined ? { ownerVerified: metadata.ownerVerified } : {}),
                ...(metadata.inProcess !== undefined ? { inProcess: metadata.inProcess } : {}),
                ...(metadata.hasForgedProvenanceFields !== undefined
                    ? { hasForgedProvenanceFields: metadata.hasForgedProvenanceFields }
                    : {}),
                ...(metadata.hasRevokedOwnerProof !== undefined
                    ? { hasRevokedOwnerProof: metadata.hasRevokedOwnerProof }
                    : {}),
            }),
        )
    }
    return args
}

export function readRouterCommandIngress(args: unknown): RouterCommandIngressMetadata | null {
    if (!isPlainRecord(args)) return null
    return routerCommandIngressArgs.get(args) ?? null
}

export function hasRevokedTrustedOwnerIngress(
    args: unknown,
    expectedSource?: 'p2p' | 'standalone',
): boolean {
    if (!isPlainRecord(args)) return false
    const stored = trustedOwnerIngressArgs.get(args)
    if (stored !== undefined && !isStoredProofCurrentlyValid(stored, expectedSource)) {
        return true
    }
    const attached = transportAttachedOwnerProofs.get(args)
    if (attached !== undefined && !isValidTrustedOwnerIngressProof(attached, expectedSource)) {
        return true
    }
    return false
}

export function markTrustedOwnerIngress<T extends Record<string, unknown>>(
    args: T,
    proof: TrustedOwnerIngressProof | null | undefined,
): T {
    if (!isPlainRecord(args) || !isValidTrustedOwnerIngressProof(proof)) {
        return args
    }
    const stored = issuedOwnerIngressProofs.get(proof)
    if (isStoredProofCurrentlyValid(stored)) {
        trustedOwnerIngressArgs.set(args, stored)
    }
    return args
}

export function preserveTrustedOwnerIngress<T extends Record<string, unknown>>(
    sourceArgs: unknown,
    targetArgs: T,
): T {
    if (isPlainRecord(sourceArgs) && isPlainRecord(targetArgs)) {
        const stored = trustedOwnerIngressArgs.get(sourceArgs)
        if (isStoredProofCurrentlyValid(stored)) {
            trustedOwnerIngressArgs.set(targetArgs, stored)
        }
        const routerIngress = routerCommandIngressArgs.get(sourceArgs)
        if (routerIngress) {
            routerCommandIngressArgs.set(targetArgs, routerIngress)
        }
    }
    return preserveAuthenticatedMcpCommand(sourceArgs, targetArgs)
}

export function isTrustedOwnerIngress(
    args: unknown,
    expectedSource?: 'p2p' | 'standalone',
): boolean {
    if (!isPlainRecord(args)) return false
    const stored = trustedOwnerIngressArgs.get(args)
    return isStoredProofCurrentlyValid(stored, expectedSource)
}

export function applyRouterCommandIngressProvenance(
    rawArgs: unknown,
    normalizedArgs: Record<string, unknown>,
    logSource: string,
    peerId: string | undefined,
    opts?: {
        inProcess?: boolean
        ownerVerified?: boolean
        ownerProof?: TrustedOwnerIngressProof | null
        verifyCurrentOwner?: () => boolean
    },
    hadCommandSourceArg?: boolean,
    command?: string,
): void {
    const rawRecord = isPlainRecord(rawArgs) ? rawArgs : null
    const hasForgedProvenanceFields = Boolean(
        hadCommandSourceArg ||
            (rawRecord &&
                ('ownerVerified' in rawRecord ||
                    '_ownerVerified' in rawRecord ||
                    'source' in rawRecord ||
                    COMMAND_SOURCE_ARG in rawRecord)),
    )
    const expectedOwnerSource = logSource === 'p2p' || logSource === 'standalone' ? logSource : undefined
    let verifyCurrentOwnerFailed = false
    if (typeof opts?.verifyCurrentOwner === 'function') {
        try {
            if (opts.verifyCurrentOwner() !== true) verifyCurrentOwnerFailed = true
        } catch {
            verifyCurrentOwnerFailed = true
        }
    }
    const hasRevokedOwnerProof = Boolean(
        hasRevokedTrustedOwnerIngress(rawArgs, expectedOwnerSource) ||
            (opts?.ownerProof !== undefined &&
                opts?.ownerProof !== null &&
                !isValidTrustedOwnerIngressProof(opts.ownerProof, expectedOwnerSource)) ||
            verifyCurrentOwnerFailed,
    )
    if (
        (logSource === 'p2p' || logSource === 'standalone') &&
        opts?.ownerVerified !== false &&
        opts?.inProcess !== true &&
        !hasRevokedOwnerProof
    ) {
        const attachedProof = readTrustedOwnerIngressProof(rawArgs, logSource)
        const explicitProof = isValidTrustedOwnerIngressProof(opts?.ownerProof, logSource)
            ? opts!.ownerProof
            : null
        const mintedProof =
            !attachedProof && !explicitProof && opts?.ownerVerified === true
                ? issueTrustedOwnerIngressProof({
                      source: logSource,
                      ownerVerified: true,
                      peerId: logSource === 'p2p' ? peerId || 'owner-p2p' : undefined,
                      verifyCurrent: opts.verifyCurrentOwner,
                  })
                : null
        const resolvedProof = attachedProof ?? explicitProof ?? mintedProof
        if (resolvedProof) {
            markTrustedOwnerIngress(normalizedArgs, resolvedProof)
        } else if (isTrustedOwnerIngress(rawArgs, logSource)) {
            preserveTrustedOwnerIngress(rawArgs, normalizedArgs)
        }
    }
    preserveAuthenticatedMcpCommand(rawArgs, normalizedArgs)
    stampRouterCommandIngress(normalizedArgs, {
        command,
        source: logSource,
        ownerVerified: opts?.ownerVerified,
        inProcess: opts?.inProcess === true,
        hasForgedProvenanceFields,
        hasRevokedOwnerProof,
    })
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
