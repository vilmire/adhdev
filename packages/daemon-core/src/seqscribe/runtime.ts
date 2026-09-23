/**
 * SeqscribeRuntime — the daemon's seqscribe node and everything that lives
 * exactly as long as it (wiring-unification B4, plan §4.1 `bootSeqscribeNode`).
 *
 * Opened in its own boot stage BEFORE the command plane so the router receives
 * it as a value (no `seqscribeNodeRef` / `componentsRef` holders). The
 * projections that need the command handler (transcript pull → `read_chat`)
 * are armed one stage later by boot/stages/seqscribe-projections.ts and
 * attached here through `attachProjections`.
 *
 * Layering: this module may not value-import `mesh/**` or `providers/**`
 * (scripts/check-import-boundaries.mjs), so everything mesh-side (the probe's
 * boot id, the parity loop, the terminal redrive) is passed in or armed by boot.
 */

import { LOG } from '../logging/logger.js';
import type { FleetStatusEntry } from '../status/reporter.js';
import type { BeaconDiagnostics } from './beacon-diagnostics.js';
import { loadStoredFleetSecret } from './fleet-secret.js';
import { observeFleetStatusWsProjection, type FleetStatusParityExpectation } from './fleet-status-parity.js';
import { createFleetStatusPeerViewConsumer, type FleetStatusPeerViewConsumer } from './fleet-status-peer-view.js';
import { isFleetStatusShadowActive, recordFleetStatusShadow } from './fleet-status-shadow.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from './node.js';
import { startConvergenceProbe, type ProbeHandle } from './probe.js';
import { startSeqscribeThroughputCollector, type SeqscribeThroughputCollector } from './throughput-collector.js';
import type { TranscriptProjectionService } from './transcript-publisher.js';
import { TranscriptReplicaStore } from './transcript-replica-store.js';
import { TranscriptTopicClaimRegistry } from './transcript-topic-claim.js';

/** A beacon as the daemon reads it — typed structurally so this module does not drag in beacon.ts. */
export interface BeaconHandleLike {
    diagnostics(): BeaconDiagnostics;
}

/**
 * Where the HOST puts its beacon once armed (cloud: first authenticated epoch,
 * long after boot). Replaces the `componentsRef` holder the router's
 * `getBeaconDiagnostics` closure used to read. Standalone never sets it.
 */
export interface BeaconSlot {
    set(handle: BeaconHandleLike | null): void;
    get(): BeaconHandleLike | null;
}

export function createBeaconSlot(): BeaconSlot {
    let handle: BeaconHandleLike | null = null;
    return {
        set(next) { handle = next; },
        get() { return handle; },
    };
}

/**
 * The fleet.status producer the status reporter calls each tick. Bound to the
 * shadow/parity legs armed for THIS runtime; passing it explicitly
 * (`StatusReporterDeps.seqscribe`) replaces the reporter's direct imports of
 * those module functions.
 */
export interface FleetStatusProducer {
    isShadowActive(): boolean;
    record(entry: FleetStatusEntry): boolean;
    observeWsProjection(build: () => FleetStatusParityExpectation): boolean;
}

const fleetStatusProducer: FleetStatusProducer = {
    isShadowActive: () => isFleetStatusShadowActive(),
    record: (entry) => recordFleetStatusShadow(entry),
    observeWsProjection: (build) => observeFleetStatusWsProjection(build),
};

/** What `armSeqscribeProjections` hands back to the runtime while armed. */
export interface SeqscribeProjectionsView {
    /** The live transcript publisher, or null when the node could not arm it. */
    transcript: TranscriptProjectionService | null;
}

export interface SeqscribeRuntime {
    readonly node: SeqscribeNodeHandle;
    /**
     * The process's ONLY `node.stats()` drain owner, exposed read-only: readers
     * get the published snapshot, never `collect()` (a second collector call
     * cuts the interval at an arbitrary moment — see throughput-collector.ts).
     */
    readonly collector: Pick<SeqscribeThroughputCollector, 'snapshot'> | null;
    /** Stage 1 convergence probe; null in provisional mode. */
    readonly probe: ProbeHandle | null;
    /** Phase 4 Stage 2 per-peer ring-tail SUB owner; null when it failed to construct. */
    readonly fleetPeerView: FleetStatusPeerViewConsumer | null;
    /** Shared by the transcript publisher (armed later) and the replica store. */
    readonly transcriptClaims: TranscriptTopicClaimRegistry;
    /** §8 unit 3 subscriber-side transcript replica store. */
    readonly transcriptReplica: TranscriptReplicaStore;
    readonly beacon: BeaconSlot;
    readonly fleetStatus: FleetStatusProducer;
    /** The armed projections, or null before arming / after disarm. */
    projections(): SeqscribeProjectionsView | null;
    attachProjections(view: SeqscribeProjectionsView | null): void;
    /**
     * Stop every producer that touches the node on a timer or a SUB (probe,
     * collector, peer view, replica store). Idempotent. Must run before `close()`.
     */
    quiesce(): void;
    /** Release the node (and its DB owner lock). Idempotent; never throws. */
    close(): Promise<void>;
}

