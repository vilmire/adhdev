/**
 * createDaemonHostRuntime — the host surface both daemons share
 * (wiring-unification B5, plan §3.1, design §B3 "Host absorption").
 *
 * Before B5 the cloud daemon (`adhdev-daemon.ts`) and the standalone server
 * (`daemon-standalone/src/index.ts`) each hand-wrote the same ~20 pieces of
 * glue around `initDaemonComponents`, and the copies had drifted: two
 * `onStatusChange` lambdas each, two output broadcasters, two topic-registry
 * constructions, two interaction-id maps (standalone's unbounded), two
 * command→invalidation blocks (and six router callers with none), two
 * metadata / snapshot builders (standalone's IPC one without the git summary).
 *
 * Here that glue is written once, against the bus, and a host supplies only
 * its TRANSPORT (`DaemonHostTransport`: how bytes / updates / events leave the
 * process, plus the few host-owned policies — mandatory-update admission,
 * the cloud mesh-owned metadata append). This module is composition only; the
 * per-concern logic lives in ./host-subscribers.ts and ../status/status-event.ts.
 */

import type { DevServer as DevServerType } from '../daemon/dev-server.js';
import { DevServer } from '../daemon/dev-server.js';
import { LOG } from '../logging/logger.js';
import { createInteractionId } from '../logging/debug-trace.js';
import { getDaemonCommandRegistry, type CommandRouterResult } from '../commands/router.js';
import { normalizeCommandSource, type CommandSource, type CommandSpec } from '../commands/command-registry.js';
import { createGitWorkspaceMonitor, type GitWorkspaceMonitor } from '../git/git-monitor.js';
import type { DaemonStatusEventPayload, P2PStatusEventPayload, SessionHostDiagnosticsSnapshot } from '../shared-types.js';
import type { EventOf } from '../sessions/lifecycle-events.js';
import type { Unsubscribe } from '../sessions/lifecycle-bus.js';
import { buildStatusSnapshot } from '../status/snapshot.js';
import { createStatusEventEmitter } from '../status/status-event.js';
import {
    TopicSubscriptionRegistry,
    type DaemonMetadataScope,
    type DaemonMetadataUpdateBody,
    type TopicEngineOptions,
    type TopicSink,
} from '../subscriptions/topic-registry.js';
import type { DaemonMetadataSubscriptionParams } from '../shared-types.js';
import type { DaemonRuntime } from './daemon-components.js';
import { markTranscriptPtyOutputActivity } from '../seqscribe/transcript-publisher.js';
import {
    subscribeHostCommandTopics,
    subscribeHostMeshState,
    subscribeHostStatusFacts,
    subscribeHostTopicPump,
    subscribeHostTopicReconciliation,
    subscribeHostTurnSnapshots,
    type StatusFactsEvent,
} from './host-subscribers.js';

export type HostSnapshotProfile = 'full' | 'live' | 'metadata';
export type HostStatusSnapshot = ReturnType<typeof buildStatusSnapshot>;

/** A command the transport refused before it reached the router (e.g. a pending mandatory update). */
export interface HostAdmissionContext {
    command: string;
    spec: CommandSpec | undefined;
    /** The entry transport (`unknown` for a host-supplied string outside {@link CommandSource}). */
    source: CommandSource | 'unknown';
    interactionId: string;
    args: Record<string, unknown>;
}

/** Everything a host decides; the runtime decides the rest. */
export interface DaemonHostTransport {
    kind: 'cloud' | 'standalone';
    /** Canonical status instance id (`daemon_<mid>` / `standalone_<mid>`), read per build. */
    instanceId(): string;
    version: string;
    /** Topic delivery: P2P peer (cloud) / WS connection (standalone). */
    topicSink: TopicSink;
    onFlushError?: TopicEngineOptions['onFlushError'];
    sessionHostDiagnostics?(opts: { includeSessions: boolean; limit?: number }): Promise<SessionHostDiagnosticsSnapshot> | null;
    /** Raw output send (the CLI gate and activity mark already ran). */
    broadcastSessionOutput(sessionId: string, data: string): void;
    /** Dashboard `status_event` delivery (cloud P2P, standalone WS broadcast). */
    sendStatusEvent(payload: P2PStatusEventPayload): void;
    /** Server `status_event` delivery (cloud only). */
    sendServerStatusEvent?(payload: DaemonStatusEventPayload): void;
    /**
     * Daemon facts changed — host extras (cloud: the server status_report).
     * The dashboard's daemon.metadata flush is the runtime's own
     * (host.metadata-pump), not the host's.
     */
    onStatusFacts?(e: StatusFactsEvent): void;
    /** Host extras after the shared topic invalidation of an executed command. */
    onCommandExecuted?(e: EventOf<'command_executed'>): void;
    /** Host extras before the daemon.metadata flush on a mesh state change. */
    onMeshState?(meshId: string): void;
    /** Host-owned part of daemon.metadata (may append to `status.sessions`). */
    metadataExtras?(status: HostStatusSnapshot, params: DaemonMetadataSubscriptionParams | undefined): Partial<DaemonMetadataUpdateBody>;
    /**
     * Per-connection daemon.metadata projection (cloud: a share-link peer sees
     * only its shared session, as its permission allows). null = the full body.
     */
    metadataScope?(connectionId: string): DaemonMetadataScope | null;
    /** Refuse a command before the router runs it. Return the failure result, or null to admit. */
    admit?(ctx: HostAdmissionContext): CommandRouterResult | null;
}

