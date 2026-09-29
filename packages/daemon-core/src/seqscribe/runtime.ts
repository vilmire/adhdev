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
 * (scripts/check-import-boundaries.mjs), so everything mesh-side (the parity loop,
 * the terminal redrive) is passed in or armed by boot.
 */

import { LOG } from '../logging/logger.js';
import { loadStoredFleetSecret } from './fleet-secret.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from './node.js';
import { startSeqscribeThroughputCollector, type SeqscribeThroughputCollector } from './throughput-collector.js';
import type { TranscriptProjectionService } from './transcript-publisher.js';
import { TranscriptReplicaStore } from './transcript-replica-store.js';
import { TranscriptTopicClaimRegistry } from './transcript-topic-claim.js';

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
    /** Shared by the transcript publisher (armed later) and the replica store. */
    readonly transcriptClaims: TranscriptTopicClaimRegistry;
    /** §8 unit 3 subscriber-side transcript replica store. */
    readonly transcriptReplica: TranscriptReplicaStore;
    /** The armed projections, or null before arming / after disarm. */
    projections(): SeqscribeProjectionsView | null;
    attachProjections(view: SeqscribeProjectionsView | null): void;
    /**
     * Stop every producer that touches the node on a timer or a SUB (collector, replica store). Idempotent. Must run before `close()`.
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

    // One claim registry for both transcript sides: design §3.5's fail-closed
    // raw-id claim must see every claim attempt for this node.
    const transcriptClaims = new TranscriptTopicClaimRegistry();
    const transcriptReplica = new TranscriptReplicaStore(node, transcriptClaims);

    let projections: SeqscribeProjectionsView | null = null;
    let quiesced = false;
    let closed = false;

    return {
        node,
        collector,
        transcriptClaims,
        transcriptReplica,
        projections: () => projections,
        attachProjections(view) {
            projections = view;
        },
        quiesce() {
            if (quiesced) return;
            quiesced = true;
            // The collector reads node.stats() on a timer.
            try { collector?.stop(); } catch { /* noop */ }
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
