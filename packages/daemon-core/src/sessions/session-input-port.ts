/**
 * SessionInputPort — wiring-unification C2's `submit()` seam over today's
 * inject path.
 *
 * Design SoT: docs/design/2026-09-23-wiring-unification.md §5 C2 — `turn.deliver`
 * (once B's session bus exists) resolves to
 * `SessionInputPort.submit({ messageId, origin:'mesh', policy:{mode:'queue'}, input })`.
 * §6 D1 owns the *daemon's own* `OutboundMessage`/`SubmitOutcome` types
 * (`providers/io-contracts.ts`) and the eventual `SessionInputService` that
 * replaces `chat-commands-write.ts` / `interrupt-and-deliver.ts` /
 * `send-now-queued-write.ts` outright (see
 * `scratchpad/phase-D-daemon-brief.md` §4). That work is out of scope here —
 * D2 is explicitly "swap the implementation, not the call site" against THIS
 * port's shape, so this file exists so C has something typed to call before D
 * lands.
 *
 * `createLegacySessionInputPort()` is the interim implementation: it does not
 * reimplement send/queue/interrupt, it drives the SAME three entry points
 * `chat-commands-write.ts`'s PTY branch already drives —
 * `sendMessage` (queue-or-deliver disposition, `providers/spec/cli-adapter.ts`
 * `SpecCliAdapter.sendMessage` → `SendSubmitEngine.handleSendMessage` /
 * `canSendNow` at `providers/spec/send-submit-engine.ts:338-365`),
 * `sendMessageDuringGeneration` (the POSIX split-write queue-bypass,
 * `send-submit-engine.ts:210-252`), and `interruptAndDeliver`
 * (`commands/interrupt-and-deliver.ts`, unchanged — reused verbatim, including
 * its interrupt-BEFORE-claim ordering, see that file's header). None of those
 * three are reimplemented; `deps` is the minimal injected surface a real
 * daemon wires to the SAME `CliAdapter`/`ProviderInstance` objects
 * `chat-commands-write.ts` resolves via `getTargetedCliAdapter`/
 * `getTargetInstance` (`commands/chat-commands-shared.ts`) — this file does
 * not import `providers/**` or `mesh/**` values, only the `mesh-shared` wire
 * types (`import type`) and its own `deps` contract.
 *
 * Uses mesh-shared's `OutboundMessage`/`SendPolicy`/`SubmitOutcome`/
 * `SendRefusal` (D-web's landed types, `@adhdev/mesh-shared`) directly rather
 * than daemon-core's own (not-yet-landed, D1's job) copy — see REQUESTED
 * EDITS in this file's test report for the reconciliation D1/D2 will need.
 */

import type {
    OutboundMessage,
    SendRefusal,
    SubmitOutcome,
} from '@adhdev/mesh-shared'
import { isDeadStatus, normalizeSessionStatus } from '@adhdev/mesh-shared'

// ─── Resolved session target — the narrowest real choke point ─────────────
//
// Mirrors (structurally, not by import) `InterruptibleAdapter`
// (`commands/interrupt-and-deliver.ts`) + `QueueWritableAdapter`
// (`commands/send-now-queued-write.ts`) + the ack call
// `chat-commands-write.ts`'s PTY branch makes on the resolved
// `ProviderInstance`/`RuntimeChatMessageMerger` (`recordAcknowledgedUserInput`,
// `commands/chat-commands-shared.ts`). A single `deps.resolveSession()` call
// returns one object satisfying all three roles because in the live daemon
// they ARE the same object graph (the `SpecCliAdapter` instance, or the
// `ProviderInstance` that owns it) — `chat-commands-write.ts` just resolves
// it twice, once via `getTargetedCliAdapter` and once via `getTargetInstance`.

/** What `submit()` needs from the resolved session target. Every method here
 *  already exists on the live adapter/instance pair — see the file header for
 *  the exact today-path entry each one maps to. */
