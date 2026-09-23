/**
 * outbound-message — the one send-side unit crossing every transport.
 *
 * Wiring-unification Phase D (docs/design/2026-09-23-wiring-unification.md §6,
 * D1) / workstream D-web. Full type derivation in the scratchpad
 * `phase-D-plan.md` §1.1-§1.2 (`OutboundMessage`/`SendPolicy`/`SubmitOutcome`/
 * `SendRefusal`). `SendRefusal` is imported from here by Phase C1's
 * `turn-evidence.ts` (`RECLAIMING_SEND_REFUSALS`) — this file owns the type,
 * C1 owns which of its members reclaim a mesh dispatch attempt.
 *
 * Before this type, a chat send was represented by twelve different loose
 * request shapes (`{message, sendNow?, interrupt?}`, `{message, input}`,
 * mesh `agent_command` args, MCP tool args, ...) and parked messages had no
 * identity at all — the driver queue was keyed by exact text, so send-now,
 * cancel, interrupt and the web echo-retirement all recovered identity by
 * string matching. `OutboundMessage.messageId` is minted once, at the
 * ORIGIN, and is the identity every layer keys on afterwards: the wire
 * field in the `send_chat` command payload, the driver's queue key (daemon
 * side, Phase D-daemon), the web pending-store key (`pendingQueuedMessages.ts`)
 * and the echo-retirement key (`conversation-message-snapshot.ts`).
 *
 * This file is dependency-free by construction (mesh-shared leaf rule):
 * `InputEnvelopeWire`/`InputPartWire` are STRUCTURAL MIRRORS of daemon-core's
 * `InputEnvelope`/`InputPart` (`oss/packages/daemon-core/src/providers/
 * io-contracts.ts`), not re-exports — daemon-core assigns its richer type
 * into this one, never the other way round, so this package's published
 * `.d.ts` never references a package that depends on it.
 */

// ─── Input envelope (structural mirror of daemon-core's InputEnvelope) ─────

export interface ContentAnnotationsWire {
    audience?: ('user' | 'assistant')[]
    priority?: number
}

export interface TextInputPartWire {
    type: 'text'
    text: string
}

export interface ImageInputPartWire {
    type: 'image'
    mimeType: string
    uri?: string
    data?: string
    alt?: string
}

export interface AudioInputPartWire {
    type: 'audio'
    mimeType: string
    uri?: string
    data?: string
    transcript?: string
}

export interface VideoInputPartWire {
    type: 'video'
    mimeType: string
    uri?: string
    data?: string
    transcript?: string
    posterUri?: string
}

export interface ResourceInputPartWire {
    type: 'resource'
    uri: string
    mimeType?: string
    name?: string
    text?: string
    data?: string
}

export interface ResourceLinkInputPartWire {
    type: 'resource_link'
    uri: string
    name: string
    title?: string
    description?: string
    mimeType?: string
    size?: number
    annotations?: ContentAnnotationsWire
}

export type InputPartWire =
    | TextInputPartWire
    | ImageInputPartWire
    | AudioInputPartWire
    | VideoInputPartWire
    | ResourceLinkInputPartWire
    | ResourceInputPartWire

export interface InputEnvelopeWire {
    parts: InputPartWire[]
    textFallback: string
    metadata?: {
        source?: 'dashboard' | 'shortcut_api' | 'provider_script' | 'session_replay'
        clientTimestamp?: number
    }
}

// ─── OutboundMessage ────────────────────────────────────────────────────────

/**
 * Who minted this `OutboundMessage`. Determines default policy and refusal
 * surface — 'mesh' origins get the mesh-specific `SendRefusal` reasons,
 * interactive origins get the interactive ones.
 *
 * `'api'`/`'cli'` are carried per the design doc's D1 type even though no
 * current call site produces them distinct from `'dashboard'`/`'mcp'`/
 * `'mesh'` (flagged as an open question in phase-D-plan.md §7.3 risk 5) —
 * kept here unchanged pending an owner decision; dropping a union member is
 * a decision for whoever lands D-daemon/D2, not this workstream.
 */
export type OutboundMessageOrigin = 'dashboard' | 'mcp' | 'mesh' | 'api' | 'cli'

/**
 * How this message should be admitted when the session is not idle.
 * Replaces the loose `sendNow`/`interrupt`/`force`/`forceSend` booleans (and
 * mesh `delivery_mode`) with one closed union. `'queue'` is the default for
 * every origin.
 */
export type SendPolicy =
    | { mode: 'queue' }
    | { mode: 'send_now' }
    | { mode: 'interrupt' }

/**
 * Every reason `submit()` can refuse a message, closed so callers branch on it
 * instead of matching free text.
 *
 * ★ This is THE `SendRefusal` (docs/design/2026-09-23-wiring-unification.md
 * §6 D1) — Phase C1's `turn-evidence.ts` imports `SendRefusal`/
 * `SEND_REFUSAL_REASONS` from this file (`RECLAIMING_SEND_REFUSALS`, the
 * subset that means a mesh dispatch attempt must be reclaimed rather than
 * retried) rather than declaring its own copy. Do not fork this vocabulary —
 * a member renamed or removed here must be re-checked against
 * `RECLAIMING_SEND_REFUSALS`'s three members (`session_exited`, `no_target`,
 * `unsupported_input`), which `satisfies readonly SendRefusal[]` there keeps
 * honest at compile time.
 */
export type SendRefusal =
    | 'not_ready'
    | 'send_in_flight'
    | 'not_generating'
    | 'not_supported'
    | 'platform_unsupported'
    | 'modal_parked'
    | 'interrupt_not_implemented'
    | 'interrupt_refused'
    | 'idle_timeout'
    | 'session_exited'
    | 'unsupported_input'
    | 'no_target'
    | 'bootstrap_pending'
    | 'duplicate_dispatch'
    | 'internal_error'

