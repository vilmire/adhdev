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