export interface DaemonHostRuntime {
    readonly runtime: DaemonRuntime;
    readonly topics: TopicSubscriptionRegistry;
    readonly gitMonitor: GitWorkspaceMonitor;
    /**
     * The ONLY command entry for every transport: interaction id, admission,
     * router. `source` is a {@link CommandSource}; any other string (a server
     * relay stamp) is admitted and logged as `unknown`, exactly as the router does.
     */
    execute(
        cmd: string,
        args: unknown,
        source: CommandSource | string,
        opts?: { peerId?: string },
    ): Promise<CommandRouterResult & { interactionId: string }>;
    /** Latest interaction id recorded for a session (router-owned, bounded). */
    interactionId(sessionId: string | undefined): string | undefined;
    getCliPresentationMode(sessionId: string): 'terminal' | 'chat' | null;
    isCliSession(sessionId: string): boolean;
    /** One snapshot builder; always carries the git summary. */
    buildSnapshot(profile: HostSnapshotProfile): HostStatusSnapshot;
    buildDaemonMetadataBody(params?: DaemonMetadataSubscriptionParams): DaemonMetadataUpdateBody;
    /** DevServer on :19280 + provider hot reload (`providerLoader.watch()`), for both hosts. */
    startDevSupport(opts?: { logFn?: (msg: string) => void; /** Test seam (default 19280). */ port?: number }): Promise<DevServerType>;
    /** Detach every host subscriber and the output sink (the runtime itself is shut down separately). */
    stop(): void;
}

function toArgsRecord(args: unknown): Record<string, unknown> {
    return args && typeof args === 'object' ? { ...(args as Record<string, unknown>) } : {};
}