/** The one closed outcome shape every caller receives from `submit()`. */
export type SubmitOutcome =
    | { kind: 'delivered' }
    | { kind: 'queued'; position: number }
    | { kind: 'duplicate'; of: string /* messageId */ }
    | { kind: 'refused'; reason: SendRefusal }

/**
 * The one send-side unit crossing every transport. `messageId` is minted at
 * the ORIGIN (never by the daemon) — this is what makes cross-transport
 * dedupe and identity-based claim/cancel/send-now possible.
 */
export interface OutboundMessage {
    messageId: string
    sessionId: string
    input: InputEnvelopeWire
    origin: OutboundMessageOrigin
    policy: SendPolicy
    createdAt: number
    /**
     * Present only for a mesh-dispatched message; lets the turn ledger
     * (Phase C) bind the send to the attempt without the sender needing to
     * know what an "attempt" is. Optional and inert until C lands.
     */
    meshAttemptRef?: string
}

// ─── Identity ───────────────────────────────────────────────────────────────

/**
 * Mint a new `messageId`. `crypto.randomUUID` where available (browser and
 * modern Node); a counter fallback otherwise, since the only requirement is
 * uniqueness within one process/tab, not cryptographic strength.
 */
let outboundMessageIdCounter = 0
export function mintMessageId(now: number = Date.now()): string {
    try {
        // `globalThis.crypto` is not in the ES2022 lib (mesh-shared is DOM-free), so read it structurally.
        const cryptoRef = (typeof globalThis !== 'undefined'
            ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
            : undefined)
        if (typeof cryptoRef?.randomUUID === 'function') return `msg_${cryptoRef.randomUUID()}`
    } catch {
        /* fall through to the counter fallback */
    }
    outboundMessageIdCounter += 1
    return `msg_${now}_${outboundMessageIdCounter}`
}

/** `messageId`s minted by this module always carry this prefix; used by the guard below. */
const MESSAGE_ID_PREFIX = 'msg_'

export function isMessageId(value: unknown): value is string {
    return typeof value === 'string' && value.length > MESSAGE_ID_PREFIX.length && value.startsWith(MESSAGE_ID_PREFIX)
}

// ─── Guards ─────────────────────────────────────────────────────────────────

export const OUTBOUND_MESSAGE_ORIGINS = ['dashboard', 'mcp', 'mesh', 'api', 'cli'] as const satisfies readonly OutboundMessageOrigin[]

export function isOutboundMessageOrigin(value: unknown): value is OutboundMessageOrigin {
    return typeof value === 'string' && (OUTBOUND_MESSAGE_ORIGINS as readonly string[]).includes(value)
}

export const SEND_POLICY_MODES = ['queue', 'send_now', 'interrupt'] as const satisfies readonly SendPolicy['mode'][]

export function isSendPolicyMode(value: unknown): value is SendPolicy['mode'] {
    return typeof value === 'string' && (SEND_POLICY_MODES as readonly string[]).includes(value)
}

export function isSendPolicy(value: unknown): value is SendPolicy {
    return !!value && typeof value === 'object' && isSendPolicyMode((value as { mode?: unknown }).mode)
}

export const SEND_REFUSAL_REASONS = [
    'not_ready',
    'send_in_flight',
    'not_generating',
    'not_supported',
    'platform_unsupported',
    'modal_parked',
    'interrupt_not_implemented',
    'interrupt_refused',
    'idle_timeout',
    'session_exited',
    'unsupported_input',
    'no_target',
    'bootstrap_pending',
    'duplicate_dispatch',
    'internal_error',
] as const satisfies readonly SendRefusal[]

export function isSendRefusal(value: unknown): value is SendRefusal {
    return typeof value === 'string' && (SEND_REFUSAL_REASONS as readonly string[]).includes(value)
}

const SUBMIT_OUTCOME_KINDS = ['delivered', 'queued', 'duplicate', 'refused'] as const

export function isSubmitOutcome(value: unknown): value is SubmitOutcome {
    if (!value || typeof value !== 'object') return false
    const kind = (value as { kind?: unknown }).kind
    if (typeof kind !== 'string' || !(SUBMIT_OUTCOME_KINDS as readonly string[]).includes(kind)) return false
    if (kind === 'queued') return typeof (value as { position?: unknown }).position === 'number'
    if (kind === 'duplicate') return typeof (value as { of?: unknown }).of === 'string'
    if (kind === 'refused') return isSendRefusal((value as { reason?: unknown }).reason)
    return true
}

function isInputPartWire(value: unknown): value is InputPartWire {
    if (!value || typeof value !== 'object') return false
    const type = (value as { type?: unknown }).type
    return type === 'text' || type === 'image' || type === 'audio' || type === 'video' || type === 'resource' || type === 'resource_link'
}

export function isInputEnvelopeWire(value: unknown): value is InputEnvelopeWire {
    if (!value || typeof value !== 'object') return false
    const parts = (value as { parts?: unknown }).parts
    const textFallback = (value as { textFallback?: unknown }).textFallback
    return Array.isArray(parts) && parts.every(isInputPartWire) && typeof textFallback === 'string'
}

/** Minimal structural check for the wire boundary — not a full decoder (mesh-shared stays a pure leaf; semantic validation stays with the handler that owns it). */
export function isOutboundMessage(value: unknown): value is OutboundMessage {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Partial<OutboundMessage>
    return isMessageId(candidate.messageId)
        && typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0
        && isInputEnvelopeWire(candidate.input)
        && isOutboundMessageOrigin(candidate.origin)
        && isSendPolicy(candidate.policy)
        && typeof candidate.createdAt === 'number'
}
