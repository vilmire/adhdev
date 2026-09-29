/**
 * The standalone half of the host runtime (wiring-unification B5): the
 * `DaemonHostTransport` over the dashboard WS. Everything else — topic
 * registry, snapshot / metadata builders, the command entry, and every bus
 * subscriber that replaced index.ts's old onStatusChange lambdas — is
 * daemon-core's `createDaemonHostRuntime`.
 *
 * New standalone behaviour this transport carries (D8):
 *  - `status_event` frames (tool approval / completion toasts) — the same
 *    allow-listed projection cloud sends over P2P (status/status-event.ts);
 *  - a daemon.metadata flush on `mesh_state`.
 *
 * Dashboard state reaches the page on ONE lane: the keyed `daemon.metadata`
 * topic (snapshot, then deltas). The old `type:'status'` full-snapshot push is
 * gone (data-path audit 2026-09-29 P0-3); a connecting client gets only a
 * `standalone_hello` identity frame. Terminal bytes go only to clients that
 * subscribed `session.runtime_output` for that session (P1-10).
 */

import { WebSocket } from 'ws';
import {
  DASHBOARD_WIRE_VERSION,
  LOG,
  loadConfig,
  readCachedInlineMeshActiveSessionDetails,
  type DaemonHostTransport,
  type DaemonRuntime,
  type SessionHostController,
  type SessionHostDiagnosticsSnapshot,
} from '@adhdev/daemon-core';

/** Send one JSON frame to every OPEN dashboard socket. */
export function broadcastToOpenClients(clients: Iterable<WebSocket>, message: unknown): void {
  let raw: string | null = null;
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    raw ??= JSON.stringify(message);
    client.send(raw);
  }
}

/**
 * Identity frame sent on connect: which daemon this socket talks to and the
 * dashboard wire version it speaks (mesh-shared DASHBOARD_WIRE_VERSION) — no state.
 */
export const STANDALONE_HELLO_TYPE = 'standalone_hello';
export function standaloneHelloFrame(daemonId: string): { type: typeof STANDALONE_HELLO_TYPE; daemonId: string; wireVersion: number } {
  return { type: STANDALONE_HELLO_TYPE, daemonId, wireVersion: DASHBOARD_WIRE_VERSION };
}

export interface StandaloneHostTransportDeps {
  statusInstanceId: string;
  version: string;
  clients: Set<WebSocket>;
  wsByConnectionId: Map<string, WebSocket>;
  getRuntime(): DaemonRuntime | null;
  getSessionHostControl(): Pick<SessionHostController, 'getDiagnostics'> | null;
  /** OPEN-or-not clients subscribed to a session's `session.runtime_output`. */
  runtimeOutputTargets(sessionId: string): Iterable<WebSocket>;
  /** Flush one registry topic now (no-op without subscribers). */
  flushTopic(topic: 'daemon.metadata'): void;
}

export function createStandaloneHostTransport(deps: StandaloneHostTransportDeps): DaemonHostTransport {
  return {
    kind: 'standalone',
    instanceId: () => deps.statusInstanceId,
    version: deps.version,
    topicSink: {
      send: (connectionId, _topic, update) => {
        const ws = deps.wsByConnectionId.get(connectionId);
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify({ type: 'topic_update', update }));
        return true;
      },
      isDeliverable: (connectionId) => {
        const ws = deps.wsByConnectionId.get(connectionId);
        return !!ws && ws.readyState === WebSocket.OPEN;
      },
      isAlive: (connectionId) => deps.wsByConnectionId.has(connectionId),
    },
    onFlushError: (topic, error, ctx) => {
      LOG.warn('Standalone', `[${topic}] skipped workspace=${ctx.detail || ''} key=${ctx.key} error=${(error as any)?.message || error}`);
    },
    sessionHostDiagnostics: (opts) => {
      const control = deps.getSessionHostControl();
      return control ? control.getDiagnostics(opts) as Promise<SessionHostDiagnosticsSnapshot> : null;
    },
    broadcastSessionOutput: (sessionId, data) => {
      broadcastToOpenClients(deps.runtimeOutputTargets(sessionId), { type: 'session_output', sessionId, data });
    },
    // Checklist item 3: tool-approval / completion toasts reach the
    // standalone dashboard as `status_event`, same projection as cloud's
    // P2P copy (status/status-event.ts allow-list). No server leg.
    sendStatusEvent: (payload) => {
      broadcastToOpenClients(deps.clients, { type: 'status_event', payload, timestamp: Date.now() });
    },
    onCommandExecuted: (e) => {
      // A fast-flush command (launch, interactive prompt answer) pushes
      // daemon.metadata now — the runtime's invalidation skips it for those.
      if (e.fastFlush && e.success) deps.flushTopic('daemon.metadata');
    },
    metadataExtras: (status, params) => {
      const runtime = deps.getRuntime();
      if (params?.includeSessions === true && runtime) {
        for (const node of runtime.components.router.getCachedInlineMeshNodes()) {
          for (const session of readCachedInlineMeshActiveSessionDetails(node)) {
            status.sessions.push(session as any);
          }
        }
      }
      return { userName: loadConfig().userName || undefined };
    },
  };
}
