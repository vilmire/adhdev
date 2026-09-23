/**
 * SessionHostController — a persistent session-host control-plane client with
 * reconnect and host-event forwarding (wiring-unification B5, D7).
 *
 * Moved verbatim from packages/daemon-cloud/src/session-host-controller.ts so
 * BOTH hosts run it: standalone used a per-request client
 * (StandaloneSessionHostControlPlane) that never subscribed to host events, so
 * a host-side runtime transition never flushed its dashboard's modal /
 * diagnostics topics. The cloud file re-exports this class.
 */
import { LOG } from '../logging/logger.js';
import {
    SessionHostClient,
    createSessionHostControlPlane,
    type AcquireWritePayload,
    type GetHostDiagnosticsPayload,
    type PruneDuplicateSessionsPayload,
    type ReleaseWritePayload,
    type SessionHostControlPlane,
    type SessionHostDiagnostics,
    type SessionHostEndpoint,
    type SessionHostEvent,
    type SessionHostPruneDuplicatesResult,
    type SessionHostRecord,
    type SessionHostRequestType,
    type SessionHostSnapshot,
} from '@adhdev/session-host-core';


export class SessionHostController implements SessionHostControlPlane {
    private readonly client: SessionHostClient;
    private readonly plane: SessionHostControlPlane;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private unsubscribe: (() => void) | null = null;
    private started = false;
    private unsubscribeDisconnect: (() => void) | null = null;
    private wasConnected = false;
    private consecutiveConnectFailures = 0;
    /** Every Nth consecutive 2s connect failure gets a warn line (30 → ~1/min). */
    private static readonly CONNECT_FAILURE_LOG_EVERY = 30;

