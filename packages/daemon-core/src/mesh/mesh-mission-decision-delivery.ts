/**
 * Coordinator delivery of owner-decision answers (design 2026-10-28 §6.3, §6.4).
 *
 * An answer write (mesh-mission-decisions.ts) arms `decision.delivery` as
 * `{ messageId: decision:<itemId>:r<revision>, state: 'pending', kind }`. This
 * module turns a pending delivery into ONE message to the mesh's coordinator:
 *
 *   [owner decision <itemId>] <question> → <answer>
 *   [owner decision changed <itemId>] → <new answer>
 *   [owner decision undone <itemId>]
 *
 * Exactly-once comes from three layers: (1) the persisted delivery state — a
 * `sent` revision is never re-sent; (2) the stable per-revision messageId, so
 * the coordinator send funnel (`send_chat` messageId dedupe) answers
 * `duplicate` for a retry that raced a crash between "sent" and "marked sent";
 * (3) an in-process single-flight guard. A failed send leaves the delivery
 * `pending` (surfaced as "delivery pending" to the owner) and the housekeeping
 * tick retries it after {@link DECISION_DELIVERY_RETRY_MS}.
 *
 * The transport is an injected {@link DecisionSender}; the default one reuses
 * the assistant's `project_send` local path (ensure coordinator → queued
 * `send_chat`), i.e. "launch or queue" exactly as an owner message would.
 */
import type { MissionDecision, MissionDecisionDelivery } from '@adhdev/mesh-shared';
import { truncateMissionText } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { getMesh } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { describeDecisionAnswer, processDecisionDeadlines } from './mesh-mission-decisions.js';
import { notifyMissionChanged } from './mesh-mission-change-notifier.js';

/** Minimum gap between delivery attempts of one pending revision (the tick itself runs every few seconds). */
export const DECISION_DELIVERY_RETRY_MS = 15_000;
/** A decision question echoed to the coordinator is clamped (it already has the full text in its mission section). */
const QUESTION_ECHO_MAX = 200;

export interface DecisionSendRequest {
    meshId: string;
    text: string;
    /** Stable per answer revision — the funnel's dedupe key. */
    messageId: string;
}
export type DecisionSendResult = { ok: true; duplicate?: boolean } | { ok: false; code: string; error: string };
export type DecisionSender = (req: DecisionSendRequest) => Promise<DecisionSendResult>;

/** The text the coordinator receives for the decision's current pending delivery. */
export function formatDecisionDelivery(itemId: string, d: MissionDecision): string {
    const kind = d.delivery?.kind ?? 'answered';
    if (kind === 'undone') return `[owner decision undone ${itemId}]`;
    const answer = describeDecisionAnswer(d);
    const auto = d.answer?.by === 'auto_recommended' ? ' (auto-applied: the deadline passed, recommended option)' : '';
    if (kind === 'changed') return `[owner decision changed ${itemId}] → ${answer}${auto}`;
    return `[owner decision ${itemId}] ${truncateMissionText(d.question, QUESTION_ECHO_MAX)} → ${answer}${auto}`;
}

const inFlight = new Set<string>();

export type DeliveryAttempt = 'sent' | 'duplicate' | 'failed' | 'skipped';

/** Try to deliver one decision's pending revision. Never throws. */
export async function deliverDecisionAnswer(
    meshId: string,
    itemId: string,
    send: DecisionSender,
    opts?: { nowMs?: number; respectRetryDelay?: boolean },
): Promise<DeliveryAttempt> {
    const nowMs = opts?.nowMs ?? Date.now();
    const items = MeshRuntimeStore.getInstance().missionItems();
    const item = items.getItem(meshId, itemId);
    const d = item?.decision;
    const delivery = d?.delivery;
    if (!item || !d || !delivery || delivery.state !== 'pending') return 'skipped';
    if (opts?.respectRetryDelay && delivery.lastAttemptAt && nowMs - Date.parse(delivery.lastAttemptAt) < DECISION_DELIVERY_RETRY_MS) return 'skipped';
    const messageId = delivery.messageId;
    if (inFlight.has(messageId)) return 'skipped';
    inFlight.add(messageId);
    try {
        const text = formatDecisionDelivery(item.id, d);
        let result: DecisionSendResult;
        try {
            result = await send({ meshId, text, messageId });
        } catch (e: any) {
            result = { ok: false, code: 'send_threw', error: e?.message || String(e) };
        }
        // Re-read: the owner may have changed/undone the answer while the send was in flight.
        const fresh = items.getItem(meshId, itemId);
        const fd = fresh?.decision;
        if (!fresh || !fd?.delivery || fd.delivery.messageId !== messageId) {
            return result.ok ? (result.duplicate ? 'duplicate' : 'sent') : 'failed';
        }
        const attemptIso = new Date(nowMs).toISOString();
        const next: MissionDecisionDelivery = result.ok
            ? { ...fd.delivery, state: 'sent', lastAttemptAt: attemptIso }
            : { ...fd.delivery, state: 'pending', lastAttemptAt: attemptIso };
        items.updateItem(meshId, itemId, { decision: { ...fd, delivery: next } });
        if (!result.ok) LOG.warn('MissionDecision', `delivery of ${messageId} to mesh ${meshId} failed (${result.code}): ${result.error} — will retry`);
        notifyMissionChanged(meshId);
        return result.ok ? (result.duplicate ? 'duplicate' : 'sent') : 'failed';
    } finally {
        inFlight.delete(messageId);
    }
}

