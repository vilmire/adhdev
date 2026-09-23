/**
 * DaemonComponents / DaemonBootConfig — the typed surface of the staged boot
 * (wiring-unification B4, plan §4). Kept in its own module so mesh/** can
 * `import type` it without pulling the boot graph.
 */

import type { DaemonCdpManager } from '../cdp/manager.js';
import type { DaemonCdpInitializer } from '../cdp/initializer.js';
import type { DaemonCommandHandler } from '../commands/handler.js';
import type { DaemonCommandRouter, SessionHostControlPlane } from '../commands/router.js';
import type {
    DaemonCliManager,
    CliTransportFactoryParams,
    HostedCliRuntimeDescriptor,
} from '../commands/cli-manager.js';
import type { DaemonAgentStreamManager } from '../agent-stream/manager.js';
import type { AgentStreamPoller } from '../agent-stream/poller.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import type { IDEInfo } from '../detection/ide-detector.js';
import type { SessionRegistry } from '../sessions/registry.js';
import type { SessionLifecycleBus } from '../sessions/lifecycle-bus.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import type { TranscriptReplicaStore } from '../seqscribe/transcript-replica-store.js';
import type { SeqscribeRuntime } from '../seqscribe/runtime.js';
import type { PeerHandle } from 'seqscribe';
import type { ComposerResidueSweepHandle } from './composer-residue-sweep.js';
import type { SessionOutputFanout } from './session-output-fanout.js';
import type { TurnLedger } from '../mesh/turn-ledger/ledger.js';
import type { MeshTurnWiring, TurnProbePort } from './stages/mesh-runtime.js';
import type { TurnScheduler } from '../mesh/turn-ledger/scheduler.js';
import type { HousekeepingHandle } from '../mesh/mesh-housekeeping-tick.js';

/** A stage's teardown. Stages return one; `DaemonRuntime.shutdown` runs them in reverse. */
export type Disposer = () => void;

/** How this daemon reaches its session host (the PTY runtime process). */
export interface SessionHostBoot {
    createPtyTransportFactory?: (params: CliTransportFactoryParams) => PtyTransportFactory | null;
    listHostedRuntimes?: () => Promise<HostedCliRuntimeDescriptor[]>;
    managedByTag?: string;
    control?: SessionHostControlPlane | null;
}

export interface DaemonBootConfig {
    /** Canonical status identity (`standalone_<machineId>` / `daemon_<machineId>`). */
    statusInstanceId?: string;
    statusVersion?: string;
    statusDaemonMode?: boolean;
    providerLogFn?: (msg: string) => void;
    enabledIdes?: string[];
    /** Instance ticking interval (ms), default 5000. */
    tickIntervalMs?: number;
    /** CDP scan interval (ms), default 30000. */
    cdpScanIntervalMs?: number;
    sessionHost: SessionHostBoot;
    /** Cloud-only mesh P2P transport. Absent on standalone. */
    mesh?: {
        dispatchMeshCommand?: (daemonId: string, command: string, args: Record<string, unknown>) => Promise<any>;
        getMeshPeerConnectionStatus?: (daemonId: string) => Record<string, unknown> | null;
        /**
         * Cloud-only: refresh the host's dashboard mirror of a mesh worker session
         * (`meshOwnedSessions`) from a forwarded worker event and flush daemon.metadata.
         * ONE hook for what used to be three host paths: the core forwarder
         * (`onMeshCoordinatorEventForwarded`), the self-dial prefs refresh
         * (`updateLocalMeshOwnedSession`), and the host's own `mesh_forward_event`
         * handler (which calls it after the router's stale-approval verdict).
         */
        mirrorMeshWorkerEvent?: (payload: Record<string, unknown>) => void;
        /**
         * G3 (`CommandRouterDeps.resolveTranscriptPeer`, `commands/router.ts`) —
         * cloud-only resolver for a remote daemon's live seqscribe `PeerHandle`,
         * so `TranscriptReplicaStore.ensureSubscription` can attach a `tail` SUB
         * to `session.<id>.transcript` for a session owned by that daemon.
         * Backed by `CloudSeqscribeWiring.resolveTranscriptPeer`
         * (`packages/daemon-cloud/src/cloud-seqscribe-wiring.ts`), which reads
         * the SAME mesh peer map `wireMeshTransport` populates — no new peer
         * registry. Absent on standalone: there is no mesh transport to resolve
         * a peer from, and a LOCAL session's `read_chat` never calls this hook
         * at all (`mesh-transcript-replica-read.ts`'s "LOCAL nodes never take
         * this path").
         */
        resolveTranscriptPeer?: (ownerDaemonId: string) => Promise<PeerHandle | null> | PeerHandle | null;
    };
    /**
     * Restore hosted CLI runtimes inside `startLoops`, after every bus subscriber
     * is attached and before the composer-residue sweep is scheduled. Hosts pass
     * `shouldAutoRestoreHostedSessionsOnStartup(process.env)`.
     */
    restoreHostedSessions?: boolean;
}

