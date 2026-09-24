/**
 * HTTP `upgrade` routing for the standalone server's two WebSocket legs.
 *
 *   /ws            — the JSON dashboard lane (status, commands, topic_update).
 *   /ws/seqscribe  — the transcript replica lane (raw seqscribe frames), served
 *                    by daemon-core's `StandaloneTranscriptLane`
 *                    (wiring-unification G6 prerequisite).
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
 */
import type { IncomingMessage } from 'http';

/** The JSON dashboard lane. The replica lane's path comes from daemon-core (`STANDALONE_SEQSCRIBE_WS_PATH`). */
export const STANDALONE_DASHBOARD_WS_PATH = '/ws';

/** Kill switch: `ADHDEV_STANDALONE_TRANSCRIPT_LANE=off` refuses the replica lane (dashboard stays on legacy chat-tail). */
export const STANDALONE_TRANSCRIPT_LANE_ENV = 'ADHDEV_STANDALONE_TRANSCRIPT_LANE';

export function isStandaloneTranscriptLaneDisabled(env: NodeJS.ProcessEnv): boolean {
  return env[STANDALONE_TRANSCRIPT_LANE_ENV]?.trim().toLowerCase() === 'off';
}

export interface StandaloneUpgradeGate {
  isAllowedOrigin(req: IncomingMessage): boolean;
  isRequestAuthenticated(req: IncomingMessage, rawUrl: string): boolean;
}

export interface StandaloneUpgradeRouteOptions {
  /** The replica lane's path (daemon-core `STANDALONE_SEQSCRIBE_WS_PATH`). */
  readonly seqscribePath: string;
  /** False when the node failed to open or the lane is switched off. */
  readonly seqscribeLaneAvailable: boolean;
}

export type StandaloneUpgradeRoute =
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'seqscribe' }
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