export interface SessionInputTarget {
    /** Ordinary send — parks in the driver FIFO when busy, writes immediately
     *  when idle. Same contract as `CliAdapter.sendMessage` /
     *  `InterruptibleAdapter.sendMessage`. */
    sendMessage(
        text: string,
        options?: { bracketedPaste?: boolean; claimKey?: string },
    ): Promise<{ status: 'queued' | 'delivered' } | void>
    /** The POSIX-only split write that reaches the CLI's own mid-turn input
     *  queue. Optional — a target without it has no mid-generation path
     *  (mirrors `QueueWritableAdapter.sendMessageDuringGeneration`, which is
     *  itself optional on the adapter interface). */
    sendMessageDuringGeneration?(
        text: string,
        bracketedPaste?: boolean,
    ): { accepted: boolean; reason?: string }
    /** Press the provider's own stop key. Optional — an adapter that cannot
     *  interrupt reports so via the `interrupt_not_implemented` refusal
     *  (mirrors `InterruptibleAdapter.interruptTurn`, itself optional). */
    interruptTurn?(): Promise<
        | { ok: true; keyName: string; bytes: number; confidence: 'proven' | 'declared' }
        | { ok: false; reason: string; message: string }
    >
    /** SEND-NOW-DOUBLE-SEND: take queued copies of `text` out of the driver
     *  FIFO before an out-of-band write, returning the claimed entries so
     *  their actual body (e.g. a built image prompt) is what gets delivered. */
    claimQueuedSendEntries?(
        text: string,
    ): { text: string; bracketedPaste?: boolean; claimKey?: string }[]
    /** SEND-NOW-WRONG-ITEM: hold the driver's autonomous FIFO drain so an
     *  out-of-band caller owns the next write. */
    reserveDrain?(ttlMs: number): void
    releaseDrain?(): void
    /** Live status read, used only to decide whether a session exists at all
     *  and (for `queue`) to report a `SubmitOutcome.queued.position` best-effort.
     *  Never used as a second admission opinion — `sendMessage`'s own returned
     *  disposition is authoritative, exactly as it is today. */
    getStatus?(): { status?: string } | undefined
    /** TASKBUBBLE-DUP ack stamping — `cli-provider-runtime-messages.ts`
     *  `recordAcknowledgedUserInput`. `sourceMessageId` is NOT a parameter this
     *  function accepts today; see REQUESTED EDITS. */
    recordAcknowledgedUserInput?(input: unknown): void
}

/** Everything `submit()` needs injected. Kept structural and minimal — see
 *  the file header for why one `resolveSession` covers all three legacy
 *  entry points. */
export interface SessionInputPortDeps {
    /** Resolve `sessionId` to its live target, or `null`/`undefined` when no
     *  such session exists (mirrors `getTargetedCliAdapter`/`getTargetInstance`
     *  both returning `null` for an unknown/stale session id). May be async
     *  because a real daemon's session registry lookup can itself be a promise
     *  in some embedders; a sync resolver is also accepted. */
    resolveSession(
        sessionId: string,
    ): SessionInputTarget | null | undefined | Promise<SessionInputTarget | null | undefined>
    /**
     * The interrupt-then-claim-then-deliver sequence, injected rather than
     * imported so this file never pulls in `commands/interrupt-and-deliver.ts`
     * (and therefore never imports `@adhdev/mesh-shared`'s `isBusyStatus`/
     * `isDeadStatus` transitively through a module this port does not own).
     * Pass `interruptAndDeliver` from that file directly in production — its
     * `InterruptibleAdapter` structural shape is a subset of
     * `SessionInputTarget`, so a `SessionInputTarget` satisfies it as-is.
     * Refusal reasons this can produce (see that file): `interrupt_not_implemented`,
     * whatever string `interruptTurn()` itself reports (`not_running`, `not_busy`,
     * or an `InterruptUnsupportedReason`), `session_exited`, `idle_timeout`.
     */
    interruptAndDeliver(
        target: SessionInputTarget,
        text: string,
    ): Promise<
        | { ok: true; delivered: boolean; queued: boolean }
        | { ok: false; reason: string; message: string }
    >
    /**
     * The claim-before-write mid-generation send, injected for the same reason
     * as `interruptAndDeliver` (this file never imports
     * `commands/send-now-queued-write.ts`). Pass `sendNowIntoAgentQueue` from
     * that file directly in production.
     */
    sendNowIntoAgentQueue(
        target: SessionInputTarget,
        text: string,
    ): Promise<
        | { ok: true; claimed: number }
        | { ok: false; reason: string; message: string; restored: boolean }
    >
    /** Wall clock. Defaults to `Date.now`; injected for deterministic tests. */
    clock?: () => number
    /** Structured logger. Defaults to a no-op — the real daemon wires its
     *  `LOG` facade. Never receives message BODIES, only lengths/ids/reasons
     *  (content boundary — see CLAUDE.md "Server content boundary", which
     *  this port respects even though it never leaves the daemon process). */
    log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void
}

/** The one call surface C2 (and eventually D2) target. */
export interface SessionInputPort {
    submit(msg: OutboundMessage): Promise<SubmitOutcome>
}

