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
 *  - a `type:'status'` push on every command that invalidates daemon.metadata,
 *    from ANY entry (WS, HTTP, IPC compat, provider REST — C11);
 *  - a daemon.metadata flush on `mesh_state`.
 */

import { WebSocket } from 'ws';
import {
  LOG,
  loadConfig,
  readCachedInlineMeshActiveSessionDetails,
  type DaemonHostTransport,
  type DaemonRuntime,
  type SessionHostController,
  type SessionHostDiagnosticsSnapshot,
} from '@adhdev/daemon-core';
import type { StandaloneChatTailFanout } from './standalone-chat-tail.js';

const CHAT_OUTPUT_FLUSH_DEBOUNCE_MS = 700;

/** Send one JSON frame to every OPEN dashboard socket. */
export function broadcastToOpenClients(clients: Iterable<WebSocket>, message: unknown): void {
  let raw: string | null = null;
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    raw ??= JSON.stringify(message);
    client.send(raw);
  }
}

export interface StandaloneHostTransportDeps {
  statusInstanceId: string;
  version: string;
  clients: Set<WebSocket>;
  wsByConnectionId: Map<string, WebSocket>;
  chatTail: Pick<StandaloneChatTailFanout, 'flush' | 'onPrepared'>;
  getRuntime(): DaemonRuntime | null;
  getSessionHostControl(): Pick<SessionHostController, 'getDiagnostics'> | null;
  /** The legacy `type:'status'` push (throttled 500 ms, signature-deduped). */
  scheduleBroadcastStatus(): void;
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
    chatTail: {
      // Union decision #5: the debounce stays a per-daemon constant.
      flushDebounceMs: CHAT_OUTPUT_FLUSH_DEBOUNCE_MS,
      scheduleGate: () => deps.clients.size > 0,
      flushActive: () => { void deps.chatTail.flush(undefined, { onlyActive: true }); },
      // Guarantee the just-finalized session's completion tail reaches the
      // browser once, even if its native tail lands outside the hot window.
      flushCompleted: (sessionIds) => { void deps.chatTail.flush(undefined, { forceSessionIds: sessionIds }); },
      readSource: 'standalone',
      onMissingSession: ({ sessionId, consecutiveMisses, warnNow }) => {
        // One warn per streak; later misses stay at debug.
        const message = `[chat_tail] session ${sessionId} is not in the live registry`;
        if (warnNow) {
          LOG.warn('Standalone', `${message} — backing off, and dropping the subscription if it stays absent`);
        } else {
          LOG.debug('Standalone', `${message} (miss #${consecutiveMisses})`);
        }
      },
      onPrepared: deps.chatTail.onPrepared,
    },
    onFlushError: (topic, error, ctx) => {
      LOG.warn('Standalone', `[${topic}] skipped workspace=${ctx.detail || ''} key=${ctx.key} error=${(error as any)?.message || error}`);
    },
    sessionHostDiagnostics: (opts) => {
      const control = deps.getSessionHostControl();
      return control ? control.getDiagnostics(opts) as Promise<SessionHostDiagnosticsSnapshot> : null;
    },
    broadcastSessionOutput: (sessionId, data) => {
      broadcastToOpenClients(deps.clients, { type: 'session_output', sessionId, data });
    },
    // Checklist item 3: tool-approval / completion toasts reach the
    // standalone dashboard as `status_event`, same projection as cloud's
    // P2P copy (status/status-event.ts allow-list). No server leg.
    sendStatusEvent: (payload) => {
      broadcastToOpenClients(deps.clients, { type: 'status_event', payload, timestamp: Date.now() });
    },
    onStatusFacts: () => deps.scheduleBroadcastStatus(),
    onCommandExecuted: (e) => {
      // Legacy `type:'status'` snapshot push — throttled (500ms) and
      // signature-deduped, so eager triggering is cheap. The topic flush
      // itself rides the host runtime's invalidate. A fast-flush command
      // (launch, interactive prompt answer) pushes immediately too.
      if (e.invalidates.has('daemon.metadata') || (e.fastFlush && e.success)) deps.scheduleBroadcastStatus();
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
