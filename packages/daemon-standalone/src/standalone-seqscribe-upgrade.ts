/**
 * HTTP `upgrade` routing for the standalone server's WebSocket legs.
 *
 *   /ws            — the JSON dashboard lane (status, commands, topic_update).
 *   /ws/seqscribe  — the transcript replica lane (raw seqscribe frames), served
 *                    by daemon-core's `StandaloneTranscriptLane`
 *                    (wiring-unification G6 prerequisite).
 *   /ws/mesh, /ws/mesh-seqscribe
 *                  — daemon⇄daemon mesh links (design 2026-10-07 §4.3): the
 *                    mesh RPC lane and the mesh seqscribe replication lane,
 *                    dialed by OTHER standalone daemons paired with this one.
 *
 * ── Why a separate upgrade path, not a multiplexed frame on /ws ────────────
 * seqscribe's `webSocketChannel(ws)` consumes a socket whole: every frame on it
 * is a seqscribe frame. A dedicated path lets a real `ws` socket be that
 * channel with zero adapter code and keeps seqscribe's frames from ever sharing
 * a lane with the `{type:...}` JSON envelope — the same "separate channel"
 * shape as the cloud's dedicated `seqscribe` RTCDataChannel label.
 *
 * ── Auth ───────────────────────────────────────────────────────────────────
 * BOTH paths run the SAME gate, in the same order, before `handleUpgrade`:
 * Origin allow-list (403), then the standalone token/password check (401) —
 * `StandaloneHttpApi.isAllowedOrigin` / `isRequestAuthenticated`, i.e. the
 * `--token` / `ADHDEV_TOKEN` query token, bearer header, or password-session
 * cookie. The replica lane can therefore never be reachable by anything that
 * could not already open `/ws`.
 *
 * ── Mesh lanes: a different gate, on purpose ─────────────────────────────────
 * The two mesh paths do NOT run the dashboard Origin/token gate. Their clients
 * are peer daemons, not browsers: they send no Origin a dashboard allow-list
 * would recognise and hold no dashboard token (a member must not need the
 * host's dashboard password to replicate). Their gate is the §4.4 mutual HMAC
 * handshake over the per-member pairing secret, run on the upgraded socket
 * BEFORE any RPC or seqscribe frame is accepted (`StandaloneMeshLink`). What
 * this router adds in front of it: a mesh path answers 503 — without
 * upgrading — when this daemon holds no pairing secret a dialer could prove
 * (or the lane's runtime is down), so an unpaired daemon exposes no
 * handshake surface at all.
 */
import type { IncomingMessage } from 'http';

/** The JSON dashboard lane. The replica lane's path comes from daemon-core (`STANDALONE_SEQSCRIBE_WS_PATH`). */
export const STANDALONE_DASHBOARD_WS_PATH = '/ws';

export interface StandaloneUpgradeGate {
  isAllowedOrigin(req: IncomingMessage): boolean;
  isRequestAuthenticated(req: IncomingMessage, rawUrl: string): boolean;
}

/** Which daemon⇄daemon mesh lane an upgrade targets. */
export type StandaloneMeshUpgradeLane = 'rpc' | 'seqscribe';

export interface StandaloneMeshUpgradeOptions {
  /** The mesh RPC lane's path (daemon-core `WS_MESH_RPC_PATH`). */
  readonly rpcPath: string;
  /** The mesh replication lane's path (daemon-core `STANDALONE_MESH_SEQSCRIBE_WS_PATH`). */
  readonly seqscribePath: string;
  /**
   * Whether the lane can take a peer right now: a pairing secret exists that a
   * dialer could prove, and the lane's runtime is up. Evaluated only for an
   * upgrade on that lane's path.
   */
  isAvailable(lane: StandaloneMeshUpgradeLane): boolean;
}

export interface StandaloneUpgradeRouteOptions {
  /** The replica lane's path (daemon-core `STANDALONE_SEQSCRIBE_WS_PATH`). */
  readonly seqscribePath: string;
  /** False when the node failed to open or the lane is switched off. */
  readonly seqscribeLaneAvailable: boolean;
  /** The daemon⇄daemon mesh lanes. Absent ⇒ the mesh paths are not served (ignored like any unknown path). */
  readonly mesh?: StandaloneMeshUpgradeOptions;
}

export type StandaloneUpgradeRoute =
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'seqscribe' }
  /** A peer daemon's mesh lane — the handshake, not the dashboard gate, admits it. */
  | { readonly kind: 'mesh'; readonly lane: StandaloneMeshUpgradeLane }
  /** A known path refused with an HTTP status line. */
  | { readonly kind: 'reject'; readonly status: 401 | 403 | 503 }
  /** Not one of ours — destroy the socket without a response (pre-existing behavior). */
  | { readonly kind: 'ignore' };

export function routeStandaloneUpgrade(
  req: IncomingMessage,
  gate: StandaloneUpgradeGate,
  options: StandaloneUpgradeRouteOptions,
): StandaloneUpgradeRoute {
  const rawUrl = req.url || '/';
  const pathname = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`).pathname;
  const mesh = options.mesh;
  if (mesh && (pathname === mesh.rpcPath || pathname === mesh.seqscribePath)) {
    // Daemon peers: no Origin / dashboard-token gate (see the header). The
    // handshake on the upgraded socket is the only door; 503 when there is
    // nothing a dialer could prove.
    const lane: StandaloneMeshUpgradeLane = pathname === mesh.rpcPath ? 'rpc' : 'seqscribe';
    return mesh.isAvailable(lane) ? { kind: 'mesh', lane } : { kind: 'reject', status: 503 };
  }
  const kind = pathname === STANDALONE_DASHBOARD_WS_PATH
    ? 'dashboard'
    : pathname === options.seqscribePath
      ? 'seqscribe'
      : null;
  if (kind === null) return { kind: 'ignore' };
  // Validate Origin before upgrade (same gate as the HTTP CORS check):
  // without it any page could open a WS to this daemon.
  if (!gate.isAllowedOrigin(req)) return { kind: 'reject', status: 403 };
  if (!gate.isRequestAuthenticated(req, rawUrl)) return { kind: 'reject', status: 401 };
  if (kind === 'seqscribe' && !options.seqscribeLaneAvailable) return { kind: 'reject', status: 503 };
  return { kind };
}

const STATUS_TEXT: Record<401 | 403 | 503, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  503: 'Service Unavailable',
};

/** Write a bare status line and drop the socket (pre-upgrade refusal). */
export function rejectStandaloneUpgrade(
  socket: { write(chunk: string): unknown; destroy(): unknown },
  status: 401 | 403 | 503,
): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n\r\n`);
  } catch {
    // peer already gone
  }
  socket.destroy();
}
