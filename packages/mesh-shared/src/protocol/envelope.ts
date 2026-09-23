/**
 * protocol/envelope — helpers shared by the three link protocols.
 *
 * Wiring-unification Phase A2 (docs/design/2026-09-23-wiring-unification.md).
 *
 * Every link (daemon↔server WS, dashboard↔UserSession WS, dashboard↔daemon
 * P2P DataChannel) is described the same way:
 *
 *   - a `const` tuple of message-kind names per direction;
 *   - a discriminated union of `{ type, ... }` frames derived from it;
 *   - a `decode<Link><Direction>(raw)` parse-boundary function that checks the
 *     `type` is a member and the frame carries the MINIMAL shape the union
 *     promises (an object payload where one is required, the top-level fields
 *     a payload-less frame is keyed by). Semantic validation — is this session
 *     id known, is the SDP well formed — stays with the handler that owns it.
 *
 * mesh-shared is a dependency-free leaf, so payload types here are STRUCTURAL
 * mirrors of the richer daemon-core types (`RoutingSessionEntry`,
 * `DaemonStatusEventPayload`, ...): daemon-core, the server and the web assign
 * their richer types into these, never the other way round. A type-only import
 * of daemon-core would make the published `.d.ts` of this package reference a
 * package that depends on it — a cycle a leaf must not create.
 */

export type MessageId = string

/** `{ type, payload }` frame with the optional correlation/ordering fields every link uses. */
export type Envelope<T extends string, P> = {
    type: T
    payload: P
    id?: MessageId
    timestamp?: number
}

/** Genuinely dynamic payloads (command arguments and results). Allowed by design; the union stays exhaustive on `type`. */
export type CommandPayload = Record<string, unknown>

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
}

export function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

export function makeTypeGuard<T extends readonly string[]>(names: T): (value: unknown) => value is T[number] {
    const set: ReadonlySet<string> = new Set(names)
    return (value: unknown): value is T[number] => typeof value === 'string' && set.has(value)
}

/**
 * Compile-time proof that a name tuple and a union have exactly the same
 * members. Used as `const _: AssertSameMembers<typeof NAMES, Union> = true`.
 */
export type AssertSameMembers<Tuple extends readonly string[], Union extends string> =
    [Exclude<Union, Tuple[number]>, Exclude<Tuple[number], Union>] extends [never, never] ? true : never

/** Narrow a frame's `type` to a union member, or null. */
export function decodeTypeField<T extends string>(raw: unknown, isType: (value: unknown) => value is T): { type: T; frame: Record<string, unknown> } | null {
    if (!isRecord(raw)) return null
    if (!isType(raw.type)) return null
    return { type: raw.type, frame: raw }
}

/** Read the optional envelope fields a frame may carry, dropping malformed ones. */
export function readEnvelopeFields(frame: Record<string, unknown>): { id?: MessageId; timestamp?: number } {
    return {
        ...(isNonEmptyString(frame.id) ? { id: frame.id } : {}),
        ...(isFiniteNumber(frame.timestamp) ? { timestamp: frame.timestamp } : {}),
    }
}
