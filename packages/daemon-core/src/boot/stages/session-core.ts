/**
 * S3 bootSessionCore — the lifecycle bus, the session registry, provider
 * instances, CLI/CDP managers and the agent-stream poller (wiring-unification B4).
 *
 * Everything is CONSTRUCTED here; nothing that ticks is started (CDP periodic
 * scan/discovery, poller, instance ticking all start in S8 `startLoops`), so no
 * subscriber attached in S4–S7 can miss an event a loop produced.
 */

import { LOG, getLogLevel } from '../../logging/logger.js';
import { loadConfig } from '../../config/config.js';
import { DaemonCdpManager } from '../../cdp/manager.js';
import { DaemonCdpInitializer } from '../../cdp/initializer.js';
import { setupIdeInstance, type CdpSetupContext } from '../../cdp/setup.js';
import { DaemonCliManager } from '../../commands/cli-manager.js';
import { DaemonAgentStreamManager } from '../../agent-stream/manager.js';
import { AgentStreamPoller } from '../../agent-stream/poller.js';
import { ProviderInstanceManager } from '../../providers/provider-instance-manager.js';
import type { IdeProviderInstance } from '../../providers/ide-provider-instance.js';
import { SUBMIT_DRAIN_SHUTDOWN_MAX_WAIT_MS } from '../../providers/spec/fsm-driver.js';
import { setTranscriptClaimLivenessProbe } from '../../providers/native-history/transcript-claim-registry.js';
import { createSessionLifecycleBus } from '../../sessions/lifecycle-bus.js';
import { subscribeLifecycleTrace } from '../../sessions/lifecycle-trace.js';
import { createSessionEventPort } from '../../sessions/session-port.js';
import { SessionRegistry } from '../../sessions/registry.js';
import type { DaemonFactsCause } from '../../sessions/lifecycle-events.js';
import { loadMeshCoordinatorRegistry } from '../../mesh/coordinator-registry.js';
import { subscribeLiveSessions, transcriptClaimOwnerIsLive } from '../live-sessions.js';
import { SessionOutputFanout } from '../session-output-fanout.js';
import { forwardAgentStreamsToIdeInstance } from '../../agent-stream/forward.js';
import type { ProvidersStage, SessionCoreStage } from './types.js';