/** Bounded memo of the last outcome per `messageId`, so a resubmit with the
 *  same id is idempotent without growing forever. Sized generously — this is
 *  a request-shaped map, not a queue; entries are evicted lazily (oldest
 *  first) once the map exceeds the cap, which only matters for a daemon that
 *  runs for a very long time without restart. */
const DEDUPE_MAP_MAX_ENTRIES = 5_000

function noopLog(): void {
    /* no-op default logger */
}

function textFromInput(input: OutboundMessage['input']): string {
    // The port only ever drives text through the legacy adapter surface — a
    // structured (image/audio/video/resource) part is out of this port's
    // scope by construction: today's structured path goes through
    // `target.onEvent('send_message', {input})` on the *provider instance*,
    // which is a different, wider surface than `SessionInputTarget` declares
    // here (see REQUESTED EDITS — `deps.resolveSession` would need to expose
    // an `onEvent`-shaped hook for D2 to fully replace `chat-commands-write.ts`).
    // For now this port refuses a structured-only envelope explicitly rather
    // than silently dropping the non-text parts.
    return input.textFallback
}

function hasNonTextParts(input: OutboundMessage['input']): boolean {
    return input.parts.some((part) => part.type !== 'text')
}

/**
 * Build a `SessionInputPort` whose `submit()` drives today's inject path
 * through the narrow `deps` surface above. See the file header for exactly
 * which today-path entries each policy mode maps to.
 */