export interface DaemonComponents {
    providerLoader: ProviderLoader;
    instanceManager: ProviderInstanceManager;
    cliManager: DaemonCliManager;
    commandHandler: DaemonCommandHandler;
    agentStreamManager: DaemonAgentStreamManager;
    router: DaemonCommandRouter;
    poller: AgentStreamPoller;
    cdpInitializer: DaemonCdpInitializer;
    cdpManagers: Map<string, DaemonCdpManager>;
    sessionRegistry: SessionRegistry;
    /** The session lifecycle bus (B1). Every in-process session fact fans out here. */
    bus: SessionLifecycleBus;
    /** Where CLI PTY output leaves the session core; the host runtime attaches the one sink (B5). */
    outputFanout: SessionOutputFanout;
    /** The daemon's seqscribe runtime; null when the node could not open. */
    seqscribe?: SeqscribeRuntime | null;
    detectedIdes: { value: IDEInfo[] };
    refreshProviderAvailability: (providerType?: string) => Promise<void>;
    dispatchMeshCommand?: (daemonId: string, command: string, args: Record<string, unknown>) => Promise<any>;
    // Cloud-only: live selected-coordinator mesh peer telemetry for a target daemon.
    // Lets the remote task-dispatch path tell a still-opening DataChannel ("cold")
    // apart from an open one ("warm"). Absent on standalone (no P2P mesh).
    getMeshPeerConnectionStatus?: (daemonId: string) => Record<string, unknown> | null;
    // Cloud-only hook: after the single core forwarder handles a mesh coordinator event,
    // cloud keeps its P2P dashboard view in sync. Absent/no-op on standalone.
    onMeshCoordinatorEventForwarded?: (payload: Record<string, unknown>) => void;
    // Periodic provider-quota refresh handle (fills the cache buildLocalNodeFacts READS).
    quotaRefreshLoop?: { stop(): void };
    // Event-driven quota refresh handle (agent:generating_completed → refetch that provider).
    quotaEventRefresh?: { stop(): void };
    // Verified-channel staleness probe (24h read-only listing → dashboard badge data).
    providerStalenessProbe?: { stop(): void };
    // ENTER-LOSS layer ③: one-shot boot composer-residue sweep.
    composerResidueSweep?: ComposerResidueSweepHandle;
    // EVENT-LOOP-LAG-HEARTBEAT sampler.
    eventLoopMonitor?: { stop(): void };
    // Canonical status/daemon identity — the id the reconcile loop drains with
    // (a worker's meshCoordinatorDaemonId is stamped with this prefixed id).
    statusInstanceId?: string;
    /** The runtime's transcript replica store (read by the mesh remote-pull / completion paths). */
    transcriptReplicaStore?: TranscriptReplicaStore;
    /**
     * The daemon's ONE turn ledger (wiring-unification C2/C3), built by S7
     * (`boot/stages/mesh-runtime.ts`) and passed by value — the turn scheduler
     * (S8) and the evidence producers take it from here.
     */
    turnLedger?: TurnLedger | null;
    /** The ledger's late-bound `probe` port; the S8 scheduler binds itself to it. */
    turnProbePort?: TurnProbePort | null;
    /** The C-W3 notice/consumer wiring (cursors, topic index, notice runtime). */
    meshTurn?: MeshTurnWiring | null;
    /** The one turn-lifecycle timer (C4, `mesh/turn-ledger/scheduler.ts`), started in S8. */
    turnScheduler?: TurnScheduler;
    /** Mesh housekeeping cadence (C4, `mesh/mesh-housekeeping-tick.ts`) — never touches turns or holds. */
    meshHousekeeping?: HousekeepingHandle;
    /** Continuous auto fast-forward cadence (P6), its own scheduler. */
    autoFastForwardScheduler?: { stop(): void };
}

/** What `bootDaemonRuntime` returns. `shutdown` tears the stages down in reverse. */
export interface DaemonRuntime {
    components: DaemonComponents;
    bus: SessionLifecycleBus;
    seqscribe: SeqscribeRuntime | null;
    shutdown(): Promise<void>;
}
