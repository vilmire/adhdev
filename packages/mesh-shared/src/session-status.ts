/**
 * session-status — the ONE session status vocabulary.
 *
 * Wiring-unification Phase A1 (docs/design/2026-09-23-wiring-unification.md).
 *
 * Before this file, the same eleven-member union was declared three times in
 * daemon-core (`SessionStatus`, `ManagedStatus`, and a stale `AgentStatus`) and
 * five independent "is it busy?" sets disagreed with each other — for example
 * `waiting_approval` counted as busy in three of them and idle in the other
 * two. Every consumer now derives from here:
 *
 *   - the canonical union `SessionStatus` and its member list `SESSION_STATUSES`;
 *   - a behavioural CLASS per status (`SESSION_STATUS_CLASS`) — the only thing
 *     send / dispatch / UI logic may branch on;
 *   - an alias table for the raw spellings providers and status lanes still
 *     emit (`running`, `streaming`, `no_progress`, …) so classification is total.
 *
 * This lives in mesh-shared (a dependency-free leaf) because web-core must not
 * value-import the daemon-core barrel, and the server has no daemon-core at all.
 */

export const SESSION_STATUSES = [
    'idle',
    'generating',
    'waiting_approval',
    'waiting_choice',
    'finalizing',
    'error',
    'stopped',
    'starting',
    'panel_hidden',
    'not_monitored',
    'disconnected',
] as const

export type SessionStatus = typeof SESSION_STATUSES[number]

export const RECENT_SESSION_BUCKETS = ['needs_attention', 'working', 'task_complete', 'idle'] as const

export type RecentSessionBucket = typeof RECENT_SESSION_BUCKETS[number]

/**
 * Behavioural class of a status.
 *
 *   working  — the agent owns the turn; input is queued, not delivered.
 *   blocked  — the agent is waiting on a human decision (approval / choice);
 *              alive, and the turn is not over.
 *   ready    — the agent will accept input now.
 *   dead     — the session will never accept input again.
 *   unknown  — the spelling is not one we classify (callers must fail safe).
 */
export type SessionStatusClass = 'working' | 'blocked' | 'ready' | 'dead' | 'unknown'

export const SESSION_STATUS_CLASS: Record<SessionStatus, Exclude<SessionStatusClass, 'unknown'>> = {
    generating: 'working',
    finalizing: 'working',
    starting: 'working',
    waiting_approval: 'blocked',
    waiting_choice: 'blocked',
    idle: 'ready',
    panel_hidden: 'ready',
    not_monitored: 'ready',
    error: 'dead',
    stopped: 'dead',
    disconnected: 'dead',
}

/**
 * Raw spellings that still reach status consumers from IDE/CDP providers, the
 * chat-tail status lane and legacy adapters, mapped onto the canonical member
 * that carries the same behavioural meaning. Keep this table exhaustive over
 * what the five pre-unification busy sets accepted; a spelling missing here
 * classifies as `unknown`, which every consumer must treat as "do not assume
 * idle".
 */
export const SESSION_STATUS_ALIASES: Readonly<Record<string, SessionStatus>> = {
    running: 'generating',
    streaming: 'generating',
    busy: 'generating',
    working: 'generating',
    loading: 'generating',
    loading_reference: 'generating',
    thinking: 'generating',
    active: 'generating',
    // Status-lane refinements of a turn that is still owned by the agent.
    no_progress: 'generating',
    long_generating: 'generating',
    initializing: 'starting',
    waiting: 'waiting_approval',
}

const SESSION_STATUS_SET: ReadonlySet<string> = new Set(SESSION_STATUSES)

export function isSessionStatus(value: unknown): value is SessionStatus {
    return typeof value === 'string' && SESSION_STATUS_SET.has(value)
}

/** Canonical member for a raw status spelling, or null when unrecognised. */
export function normalizeSessionStatus(raw: unknown): SessionStatus | null {
    if (typeof raw !== 'string') return null
    const value = raw.trim().toLowerCase()
    if (SESSION_STATUS_SET.has(value)) return value as SessionStatus
    return SESSION_STATUS_ALIASES[value] ?? null
}

export function classifySessionStatus(raw: unknown): SessionStatusClass {
    const status = normalizeSessionStatus(raw)
    return status ? SESSION_STATUS_CLASS[status] : 'unknown'
}

export function isWorkingStatus(raw: unknown): boolean {
    return classifySessionStatus(raw) === 'working'
}

export function isBlockedStatus(raw: unknown): boolean {
    return classifySessionStatus(raw) === 'blocked'
}

export function isReadyStatus(raw: unknown): boolean {
    return classifySessionStatus(raw) === 'ready'
}

export function isDeadStatus(raw: unknown): boolean {
    return classifySessionStatus(raw) === 'dead'
}

/**
 * "Busy" in the sense every pre-unification set meant: the agent cannot take a
 * new instruction right now, whether because it is working or because it is
 * blocked on a human. Dead sessions are NOT busy — they are gone, and callers
 * that need to distinguish must check `isDeadStatus` first.
 */
export function isBusyStatus(raw: unknown): boolean {
    const cls = classifySessionStatus(raw)
    return cls === 'working' || cls === 'blocked'
}

export function statusesOfClass(cls: Exclude<SessionStatusClass, 'unknown'>): SessionStatus[] {
    return SESSION_STATUSES.filter((status) => SESSION_STATUS_CLASS[status] === cls)
}
