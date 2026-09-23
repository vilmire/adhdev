/**
 * Stage result types of the staged daemon boot (wiring-unification B4, plan §4.1).
 *
 * Each stage takes the previous stage's result and returns it extended, so a
 * stage can only use what an earlier stage produced — the ordering the old
 * `initDaemonComponents` stated in ~15 comments is now a type chain.
 */

import type { ADHDevConfig } from '../../config/config.js';
import type { readUpgradeFailureNotice } from '../../commands/upgrade-helper.js';
import type { DaemonCdpManager } from '../../cdp/manager.js';
import type { DaemonCdpInitializer } from '../../cdp/initializer.js';
import type { DaemonCommandHandler } from '../../commands/handler.js';
import type { DaemonCommandRouter } from '../../commands/router.js';
import type { CommandRegistry } from '../../commands/command-registry.js';
import type { DaemonCliManager } from '../../commands/cli-manager.js';
import type { DaemonAgentStreamManager } from '../../agent-stream/manager.js';
import type { AgentStreamPoller } from '../../agent-stream/poller.js';
import type { ProviderLoader } from '../../providers/provider-loader.js';
import type { VersionArchive } from '../../providers/version-archive.js';
import type { ProviderInstanceManager } from '../../providers/provider-instance-manager.js';
import type { IDEInfo } from '../../detection/ide-detector.js';
import type { SessionRegistry } from '../../sessions/registry.js';
import type { SessionLifecycleBus } from '../../sessions/lifecycle-bus.js';
import type { DaemonFactsCause } from '../../sessions/lifecycle-events.js';
import type { SeqscribeRuntime } from '../../seqscribe/runtime.js';
import type { CdpSetupContext } from '../../cdp/setup.js';
import type { DaemonBootConfig, DaemonComponents, Disposer } from '../daemon-components.js';
import type { SessionOutputFanout } from '../session-output-fanout.js';

export type UpgradeFailureNotice = NonNullable<ReturnType<typeof readUpgradeFailureNotice>>;

/** S1 — process-wide platform setup. */
export interface PlatformStage {
    cfg: DaemonBootConfig;
    /** config.json as re-read AFTER the provider-channel migration. */
    appConfig: ADHDevConfig;
    envOverridesApplied: string[];
    upgradeFailure: UpgradeFailureNotice | null;
}

/** S2 — provider loading, channel sync, detection. */
export interface ProvidersStage extends PlatformStage {
    providerLoader: ProviderLoader;
    versionArchive: VersionArchive;
    detectedIdes: { value: IDEInfo[] };
    refreshProviderAvailability(providerType?: string): Promise<void>;
    /** First-sync → daemon-update sync, ONE promise chain (never concurrent). Never rejects. */
    channelBootSync: Promise<{ activated: number }>;
    stalenessProbe: { stop: Disposer; onStale(cb: () => void): void };
}

/** S3 — bus, registry, instances, CLI/CDP managers (constructed, loops not started). */
export interface SessionCoreStage extends ProvidersStage {
    bus: SessionLifecycleBus;
    sessionRegistry: SessionRegistry;
    instanceManager: ProviderInstanceManager;
    cdpManagers: Map<string, DaemonCdpManager>;
    cdpSetupContext: CdpSetupContext;
    /** CLI PTY output path (off the bus); the host runtime attaches the sink. */
    outputFanout: SessionOutputFanout;
    cliManager: DaemonCliManager;
    agentStreamManager: DaemonAgentStreamManager;
    poller: AgentStreamPoller;
    cdpInitializer: DaemonCdpInitializer;
    /** Emit `daemon_facts{cause}`. Hosts subscribe; nothing calls back into them. */
    emitFacts(cause: DaemonFactsCause, sessionId?: string): void;
    /** Session-core teardown (today's shutdown steps 2–6). */
    disposeSessionCore(): Promise<void>;
    /** Liveness-subscription + claim-probe teardown. */
    disposeLiveness: Disposer;
}

/** S4 — the seqscribe node, opened BEFORE the command plane so the router gets a value. */
export interface SeqscribeNodeStage extends SessionCoreStage {
    seqscribe: SeqscribeRuntime | null;
}

/** S5 — command handler + router. */
export interface CommandPlaneStage extends SeqscribeNodeStage {
    commandRegistry: CommandRegistry;
    commandHandler: DaemonCommandHandler;
    router: DaemonCommandRouter;
}

/** S6 — seqscribe projections armed (they need the command handler for read_chat). */
export interface ProjectionsStage extends CommandPlaneStage {
    /** Disarms in the exact reverse of the arm order; also clears the runtime slot. */
    disarmProjections: Disposer;
}

/** S7 — mesh runtime: bus subscribers, forwarding, reconcile + quota loops. */
export interface MeshRuntimeStage extends ProjectionsStage {
    components: DaemonComponents;
    disposeMeshRuntime: Disposer;
}
