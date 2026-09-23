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
 *   2. mesh read model — registers no consumer until a mesh is first queried.
 *   3. fleet.status shadow, then 4. fleet.status parity (only arms over an
 *      active shadow).
 *   5. transcript projection + its bus subscriber (+ the registry's claim release).
 *   6. activate known mesh topics — needs the armed publisher node. NOT a
 *      tryStep: a known mesh whose events topic cannot be defined is a mesh
 *      boot failure (C7-1), so the error propagates out of the stage.
 *   7. prune stale durable consumers.
 *   8. terminal redrive — after the prune, so registration never races the GC.
 *
 * The mesh parity loop (old step 9) is no longer armed: with one write path
 * there is no second store to compare (C7-6); its module is a C-W3 deletion.
 */

import { LOG } from '../../logging/logger.js';
import { listMeshesReadOnly } from '../../config/mesh-config.js';
import { resolveJsonlSourcePath } from '../../providers/spec/native-history-executor.js';
import { activateMeshTopicsAtBoot, configureMeshPublisher } from '../../seqscribe/mesh-publisher.js';
import { configureMeshReadModel, pruneStaleConsumersAtBoot } from '../../seqscribe/mesh-read-model.js';
import { configureFleetStatusShadow } from '../../seqscribe/fleet-status-shadow.js';
import { configureFleetStatusParity } from '../../seqscribe/fleet-status-parity.js';
import { configureTranscriptProjection } from '../../seqscribe/transcript-publisher.js';
import { createLiveTranscriptPublisher } from '../../seqscribe/transcript-publish-runtime.js';
import { releaseSessionTranscriptTopic } from '../../seqscribe/transcript-activation.js';
import { subscribeTranscriptProjection } from '../../seqscribe/transcript-bus-subscriber.js';
import { configureTerminalRedrive, ensureTerminalRedriveConsumersAtBoot } from '../../seqscribe/mesh-terminal-redrive-consumer.js';
import { bindSeqscribeRuntime } from '../../seqscribe/runtime-slot.js';
import type { SeqscribeRuntime } from '../../seqscribe/runtime.js';
import {
    REDRIVE_CONSUMER,
    REDRIVE_ENV,
    consumeRedriveEntry,
    isTerminalRedriveEnabled,
} from '../../mesh/mesh-terminal-redrive.js';
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

    // 1–4. Mesh publisher, read model, fleet.status shadow + parity.
    tryStep('Seqscribe', 'mesh publisher', () => configureMeshPublisher(node));
    step('publisher');
    undo.push(['publisher', () => configureMeshPublisher(null)]);
    tryStep('Seqscribe', 'mesh read model', () => configureMeshReadModel(node));
    step('read-model');
    undo.push(['read-model', () => configureMeshReadModel(null)]);
    tryStep('Seqscribe', 'fleet.status shadow', () => configureFleetStatusShadow(node));
    step('fleet-shadow');
    undo.push(['fleet-shadow', () => configureFleetStatusShadow(null)]);
    tryStep('Seqscribe', 'fleet.status parity', () => { configureFleetStatusParity(node); });
    step('fleet-parity');
    undo.push(['fleet-parity', () => { configureFleetStatusParity(null); }]);

    // 5. Transcript projection (§8 unit 3). Releasing the in-memory claim on
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

    // 7. GC durable cursors older builds left behind (each holds a topic's
    // archive floor open). Best-effort by construction.
    tryStep('Seqscribe', 'stale consumer prune', () => pruneStaleConsumersAtBoot());
    step('prune-consumers');

    // 8. Terminal-notification redrive — the SOLE re-arm path for
    // coordinator-bound terminal notifications since Stage 5c-1 removed the turn
    // outbox; `=off` is a kill switch, not a rollback.
    tryStep('MeshRedrive', 'terminal redrive', () => {
        if (isTerminalRedriveEnabled(process.env)) {
            configureTerminalRedrive(node, {
                consumerName: REDRIVE_CONSUMER,
                // Throwing holds the durable cursor; resolving advances it.
                handler: ({ meshId, entry }) => { consumeRedriveEntry(meshId, entry); },
            });
            const registered = ensureTerminalRedriveConsumersAtBoot();
            LOG.info('MeshRedrive', `terminal redrive armed on ${registered} mesh topic(s) — sole terminal-notification re-arm path`);
        } else {
            LOG.warn(
                'MeshRedrive',
                `terminal redrive DISABLED by ${REDRIVE_ENV}=off — no terminal-notification `
                + 're-arm backstop exists on this daemon (the turn outbox it replaced was removed '
                + 'in Stage 5c-1). Completions lost between the reducer commit and the pending '
                + 'queue will not be recovered.',
            );
        }
    });
    step('terminal-redrive');
    // Unsubscribes the registrations; durable cursors persist so the next boot resumes.
    undo.push(['terminal-redrive', () => configureTerminalRedrive(null)]);

    // No parity loop (C7-6): one write path, nothing to compare.
    rt.attachProjections({ transcript, parityLoop: null });
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