/** Items of a mesh whose delivery is pending (oldest first). */
export function pendingDecisionDeliveries(meshId: string): string[] {
    return MeshRuntimeStore.getInstance().missionItems()
        .listByKindStates(meshId, 'decision', ['open', 'answered'])
        .filter(i => i.decision?.delivery?.state === 'pending')
        .map(i => i.id);
}

/**
 * The default sender: the assistant's `project_send` local path — ensure a
 * coordinator on this (host) daemon, then a queued `send_chat` with the stable
 * messageId. A mesh not hosted here is a failure (the answer lives on the host).
 */
export function createCoordinatorDecisionSender(getPorts: () => Promise<import('../assistant/assistant-project-ports.js').AssistantProjectPorts>): DecisionSender {
    return async ({ meshId, text, messageId }) => {
        const mesh = getMesh(meshId);
        if (!mesh) return { ok: false, code: 'mesh_not_hosted', error: `mesh ${meshId} is not configured on this daemon` };
        const { localProjectSend } = await import('../commands/high-family/assistant.js');
        const sent = await localProjectSend(await getPorts(), mesh, text, messageId);
        if (!sent.ok) return { ok: false, code: sent.code, error: sent.error };
        return { ok: true, ...(sent.status === 'duplicate' ? { duplicate: true } : {}) };
    };
}

/** Sender bound to a running daemon's components (the housekeeping tick). */
export function componentsDecisionSender(components: DaemonComponents): DecisionSender {
    return createCoordinatorDecisionSender(async () => {
        const router = components.router;
        if (!router) throw new Error('command router not ready');
        const { getAssistantProjectPorts } = await import('../assistant/assistant-project-ports.js');
        const selfDaemonId = typeof (router as any).deps?.statusInstanceId === 'string' ? (router as any).deps.statusInstanceId.trim() : '';
        return getAssistantProjectPorts({
            components: () => components,
            execute: (cmd, args) => router.execute(cmd, args, 'ipc', { inProcess: true }),
            selfDaemonId,
            transport: {
                ...((router as any).deps?.dispatchMeshCommand ? { dispatch: (router as any).deps.dispatchMeshCommand } : {}),
                ...((router as any).deps?.getMeshPeerConnectionStatus ? { peerStatus: (router as any).deps.getMeshPeerConnectionStatus } : {}),
            },
        });
    });
}

/**
 * One housekeeping pass for a hosted mesh: deadlines first (an auto-applied
 * answer arms a delivery), then every pending delivery (retry-throttled).
 * Cheap when idle: two indexed reads of the mesh's decision items.
 */
export async function runDecisionTick(meshId: string, send: DecisionSender, nowMs: number = Date.now()): Promise<{ autoApplied: number; delivered: number; failed: number }> {
    const out = { autoApplied: 0, delivered: 0, failed: 0 };
    try {
        out.autoApplied = processDecisionDeadlines(meshId, nowMs).autoApplied.length;
        for (const itemId of pendingDecisionDeliveries(meshId)) {
            const r = await deliverDecisionAnswer(meshId, itemId, send, { nowMs, respectRetryDelay: true });
            if (r === 'sent' || r === 'duplicate') out.delivered++;
            else if (r === 'failed') out.failed++;
        }
    } catch (e: any) {
        LOG.warn('MissionDecision', `decision tick failed for mesh ${meshId}: ${e?.message || e}`);
    }
    return out;
}