    constructor(
        endpoint: SessionHostEndpoint,
        private readonly onEvent?: (event: SessionHostEvent) => void,
    ) {
        this.client = new SessionHostClient({ endpoint });
        // The 12-method dispatch table (type strings + throw text) is shared with
        // the standalone daemon via @adhdev/session-host-core. Cloud keeps the
        // reconnect/event layer here and injects a persistent-client transport.
        this.plane = createSessionHostControlPlane({
            request: <T>(type: SessionHostRequestType, payload: Record<string, unknown>) =>
                this.request<T>({ type, payload }),
        });
    }

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        this.unsubscribe = this.client.onEvent((event) => this.handleEvent(event));
        // A lost connection is the daemon's only in-process evidence that the
        // session host died: the host is spawned detached, so there is no child
        // exit to observe from here, and once the socket is gone the host can no
        // longer deliver the `host_log`/`session_exit` events that everything
        // else depends on. Log it at error — this strands every live session.
        this.unsubscribeDisconnect = this.client.onDisconnect((info) => {
            if (!this.started) return;
            this.wasConnected = false;
            const pending = info.pendingRequests > 0
                ? `, ${info.pendingRequests} in-flight request(s) abandoned`
                : '';
            const cause = info.error?.message ? `: ${info.error.message}` : '';
            LOG.error(
                'SessionHost',
                `Connection to session host lost (${info.reason}${cause}) at ${info.endpointPath}${pending}. ` +
                    'Live sessions can no longer report exit or completion until it reconnects.',
            );
        });
        await this.ensureConnected();
        this.reconnectTimer = setInterval(() => {
            void this.ensureConnected();
        }, 2_000);
    }

    async stop(): Promise<void> {
        this.started = false;
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        try {
            this.unsubscribe?.();
            this.unsubscribe = null;
            this.unsubscribeDisconnect?.();
            this.unsubscribeDisconnect = null;
        } catch {
            // noop
        }
        this.wasConnected = false;
        this.consecutiveConnectFailures = 0;
        await this.client.close().catch(() => {});
    }

    getDiagnostics(payload: GetHostDiagnosticsPayload = {}): Promise<SessionHostDiagnostics> {
        return this.plane.getDiagnostics(payload);
    }

    listSessions(): Promise<SessionHostRecord[]> {
        return this.plane.listSessions();
    }

    stopSession(sessionId: string): Promise<SessionHostRecord | null> {
        return this.plane.stopSession(sessionId);
    }

    deleteSession(sessionId: string, opts: { force?: boolean } = {}): Promise<SessionHostRecord | null> {
        return this.plane.deleteSession(sessionId, opts);
    }

    resumeSession(sessionId: string): Promise<SessionHostRecord | null> {
        return this.plane.resumeSession(sessionId);
    }

    restartSession(sessionId: string): Promise<SessionHostRecord | null> {
        return this.plane.restartSession(sessionId);
    }

    sendSignal(sessionId: string, signal: string): Promise<SessionHostRecord | null> {
        return this.plane.sendSignal(sessionId, signal);
    }

    forceDetachClient(sessionId: string, clientId: string): Promise<SessionHostRecord | null> {
        return this.plane.forceDetachClient(sessionId, clientId);
    }

    pruneDuplicateSessions(payload: PruneDuplicateSessionsPayload = {}): Promise<SessionHostPruneDuplicatesResult> {
        return this.plane.pruneDuplicateSessions(payload);
    }

    acquireWrite(payload: AcquireWritePayload): Promise<SessionHostRecord | null> {
        return this.plane.acquireWrite(payload);
    }

    releaseWrite(payload: ReleaseWritePayload): Promise<SessionHostRecord | null> {
        return this.plane.releaseWrite(payload);
    }

    getSnapshot(sessionId: string, sinceSeq?: number): Promise<SessionHostSnapshot | null> {
        return this.plane.getSnapshot(sessionId, sinceSeq);
    }

    private async request<T>(request: {
        type: SessionHostRequestType;
        payload: unknown;
    }): Promise<T> {
        await this.ensureConnected();
        const response = await this.client.request<T>(request as any);
        if (!response.success) {
            throw new Error(response.error || `Session host request failed: ${request.type}`);
        }
        return (response.result ?? null) as T;
    }

    private async ensureConnected(): Promise<void> {
        try {
            await this.client.connect();
            if (!this.wasConnected) {
                this.wasConnected = true;
                // Log the recovery transition too — without it, a log showing a
                // disconnect and nothing after is ambiguous between "still down"
                // and "came back".
                if (this.consecutiveConnectFailures > 0) {
                    LOG.info(
                        'SessionHost',
                        `Reconnected to session host after ${this.consecutiveConnectFailures} failed attempt(s)`,
                    );
                }
                this.consecutiveConnectFailures = 0;
            }
        } catch (error: any) {
            if (!this.started) return;
            this.consecutiveConnectFailures += 1;
            // This used to be LOG.debug — below the default 'info' level — so a
            // session host that was down produced literally no daemon output,
            // just a silent 2s poll. Report the first failure and then decay to
            // a periodic reminder so a long outage stays visible without
            // emitting 30 lines a minute.
            const n = this.consecutiveConnectFailures;
            const message = `Session host connect failed (attempt ${n}): ${error?.message || error}`;
            if (n === 1) {
                LOG.warn('SessionHost', message);
            } else if (n % SessionHostController.CONNECT_FAILURE_LOG_EVERY === 0) {
                const minutes = Math.round((n * 2) / 60);
                LOG.warn('SessionHost', `${message} — session host has been unreachable for ~${minutes}m`);
            } else {
                LOG.debug('SessionHost', message);
            }
        }
    }

    private handleEvent(event: SessionHostEvent): void {
        if (event.type === 'host_log') {
            const line = event.entry.sessionId
                ? `${event.entry.message} (session=${event.entry.sessionId})`
                : event.entry.message;
            switch (event.entry.level) {
                case 'debug':
                    LOG.debug('SessionHost', line);
                    break;
                case 'warn':
                    LOG.warn('SessionHost', line);
                    break;
                case 'error':
                    LOG.error('SessionHost', line);
                    break;
                default:
                    LOG.info('SessionHost', line);
                    break;
            }
        } else if (event.type === 'request_trace') {
            const line = `${event.trace.type} ${event.trace.success ? 'ok' : 'failed'} ${event.trace.durationMs}ms`
                + (event.trace.sessionId ? ` session=${event.trace.sessionId}` : '')
                + (event.trace.error ? ` error=${event.trace.error}` : '');
            if (event.trace.success) LOG.debug('SessionHost', line);
            else LOG.warn('SessionHost', line);
        } else if (event.type === 'runtime_transition') {
            const line = `${event.transition.action} ${event.transition.success === false ? 'failed' : 'ok'}`
                + (event.transition.lifecycle ? ` lifecycle=${event.transition.lifecycle}` : '')
                + (event.transition.detail ? ` detail=${event.transition.detail}` : '')
                + (event.transition.error ? ` error=${event.transition.error}` : '');
            if (event.transition.success === false) LOG.warn('SessionHost', `[${event.transition.sessionId}] ${line}`);
            else LOG.info('SessionHost', `[${event.transition.sessionId}] ${line}`);
        }

        try {
            this.onEvent?.(event);
        } catch (error: any) {
            LOG.warn('SessionHost', `event callback failed: ${error?.message || error}`);
        }
    }
}
