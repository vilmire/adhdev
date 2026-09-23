/**
 * S6 armSeqscribeProjections — arm every projection that writes to or reads
 * from the seqscribe node, in ONE fixed order, and return one disposer that
 * disarms in the exact reverse (wiring-unification B4, plan §4.1/§4.4).
 *
 * Split from S4 because the transcript pull re-enters `read_chat` through the
 * command handler (S5). The process-wide `seqscribeSlot` is bound here first
 * and cleared last, replacing ten independently-ordered `configure*` calls.
 *
 * Arm order (each step's reason is the old boot comment it replaces):
 *   1. mesh publisher (wiring-unification C7-1; was the dual-write shadow) —
 *      before any mesh ledger append / meshRecord (S7+).
 *   2. fleet.status shadow, then 3. fleet.status parity (only arms over an
 *      active shadow).
 *   4. transcript projection + its bus subscriber (+ the registry's claim release).
 *   5. transcript writer-gc (G2b, `writer-gc.ts`) — after the projection so
 *      the sweep only ever prunes topics the projection has already had a
 *      chance to define; arming order between this and mesh topic activation
 *      below doesn't matter (disjoint topic namespaces), so it goes right
 *      after its natural predecessor, the transcript projection.
 *   6. activate known mesh topics — needs the armed publisher node. NOT a
 *      tryStep: a known mesh whose events topic cannot be defined is a mesh
 *      boot failure (C7-1), so the error propagates out of the stage.
 *   7. prune retired durable cursors (the Stage 4A read model, the Stage 3
 *      parity nonces, the Stage 5a terminal redrive — C3 correction 4), BEFORE
 *      S7 registers the turn cursors (`turn.ingest` / `turn.deliver` /
 *      `mesh.index`, `seqscribe/mesh-turn-consumer.ts`), which need the turn
 *      ledger S7 constructs.
 *
 * Gone with C-W3: the in-memory read model and its readiness gate (C7-2 — the
 * durable `mesh_topic_index` replaces them), the parity loop (C7-6) and the
 * terminal redrive (the `turn.deliver` cursor IS redelivery).
 */

import { LOG } from '../../logging/logger.js';
import { listMeshesReadOnly } from '../../config/mesh-config.js';
import { resolveJsonlSourcePath } from '../../providers/spec/native-history-executor.js';
import { activateMeshTopicsAtBoot, configureMeshPublisher } from '../../seqscribe/mesh-publisher.js';
import { configureFleetStatusShadow } from '../../seqscribe/fleet-status-shadow.js';
import { configureFleetStatusParity } from '../../seqscribe/fleet-status-parity.js';
import { configureTranscriptProjection } from '../../seqscribe/transcript-publisher.js';
import { createLiveTranscriptPublisher } from '../../seqscribe/transcript-publish-runtime.js';
import { releaseSessionTranscriptTopic } from '../../seqscribe/transcript-activation.js';
import { subscribeTranscriptProjection } from '../../seqscribe/transcript-bus-subscriber.js';
import { configureTranscriptWriterGc } from '../../seqscribe/writer-gc.js';
import { pruneRetiredMeshConsumers } from '../../seqscribe/mesh-turn-consumer.js';
import { bindSeqscribeRuntime } from '../../seqscribe/runtime-slot.js';
import type { SeqscribeRuntime } from '../../seqscribe/runtime.js';
import type { Disposer } from '../daemon-components.js';
import type { CommandPlaneStage, ProjectionsStage } from './types.js';

function shortId(sessionId: string): string {
    return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 8)}…`;
}

function tryStep(tag: string, what: string, fn: () => void): void {
    try {
        fn();
    } catch (error) {
        LOG.warn(tag, `${what} unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export interface ArmSeqscribeProjectionsHooks {
    /** Test seam: observe each arm/disarm step name in order. */
    onStep?: (step: string) => void;
}

export function armSeqscribeProjections(s5: CommandPlaneStage, hooks: ArmSeqscribeProjectionsHooks = {}): ProjectionsStage {
    const rt = s5.seqscribe;
    if (!rt) return { ...s5, disarmProjections: () => {} };
    return { ...s5, disarmProjections: armProjections(rt, s5, hooks) };
}