export async function bootSessionCore(s2: ProvidersStage): Promise<SessionCoreStage> {
    const { cfg, providerLoader } = s2;

    // The bus + registry pair (B1). The registry is the only emitter of
    // registered/binding/terminated; instances emit through the port.
    const bus = createSessionLifecycleBus();
    // One content-free DEBUG line per bus event (`[bus] …`) — the greppable
    // proof for live verification; disposed with the session core.
    const offTrace = subscribeLifecycleTrace(bus, (line) => LOG.debug('Bus', line), () => getLogLevel() === 'debug');
    const sessionRegistry = new SessionRegistry(bus);
    const instanceManager = new ProviderInstanceManager();
    instanceManager.attachBus(bus);
    instanceManager.setSessionEventPort(createSessionEventPort(bus, sessionRegistry));
    const cdpManagers = new Map<string, DaemonCdpManager>();

    // Persisted coordinator registry: loaded before any session can register.
    loadMeshCoordinatorRegistry();

    // Transcript-claim liveness: a set fed by registered/terminated.
    const liveSessions = subscribeLiveSessions(bus);
    setTranscriptClaimLivenessProbe((owner) => transcriptClaimOwnerIsLive(liveSessions, owner));
    const disposeLiveness = () => {
        liveSessions.unsubscribe();
        setTranscriptClaimLivenessProbe(null);
    };

    const emitFacts = (cause: DaemonFactsCause, sessionId?: string): void => {
        bus.emit({ kind: 'daemon_facts', at: Date.now(), cause, ...(sessionId ? { sessionId } : {}) });
    };
    // `set_cli_view_mode` changes a CLI session's presentation (terminal ↔ chat)
    // without any lifecycle edge; before B5 the cli-manager poked the host's
    // onStatusChange for it. It is a daemon fact now, named for what changed.
    const offViewModeFacts = bus.on('command_executed', (e) => {
        if (e.command === 'set_cli_view_mode' && e.success) emitFacts('cli_view_mode', e.sessionId);
    }, { name: 'session-core.cli-view-mode-facts' });
    void s2.channelBootSync.then((outcome) => {
        if (outcome.activated > 0) emitFacts('provider_channel_sync');
    });
    s2.stalenessProbe.onStale(() => emitFacts('provider_staleness'));

    // CLI PTY output leaves through the fanout; the host runtime attaches the sink.
    const outputFanout = new SessionOutputFanout();
    const cliManager = new DaemonCliManager({
        getP2p: () => outputFanout,
        getInstanceManager: () => instanceManager,
        getSessionRegistry: () => sessionRegistry,
        ...(cfg.sessionHost.createPtyTransportFactory ? { createPtyTransportFactory: cfg.sessionHost.createPtyTransportFactory } : {}),
        ...(cfg.sessionHost.listHostedRuntimes ? { listHostedCliRuntimes: cfg.sessionHost.listHostedRuntimes } : {}),
        ...(cfg.sessionHost.managedByTag ? { hostedRuntimeManagerTag: cfg.sessionHost.managedByTag } : {}),
    }, providerLoader);

    const agentStreamManager = new DaemonAgentStreamManager(
        LOG.forComponent('AgentStream').asLogFn(),
        providerLoader,
        sessionRegistry,
    );
    const poller = new AgentStreamPoller({
        agentStreamManager,
        providerLoader,
        instanceManager,
        cdpManagers,
        sessionRegistry,
        // IDE status edges reach the bus from the IDE instance itself; the only
        // thing left for this callback is folding the streams into that instance.
        onStreamsUpdated: (ideType, streams) => forwardAgentStreamsToIdeInstance(instanceManager, ideType, streams),
    });

    const cdpSetupContext: CdpSetupContext = { providerLoader, instanceManager, cdpManagers, sessionRegistry };
    const cdpInitializer = new DaemonCdpInitializer({
        providerLoader,
        cdpManagers,
        enabledIdes: cfg.enabledIdes || loadConfig().enabledIdes || undefined,
        onConnected: async (ideType, manager, managerKey) => {
            await setupIdeInstance(cdpSetupContext, { ideType, manager, managerKey });
        },
        onDisconnected: async (_ideType, _manager, managerKey) => {
            sessionRegistry.terminateByManagerKey(managerKey, 'ide_detached');
            const instanceKey = `ide:${managerKey}`;
            const ideInstance = instanceManager.getInstance(instanceKey) as IdeProviderInstance | undefined;
            if (ideInstance) {
                instanceManager.removeInstance(instanceKey);
                LOG.info('IDE', `Instance removed after detach: ${instanceKey}`);
            }
            if (ideInstance?.getInstanceId) agentStreamManager.resetParentSession(ideInstance.getInstanceId());
            emitFacts('ide_detached');
        },
    });
    await cdpInitializer.connectAll(s2.detectedIdes.value);

    /** Today's shutdown steps 2–6, in order. */
    const disposeSessionCore = async (): Promise<void> => {
        try {
            await agentStreamManager.dispose(cdpManagers);
        } catch (e: any) { LOG.warn('Shutdown', `AgentStream dispose: ${e?.message}`); }
        // ENTER-LOSS layer ①: wait (bounded) for any in-flight submit — a body
        // already written to a PTY whose submit key is not yet confirmed —
        // before the teardown below clears the submit timers. Graceful shutdown
        // only; the boot composer-residue sweep (layer ③) backstops crashes.
        try {
            await cliManager.drainInFlightSubmits(SUBMIT_DRAIN_SHUTDOWN_MAX_WAIT_MS);
        } catch (e: any) { LOG.warn('Shutdown', `Submit-drain gate error (proceeding): ${e?.message || e}`); }
        // Detach CLIs (persistent runtimes survive daemon restarts), then drop
        // their instances without disposing the runtimes again.
        try { cliManager.detachAll(); } catch { /* noop */ }
        try { instanceManager.removeByCategory('cli', { dispose: false }); } catch { /* noop */ }
        try { instanceManager.disposeAll(); } catch { /* noop */ }
        for (const m of cdpManagers.values()) {
            try { m.disconnect(); } catch { /* noop */ }
        }
        cdpManagers.clear();
        // Last: the trace outlives every teardown above (their terminations are
        // traced) and is gone before the runtime closes the bus.
        try { offTrace(); } catch { /* noop */ }
    };

    return {
        ...s2,
        bus,
        sessionRegistry,
        instanceManager,
        cdpManagers,
        cdpSetupContext,
        outputFanout,
        cliManager,
        agentStreamManager,
        poller,
        cdpInitializer,
        emitFacts,
        disposeSessionCore,
        disposeLiveness: () => {
            offViewModeFacts();
            disposeLiveness();
        },
    };
}
