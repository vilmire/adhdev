/**
 * ws-protocol — name-only aliases for the daemon↔server WS surface and the
 * daemon↔dashboard P2P DataChannel surface, plus the `auth_ok.payload.limits`
 * contract.
 *
 * Wiring-unification Phase A2: the typed frame unions now live in ./protocol
 * (one file per link, payloads included). This file keeps the symbols that
 * pre-dated them — `DaemonToServerWsMsg`, `ServerToDaemonWsMsg`,
 * `P2PSignalingWsMsg`, `DashboardP2PMessageKind` and the two name arrays —
 * DERIVED from the protocol unions rather than re-declared, so they cannot
 * drift again. Before this derivation the list here said `offer|answer|ice`
 * while the wire said `p2p_offer|p2p_answer|p2p_ice`, declared a `log` frame
 * nothing sent or handled, omitted `daemon_mesh_command` (sent by a raw
 * `ws.send`), and listed 12 of the ~27 P2P kinds — and nothing imported the
 * drifted members, so nothing noticed.
 */

import {
    DAEMON_TO_SERVER_TYPES,
    SERVER_TO_DAEMON_CONTROL_TYPES,
    isDaemonToServerType,
    isServerToDaemonControlType,
    type DaemonToServerType,
    type ServerToDaemonControlType,
    type P2PSignalType,
    type MeshP2PSignalType,
    type DashboardToDaemonP2PType,
    type DaemonToDashboardP2PType,
} from './protocol';

/** Messages the daemon sends UP to the Workers server over the WS bridge (see protocol/daemon-server.ts). */
export type DaemonToServerWsMsg = DaemonToServerType;

/**
 * Server→daemon CONTROL messages (see protocol/daemon-server.ts). The server
 * additionally relays an open command namespace as the frame `type`
 * (`ServerDirectCommandMsg`), which is deliberately not a member here.
 */
export type ServerToDaemonWsMsg = ServerToDaemonControlType;

/** P2P signaling relayed through the server WS — the `p2p_`/`mesh_p2p_` spellings the wire actually uses. */
export type P2PSignalingWsMsg = P2PSignalType | MeshP2PSignalType;

/** Every dashboard↔daemon P2P DataChannel JSON kind, both directions (see protocol/dashboard-daemon-p2p.ts). */
export type DashboardP2PMessageKind = DashboardToDaemonP2PType | DaemonToDashboardP2PType;

export const DAEMON_TO_SERVER_WS_MSGS: readonly DaemonToServerWsMsg[] = DAEMON_TO_SERVER_TYPES;

export const SERVER_TO_DAEMON_WS_MSGS: readonly ServerToDaemonWsMsg[] = SERVER_TO_DAEMON_CONTROL_TYPES;

export const isDaemonToServerWsMsg: (value: unknown) => value is DaemonToServerWsMsg = isDaemonToServerType;

export const isServerToDaemonWsMsg: (value: unknown) => value is ServerToDaemonWsMsg = isServerToDaemonControlType;

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