export interface DaemonSeqscribeBootOptions {
    daemonId?: string;
    env?: NodeJS.ProcessEnv;
    /** Test override; production always uses the config-dir default. */
    dbPath?: string;
}

/** Open the daemon-owned node without turning replication failure into boot failure. */
export function tryOpenDaemonSeqscribeNode(
    options: DaemonSeqscribeBootOptions = {},
): SeqscribeNodeHandle | undefined {
    const env = options.env ?? process.env;
    try {
        return openSeqscribeNode({
            daemonId: options.daemonId,
            ...(options.dbPath ? { dbPath: options.dbPath } : {}),
            env,
            storedFleetSecret: loadStoredFleetSecret(env)?.secret ?? null,
        });
    } catch (error) {
        LOG.warn(
            'Seqscribe',
            `node unavailable; daemon will continue without replication: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
    }
}

export interface OpenSeqscribeRuntimeOptions {
    daemonId?: string;
    /** Probe record version (the daemon's status version). */
    version: string;
    /** Probe boot id (mesh refine-executor boot id — passed in; seqscribe may not import mesh). */
    bootId?: string;
    /** Test seam: replaces `tryOpenDaemonSeqscribeNode`. */
    openNode?: () => SeqscribeNodeHandle | undefined;
}

function warnUnavailable(what: string, error: unknown): void {
    LOG.warn('Seqscribe', `${what} unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Open the node and start its node-scoped producers. Returns null when the node
 * cannot open (fail-soft by contract: the daemon boots without replication).
 */
export function openSeqscribeRuntime(options: OpenSeqscribeRuntimeOptions): SeqscribeRuntime | null {
    const node = options.openNode
        ? options.openNode()
        : tryOpenDaemonSeqscribeNode({ daemonId: options.daemonId });
    if (!node) return null;

    let fleetPeerView: FleetStatusPeerViewConsumer | null = null;
    try {
        fleetPeerView = createFleetStatusPeerViewConsumer(node);
    } catch (error) {
        warnUnavailable('fleet.status SUB consumer', error);
    }

    // The process's single owner of the P24 interval drain (since SPEC v3.7
    // P31 the drain lives behind `drainSyncInterval()`; one owner keeps the
    // interval windows disjoint). Primed once so `get_status_metadata` and the
    // first status report have a snapshot instead of null for a full tick.
    let collector: SeqscribeThroughputCollector | null = null;
    try {
        collector = startSeqscribeThroughputCollector({
            readStats: () => node.node.stats(),
            drainInterval: () => node.node.drainSyncInterval(),
        });
        collector.collect();
    } catch (error) {
        warnUnavailable('throughput collector', error);
        collector = null;
    }

    // Stage 1 convergence probe: one small record appended, others' logged, so
    // live convergence is greppable. Null in provisional mode; never throws.
    let probe: ProbeHandle | null = null;
    try {
        probe = startConvergenceProbe(node, {
            version: options.version,
            ...(options.bootId ? { bootId: options.bootId } : {}),
        });
    } catch (error) {
        warnUnavailable('convergence probe', error);
    }

    // One claim registry for both transcript sides: design §3.5's fail-closed
    // raw-id claim must see every claim attempt for this node.
    const transcriptClaims = new TranscriptTopicClaimRegistry();
    const transcriptReplica = new TranscriptReplicaStore(node, transcriptClaims);
    const beacon = createBeaconSlot();

    let projections: SeqscribeProjectionsView | null = null;
    let quiesced = false;
    let closed = false;

    return {
        node,
        collector,
        probe,
        fleetPeerView,
        transcriptClaims,
        transcriptReplica,
        beacon,
        fleetStatus: fleetStatusProducer,
        projections: () => projections,
        attachProjections(view) {
            projections = view;
        },
        quiesce() {
            if (quiesced) return;
            quiesced = true;
            // Probe first — its append and its consumer must both be quiet
            // before the node closes, or a tick races the close.
            try { probe?.stop(); } catch { /* noop */ }
            // The collector reads node.stats() on a timer.
            try { collector?.stop(); } catch { /* noop */ }
            // Connection-scoped ring SUBs must close before node.close().
            try { fleetPeerView?.stop(); } catch { /* noop */ }
            try { transcriptReplica.stop(); } catch { /* noop */ }
        },
        async close() {
            if (closed) return;
            closed = true;
            try {
                await node.close();
            } catch (error) {
                LOG.warn('Shutdown', `Seqscribe close: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    };
}