function armProjections(rt: SeqscribeRuntime, s5: CommandPlaneStage, hooks: ArmSeqscribeProjectionsHooks): Disposer {
    const step = (name: string) => hooks.onStep?.(`arm:${name}`);
    const undo: Array<[string, () => void]> = [];
    const node = rt.node;

    bindSeqscribeRuntime(rt);
    step('slot');
    undo.push(['slot', () => bindSeqscribeRuntime(null)]);

    // 1–3. Mesh publisher, fleet.status shadow + parity.
    tryStep('Seqscribe', 'mesh publisher', () => configureMeshPublisher(node));
    step('publisher');
    undo.push(['publisher', () => configureMeshPublisher(null)]);
    tryStep('Seqscribe', 'fleet.status shadow', () => configureFleetStatusShadow(node));
    step('fleet-shadow');
    undo.push(['fleet-shadow', () => configureFleetStatusShadow(null)]);
    tryStep('Seqscribe', 'fleet.status parity', () => { configureFleetStatusParity(node); });
    step('fleet-parity');
    undo.push(['fleet-parity', () => { configureFleetStatusParity(null); }]);

    // 4. Transcript projection (§8 unit 3). Releasing the in-memory claim on
    // session removal lets a later session reuse a colliding sanitized segment.
    s5.sessionRegistry.setTranscriptTopicRelease((rawSessionId) => releaseSessionTranscriptTopic(rt.transcriptClaims, rawSessionId));
    const transcriptOwnerDaemonId = node.daemonId ?? node.writerId;
    let transcript: ReturnType<typeof configureTranscriptProjection> = null;
    tryStep('Seqscribe', 'transcript projection', () => {
        transcript = configureTranscriptProjection({
            daemonId: () => transcriptOwnerDaemonId,
            writerId: () => node.writerId,
            publishRevision: createLiveTranscriptPublisher(node, rt.transcriptClaims, transcriptOwnerDaemonId),
            resolveSourcePath: (sessionId: string) => {
                const session = s5.sessionRegistry.get(sessionId);
                if (!session) return null;
                const provider = s5.providerLoader.getMeta(session.providerType);
                const nh = provider?.nativeHistory as any;
                if (!nh?.source) return null;
                return resolveJsonlSourcePath(nh.source, {
                    workspace: session.workspace,
                    providerSessionId: session.providerSessionId,
                    sessionStartedAtMs: session.spawnedAtMs,
                });
            },
            // PULL collector: re-enters the SAME internal read_chat pipeline whose
            // choke point pushes the observation nested — TranscriptProjectionService's
            // in-flight guard queues that nested observe() and settle() publishes
            // it, so returning null is correct on the healthy path. A throw is
            // logged and rethrown so runPull counts it as collectFailed.
            collectObservation: async (sessionId: string) => {
                try {
                    await s5.commandHandler.handle('read_chat', { targetSessionId: sessionId });
                } catch (error: any) {
                    LOG.warn('Seqscribe', `transcript projection internal read_chat failed session=${shortId(sessionId)}: ${error?.message || String(error)}`);
                    throw error;
                }
                return null;
            },
            onOversize: (sessionId) => {
                LOG.warn('Seqscribe', `transcript projection oversize session=${shortId(sessionId)} — caller must fall back to legacy read_chat/chat_history`);
            },
        });
    });
    const offTranscript = transcript ? subscribeTranscriptProjection(s5.bus, transcript) : () => {};
    step('transcript');
    undo.push(['transcript', () => {
        offTranscript();
        configureTranscriptProjection(null);
        s5.sessionRegistry.setTranscriptTopicRelease(null);
    }]);

    // 5. Transcript writer-gc (G2b) — bounds `full`-retention session
    // transcript topics locally (writer-gc.ts's header has the full account).
    tryStep('Seqscribe', 'transcript writer-gc', () => { configureTranscriptWriterGc(node); });
    step('transcript-writer-gc');
    undo.push(['transcript-writer-gc', () => { configureTranscriptWriterGc(null); }]);

    // 6. Define the events/handoff pair for meshes we already know, instead of
    // waiting for a local write — a consume-only node never makes one, and
    // without it `mutualFull` stays false and sync silently skips the topic.
    // ★ Not a tryStep (C7-1): the events topic is the ONLY mesh event path, so
    // a known mesh whose topic cannot be defined fails the boot loudly instead
    // of running with every mesh event silently unrecorded. The arm steps taken
    // so far are unwound first so the throw leaves no half-armed slot behind.
    try {
        const meshIds = listMeshesReadOnly().map((m) => m.id).filter(Boolean);
        const activated = activateMeshTopicsAtBoot(meshIds);
        if (activated > 0) {
            LOG.info('Seqscribe', `activated ${activated} known mesh topic scope(s) at boot — consumers converge without waiting for a local write`);
        }
    } catch (error) {
        LOG.error('Seqscribe', `mesh boot failure: ${error instanceof Error ? error.message : String(error)}`);
        for (const [, fn] of [...undo].reverse()) {
            try { fn(); } catch { /* noop — unwinding a failed boot */ }
        }
        throw error;
    }
    step('activate-topics');

    // 7. GC the retired durable cursors (each holds its topic's archive floor
    // open). Best-effort; runs before S7 registers the turn cursors, so no
    // prune can race a live registration.
    tryStep('Seqscribe', 'retired consumer prune', () => { pruneRetiredMeshConsumers(node); });
    step('prune-consumers');

    // No parity loop (C7-6): one write path, nothing to compare.
    rt.attachProjections({ transcript });
    undo.push(['attach', () => rt.attachProjections(null)]);

    let disarmed = false;
    return () => {
        if (disarmed) return;
        disarmed = true;
        for (const [name, fn] of undo.reverse()) {
            try { fn(); } catch { /* noop — disarm is best-effort, like shutdown today */ }
            hooks.onStep?.(`disarm:${name}`);
        }
    };
}