export function createDaemonHostRuntime(runtime: DaemonRuntime, transport: DaemonHostTransport): DaemonHostRuntime {
    const { components, bus } = runtime;
    const gitMonitor = createGitWorkspaceMonitor();

    const getCliPresentationMode = (sessionId: string): 'terminal' | 'chat' | null => {
        if (!sessionId) return null;
        const instance = components.instanceManager.getInstance(sessionId) as
            | { category?: string; getPresentationMode?(): unknown }
            | undefined;
        if (instance?.category !== 'cli') return null;
        const mode = instance.getPresentationMode?.();
        return mode === 'chat' || mode === 'terminal' ? mode : null;
    };
    const isCliSession = (sessionId: string): boolean => getCliPresentationMode(sessionId) !== null;

    const buildSnapshot = (profile: HostSnapshotProfile): HostStatusSnapshot => buildStatusSnapshot({
        allStates: components.instanceManager.collectAllStates(),
        cdpManagers: components.cdpManagers,
        providerLoader: components.providerLoader,
        detectedIdes: components.detectedIdes.value.map((ide) => ({ ...ide, path: ide.path ?? undefined })),
        instanceId: transport.instanceId(),
        version: transport.version,
        profile,
        getGitSummaryForWorkspace: (workspace) => gitMonitor.getCompactSummary(workspace),
    });

    const buildDaemonMetadataBody = (params?: DaemonMetadataSubscriptionParams): DaemonMetadataUpdateBody => {
        const status = buildSnapshot('metadata');
        // The machine-detail staleness badge rides this lane (never a pull of the whole status).
        const staleness = components.providerLoader.getChannelStalenessSnapshot?.();
        if (staleness && !staleness.error) {
            status.providerChannelStaleness = { staleTypes: [...staleness.staleTypes], newTypes: [...staleness.newTypes] };
        }
        const extras = transport.metadataExtras?.(status, params) ?? {};
        return { daemonId: transport.instanceId(), status, ...extras } as DaemonMetadataUpdateBody;
    };

    const execute: DaemonHostRuntime['execute'] = async (cmd, args, source, opts) => {
        const normalized = toArgsRecord(args);
        if (typeof normalized._interactionId !== 'string' || !normalized._interactionId.trim()) {
            normalized._interactionId = createInteractionId();
        }
        const interactionId = String(normalized._interactionId);
        const refused = transport.admit?.({
            command: cmd,
            spec: getDaemonCommandRegistry().get(cmd),
            source: normalizeCommandSource(source),
            interactionId,
            args: normalized,
        });
        if (refused) return { ...refused, interactionId };
        const result = await components.router.execute(cmd, normalized, source, opts);
        return { ...result, interactionId };
    };

    const topics = new TopicSubscriptionRegistry(transport.topicSink, {
        gitMonitor,
        sources: {
            daemonMetadataBody: (params) => buildDaemonMetadataBody(params),
            sessionHostDiagnostics: (opts) => transport.sessionHostDiagnostics?.(opts) ?? null,
            // The mesh view's lane: the SAME body the `mesh_status` command returns
            // (coordinator-held state; never a remote read on this path).
            meshStatus: async (meshId) => {
                const result = await components.router.execute('mesh_status', { meshId }, 'internal', { inProcess: true });
                if (!result || result.success === false) return null;
                const { interactionId: _interactionId, ...status } = result as Record<string, unknown>;
                return status;
            },
        },
        ...(transport.metadataScope ? { metadataScope: (connectionId: string) => transport.metadataScope!(connectionId) } : {}),
        ...(transport.onFlushError ? { onFlushError: transport.onFlushError } : {}),
    });

    // SessionOutputFanout sink: the CLI gate and the keyed chat lane's
    // throttled dirty trigger run for every chunk, whether or not a dashboard
    // is connected; then the raw send. This is the chat lane's ONLY
    // streaming-rate trigger (TRANSCRIPT_PTY_DIRTY_THROTTLE_MS) — its other
    // dirty triggers fire on status transitions and once post-chat.
    const detachOutput = components.outputFanout.attach((sessionId, data) => {
        if (!isCliSession(sessionId)) return;
        markTranscriptPtyOutputActivity(sessionId);
        transport.broadcastSessionOutput(sessionId, data);
    });

    const offs: Unsubscribe[] = [
        subscribeHostStatusFacts(bus, (e) => transport.onStatusFacts?.(e)),
        subscribeHostTopicPump(bus, topics),
        subscribeHostCommandTopics(bus, topics, transport.onCommandExecuted?.bind(transport)),
        subscribeHostMeshState(bus, topics, transport.onMeshState?.bind(transport)),
        subscribeHostTurnSnapshots(bus, {
            sessionRegistry: components.sessionRegistry,
            gitServices: components.commandHandler.ctx?.gitCommandServices ?? null,
            gitMonitor,
        }),
        // P-II item 1: replaces both hosts' 2-2.5s "safety net" flush timers.
        // WARN-only — never flushes; see host-subscribers.ts for the policy note.
        subscribeHostTopicReconciliation(bus, topics),
        // send_chat refreshes the workspace git pill (the pre-turn snapshot is
        // the command plane's onBeforeSendChat).
        bus.on('command_executed', (e) => {
            if (e.command !== 'send_chat' || !e.sessionId) return;
            const workspace = components.sessionRegistry.get(e.sessionId)?.workspace;
            if (workspace) void gitMonitor.refresh({ workspace, includeDiffSummary: false }).catch(() => {});
        }, { name: 'host.send-chat-git-refresh' }),
        createStatusEventEmitter(bus, {
            instanceManager: components.instanceManager,
            sessionRegistry: components.sessionRegistry,
            sendDashboard: (payload) => transport.sendStatusEvent(payload),
            ...(transport.sendServerStatusEvent ? { sendServer: (payload: DaemonStatusEventPayload) => transport.sendServerStatusEvent!(payload) } : {}),
        }),
    ];

    const startDevSupport: DaemonHostRuntime['startDevSupport'] = async (opts = {}) => {
        const devServer = new DevServer({
            providerLoader: components.providerLoader,
            cdpManagers: components.cdpManagers,
            instanceManager: components.instanceManager,
            cliManager: components.cliManager,
            bus,
            ...(opts.logFn ? { logFn: opts.logFn } : {}),
            onProviderSourceConfigChanged: async () => {
                await components.refreshProviderAvailability();
                bus.emit({ kind: 'daemon_facts', at: Date.now(), cause: 'provider_settings' });
            },
        });
        await devServer.start(opts.port);
        // Hot reload for both hosts (cloud's inline DevServer never called it).
        components.providerLoader.watch();
        return devServer;
    };

    let stopped = false;
    return {
        runtime,
        topics,
        gitMonitor,
        execute,
        interactionId: (sessionId) => components.router.interactionContext.get(sessionId),
        getCliPresentationMode,
        isCliSession,
        buildSnapshot,
        buildDaemonMetadataBody,
        startDevSupport,
        stop() {
            if (stopped) return;
            stopped = true;
            detachOutput();
            for (const off of offs.reverse()) {
                try { off(); } catch (error) {
                    LOG.debug('HostRuntime', `unsubscribe failed: ${(error as Error)?.message ?? error}`);
                }
            }
        },
    };
}