export function createLegacySessionInputPort(deps: SessionInputPortDeps): SessionInputPort {
    const now = deps.clock ?? Date.now
    const log = deps.log ?? noopLog

    /** messageId -> the outcome the FIRST submit produced, once settled. A
     *  message whose first submit is still in flight is represented by its
     *  pending promise in `inFlight` instead — see submit() below. */
    const settled = new Map<string, SubmitOutcome>()
    /** messageId -> the in-flight first submit's promise, so a concurrent
     *  resubmit with the same id awaits the SAME call rather than issuing a
     *  second PTY write. */
    const inFlight = new Map<string, Promise<SubmitOutcome>>()

    function rememberSettled(messageId: string, outcome: SubmitOutcome): void {
        if (settled.size >= DEDUPE_MAP_MAX_ENTRIES) {
            const oldestKey = settled.keys().next().value
            if (oldestKey !== undefined) settled.delete(oldestKey)
        }
        settled.set(messageId, outcome)
    }

    function refuse(reason: SendRefusal): SubmitOutcome {
        return { kind: 'refused', reason }
    }

    async function doSubmit(msg: OutboundMessage): Promise<SubmitOutcome> {
        if (hasNonTextParts(msg.input)) {
            // See textFromInput()'s note — structured sends are not yet
            // reachable through this port's narrow `SessionInputTarget`.
            log('warn', `submit(${msg.messageId}) refused unsupported_input — structured parts not yet supported by SessionInputPort`)
            return refuse('unsupported_input')
        }
        const text = textFromInput(msg.input)
        if (!text || !text.trim()) {
            log('warn', `submit(${msg.messageId}) refused unsupported_input — empty text`)
            return refuse('unsupported_input')
        }

        let target: SessionInputTarget | null | undefined
        try {
            target = await deps.resolveSession(msg.sessionId)
        } catch (e) {
            log('error', `submit(${msg.messageId}) resolveSession threw: ${(e as Error)?.message ?? e}`)
            return refuse('internal_error')
        }
        if (!target) {
            log('info', `submit(${msg.messageId}) refused no_target — session ${msg.sessionId} not found`)
            return refuse('no_target')
        }

        const status = (() => {
            try { return target?.getStatus?.()?.status } catch { return undefined }
        })()
        // One status vocabulary (A1): alias-normalize, then ask the shared class table.
        // `exited`/`crashed` are not in SESSION_STATUSES; they normalize to themselves and
        // are treated as dead here so a legacy adapter string still refuses correctly.
        const normalizedStatus = typeof status === 'string' ? normalizeSessionStatus(status) : undefined
        const legacyDead = status === 'exited' || status === 'crashed'
        if (normalizedStatus !== undefined && (isDeadStatus(normalizedStatus) || legacyDead)) {
            log('info', `submit(${msg.messageId}) refused session_exited — status=${status}`)
            return refuse('session_exited')
        }

        try {
            switch (msg.policy.mode) {
                case 'queue': {
                    const result = await target.sendMessage(text)
                    const queued = result && 'status' in result && result.status === 'queued'
                    stampAck(target, msg)
                    if (queued) {
                        log('info', `submit(${msg.messageId}) queued (session ${msg.sessionId})`)
                        return { kind: 'queued', position: 1 }
                    }
                    log('info', `submit(${msg.messageId}) delivered (session ${msg.sessionId})`)
                    return { kind: 'delivered' }
                }
                case 'send_now': {
                    if (typeof deps.sendNowIntoAgentQueue !== 'function') {
                        return refuse('not_supported')
                    }
                    const outcome = await deps.sendNowIntoAgentQueue(target, text)
                    if (!outcome.ok) {
                        log('info', `submit(${msg.messageId}) send_now refused ${outcome.reason} (session ${msg.sessionId})`)
                        return refuse(mapSendNowRefusal(outcome.reason))
                    }
                    stampAck(target, msg)
                    log('info', `submit(${msg.messageId}) send_now delivered (session ${msg.sessionId}, claimed=${outcome.claimed})`)
                    return { kind: 'delivered' }
                }
                case 'interrupt': {
                    if (typeof deps.interruptAndDeliver !== 'function') {
                        return refuse('not_supported')
                    }
                    const outcome = await deps.interruptAndDeliver(target, text)
                    if (!outcome.ok) {
                        log('info', `submit(${msg.messageId}) interrupt refused ${outcome.reason} (session ${msg.sessionId})`)
                        return refuse(mapInterruptRefusal(outcome.reason))
                    }
                    stampAck(target, msg)
                    if (outcome.queued) {
                        log('info', `submit(${msg.messageId}) interrupt re-queued (session ${msg.sessionId})`)
                        return { kind: 'queued', position: 1 }
                    }
                    log('info', `submit(${msg.messageId}) interrupt delivered (session ${msg.sessionId})`)
                    return { kind: 'delivered' }
                }
                default: {
                    // Exhaustiveness guard — SendPolicy is a closed union.
                    const _never: never = msg.policy
                    void _never
                    return refuse('not_supported')
                }
            }
        } catch (e) {
            log('error', `submit(${msg.messageId}) threw: ${(e as Error)?.message ?? e}`)
            return refuse('internal_error')
        }
    }

    /** (d) messageId threading — see REQUESTED EDITS. `recordAcknowledgedUserInput`
     *  does not yet accept a `sourceMessageId`, so today this only stamps the
     *  ack content; the messageId association the brief's §4 describes is not
     *  yet reachable through this signature. Best-effort + never throws. */
    function stampAck(target: SessionInputTarget, _msg: OutboundMessage): void {
        try {
            target.recordAcknowledgedUserInput?.(textFromInput(_msg.input))
        } catch {
            /* ack stamping must never fail a submit */
        }
    }

    return {
        async submit(msg: OutboundMessage): Promise<SubmitOutcome> {
            const already = settled.get(msg.messageId)
            if (already !== undefined) {
                return { kind: 'duplicate', of: msg.messageId }
            }
            const pending = inFlight.get(msg.messageId)
            if (pending) {
                await pending
                return { kind: 'duplicate', of: msg.messageId }
            }

            const runningAt = now()
            void runningAt // reserved for future latency logging; not yet consumed
            const promise = doSubmit(msg)
            inFlight.set(msg.messageId, promise)
            try {
                const outcome = await promise
                rememberSettled(msg.messageId, outcome)
                return outcome
            } finally {
                inFlight.delete(msg.messageId)
            }
        },
    }
}

/** Map `sendNowIntoAgentQueue`'s string reasons (`send-now-queued-write.ts`
 *  `describe()`) onto the closed `SendRefusal` vocabulary. */
function mapSendNowRefusal(reason: string): SendRefusal {
    switch (reason) {
        case 'platform_unsupported': return 'platform_unsupported'
        case 'not_supported': return 'not_supported'
        case 'not_generating': return 'not_generating'
        case 'send_in_flight': return 'send_in_flight'
        case 'not_ready': return 'not_ready'
        case 'duplicate': return 'duplicate_dispatch'
        default: return 'internal_error'
    }
}

/** Map `interruptAndDeliver`'s string reasons (`interrupt-and-deliver.ts`) onto
 *  the closed `SendRefusal` vocabulary. */
function mapInterruptRefusal(reason: string): SendRefusal {
    switch (reason) {
        case 'interrupt_not_implemented': return 'interrupt_not_implemented'
        case 'session_exited': return 'session_exited'
        case 'idle_timeout': return 'idle_timeout'
        case 'not_running': return 'session_exited'
        case 'not_busy': return 'not_generating'
        default: return 'interrupt_refused'
    }
}
