/**
 * ws-protocol — shared string-literal unions for the daemon↔server WS surface
 * and the daemon↔dashboard P2P DataChannel surface.
 *
 * Fragmentation audit: these message types existed as a TypeScript union in
 * exactly ONE package (the proprietary daemon-cloud's server-connection.ts),
 * which is a leaf CONSUMER — the other two participants (the Workers server
 * and OSS daemon-core, which is the primary `status_report` producer) matched
 * bare string literals by hand. Renaming `auth_ok` server-side would compile
 * everywhere and leave the daemon reconnecting forever. Pure literals, zero
 * runtime deps — the textbook mesh-shared leaf.
 *
 * SCOPE HONESTY: this file declares the OSS-visible protocol surface. The
 * proprietary repo's server-connection.ts remains the authority for the full
 * ServerToDaemon command set; it should adopt these unions and extend them
 * (`ServerToDaemonMsg | <proprietary extras>`) rather than re-declaring the
 * shared members. Members here are the ones OSS daemon-core itself produces
 * or matches.
 */

/** Messages the daemon sends UP to the Workers server over the WS bridge. */
export type DaemonToServerWsMsg =
    | 'auth'
    | 'status_report'
    | 'status_heartbeat'
    | 'status_event'
    | 'command_result'
    | 'error'
    | 'agent_event'
    | 'log'
    /**
     * seqscribe Beacon vectors (design §7.1). ONE daemon-initiated frame carries
     * both directions — `op: 'put'` stores this node's content-free vector
     * report, `op: 'get'` asks for the board — because the server has no way to
     * wake itself: `DaemonConnectionDO` has neither an alarm nor a timer, and
     * adding one would hit the most request-quota-pressured axis in the system.
     */
    | 'beacon_vectors';

/** Server→daemon control messages the OSS engine reacts to. */
export type ServerToDaemonWsMsg =
    | 'auth_ok'
    | 'auth_error'
    | 'machine_evicted'
    | 'force_disconnect'
    | 'token_revoked'
    | 'version_mismatch'
    | 'force_update_required'
    | 'command'
    | 'agent_command'
    | 'resolve_action'
    /**
     * Reply to a `beacon_vectors` GET, correlated by `requestId`. A PUT is
     * fire-and-forget and gets no reply at all — the beacon is advisory, so a
     * lost report costs one debounce cycle of prediction accuracy and nothing
     * else, which is not worth an ack round trip.
     */
    | 'beacon_vectors_result';

/** P2P signaling relayed through the server WS. */
export type P2PSignalingWsMsg =
    | 'p2p_ready'
    | 'offer'
    | 'answer'
    | 'ice'
    | 'mesh_p2p_ready'
    | 'mesh_p2p_offer'
    | 'mesh_p2p_answer'
    | 'mesh_p2p_ice';

/**
 * Dashboard↔daemon P2P DataChannel JSON message kinds. Previously matched as
 * hand-synced literals on both ends with NO shared symbol anywhere —
 * `p2p_evicted` had exactly two occurrences repo-wide (emit + handle).
 */
export type DashboardP2PMessageKind =
    | 'ping'
    | 'pong'
    | 'status_report'
    | 'status_event'
    | 'p2p_evicted'
    | 'command'
    | 'command_result'
    | 'command_result_chunk'
    | 'screenshot_start'
    | 'screenshot_stop'
    | 'pty_input'
    | 'pty_resize';

export const DAEMON_TO_SERVER_WS_MSGS: readonly DaemonToServerWsMsg[] = [
    'auth', 'status_report', 'status_heartbeat', 'status_event', 'command_result', 'error', 'agent_event', 'log',
    'beacon_vectors',
];

export const SERVER_TO_DAEMON_WS_MSGS: readonly ServerToDaemonWsMsg[] = [
    'auth_ok', 'auth_error', 'machine_evicted', 'force_disconnect', 'token_revoked',
    'version_mismatch', 'force_update_required', 'command', 'agent_command', 'resolve_action',
    'beacon_vectors_result',
];

export function isDaemonToServerWsMsg(value: unknown): value is DaemonToServerWsMsg {
    return typeof value === 'string' && (DAEMON_TO_SERVER_WS_MSGS as readonly string[]).includes(value);
}

export function isServerToDaemonWsMsg(value: unknown): value is ServerToDaemonWsMsg {
    return typeof value === 'string' && (SERVER_TO_DAEMON_WS_MSGS as readonly string[]).includes(value);
}

/**
 * `auth_ok.payload.limits` — the plan-limit contract the server sends DOWN to
 * the daemon for client-side enforcement.
 *
 * WHY THIS EXISTS: the wire spelling is `maxP2Pconnections` (lowercase `c`),
 * inherited from `PlanLimits` in the proprietary server's plan-limits.ts. The
 * daemon-cloud consumer independently declared the same field as
 * `maxP2PConnections` (capital `C`) and assigned it from a `payload as any`
 * cast — so the two spellings NEVER met under a type, TypeScript had nothing
 * to compare, and the limit arrived as `undefined` at every comparison site.
 * `undefined !== -1` passes the "is it unlimited?" guard, then every
 * `count >= undefined` is false: enforcement silently degraded to unlimited on
 * all plans, in production, for months.
 *
 * The lesson is NOT "pick a spelling" — it is that a cross-package wire
 * contract asserted by hand on both ends with an `any` in between cannot fail
 * loudly. Both producer (server) and consumer (daemon-cloud) must now import
 * THIS symbol, so a rename breaks the build on both sides instead of silently
 * disabling a paid-plan limit. Use `normalizeAuthOkLimits()` at the parse
 * boundary; never re-spell these fields locally.
 */
export interface AuthOkPlanLimits {
    /** P2P concurrent connection count (-1 = unlimited). WIRE SPELLING — lowercase `c`. */
    maxP2Pconnections: number;
    /** Screenshot send interval floor (seconds). 0 = real-time. */
    screenshotIntervalSeconds: number;
    /** Daily screenshot usage budget (minutes). -1 = unlimited. */
    dailyScreenshotMinutes: number;
    /** Max connectable machines/daemons (-1 = unlimited). */
    maxMachines: number;
}

/**
 * Parse-boundary normalizer for `auth_ok.payload.limits`.
 *
 * Returns `null` when the payload carries no usable limits object, so callers
 * keep their existing "no limits known yet" branch. Individual non-numeric or
 * missing fields fall back to the UNLIMITED sentinel (-1) for count-style
 * limits and 0 for the interval floor, matching how each consumer already
 * treats "no constraint" — a malformed field must never be coerced to a
 * MORE restrictive value than the server intended, or a server-side schema
 * change would start throttling paying users.
 *
 * Accepts the capital-`C` misspelling as an input alias ONLY so a daemon
 * talking to a mixed-version fleet cannot regress; output is always the
 * canonical wire spelling.
 */
export function normalizeAuthOkLimits(raw: unknown): AuthOkPlanLimits | null {
    if (!raw || typeof raw !== 'object') return null;
    const src = raw as Record<string, unknown>;
    const num = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return {
        maxP2Pconnections: num(
            src.maxP2Pconnections !== undefined ? src.maxP2Pconnections : src.maxP2PConnections,
            -1,
        ),
        screenshotIntervalSeconds: num(src.screenshotIntervalSeconds, 0),
        dailyScreenshotMinutes: num(src.dailyScreenshotMinutes, -1),
        maxMachines: num(src.maxMachines, -1),
    };
}
