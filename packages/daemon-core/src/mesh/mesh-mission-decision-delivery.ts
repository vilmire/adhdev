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
 * Delivery is at-least-once, never lost, and normally exactly once: (1) the
 * persisted delivery state — a `sent` revision is never re-sent; (2) a stable
 * per-attempt messageId, so the coordinator send funnel (`send_chat` messageId
 * dedupe) answers `duplicate` for a retry that raced a crash between "sent" and
 * "marked sent"; (3) an in-process single-flight guard. A failed send leaves the
 * delivery `pending` and the housekeeping tick retries it with backoff.
 *
 * A send the coordinator's input queue only ACCEPTED (it was busy / starting)
 * is `queued`, not `sent`: that queue lives in the daemon process, so a restart
 * drops it, and the funnel then reports the receipt `uncertain` and refuses the
 * same messageId as a duplicate — yet the session host may also restore that
 * queue and type the message later, so `uncertain` alone means "unknown". The
 * tick reads the receipt: `submitted` → `sent`; still `accepted` → wait;
 * otherwise it reads the coordinator transcript: the text is there → `sent`;
 * the coordinator is still busy (a restored queue drains when it goes idle) →
 * wait; idle and absent → lost, re-armed under a NEW attempt messageId
 * (`…:a<n>`). Losing an owner's answer is worse than a rare repeated notice.
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
/** Backoff ceiling: an undeliverable answer (no node, no launch default…) is retried at most this often. */
export const DECISION_DELIVERY_RETRY_MAX_MS = 10 * 60_000;

/** Gap before the next attempt after `attempts` failures: 15s, 30s, 1m, … capped at 10m. */
export function decisionRetryDelayMs(attempts: number): number {
    const n = Math.max(0, Math.min(attempts - 1, 16));
    return Math.min(DECISION_DELIVERY_RETRY_MS * 2 ** n, DECISION_DELIVERY_RETRY_MAX_MS);
}
/** A decision question echoed to the coordinator is clamped (it already has the full text in its mission section). */
const QUESTION_ECHO_MAX = 200;

export interface DecisionSendRequest {
    meshId: string;
    text: string;
    /** Stable per answer revision — the funnel's dedupe key. */
    messageId: string;
}
export type DecisionSendResult =
    | { ok: true; duplicate?: boolean; /** accepted into the coordinator's input queue, not typed yet */ queued?: boolean; sessionId?: string; wireMessageId?: string }
    | { ok: false; code: string; error: string };
export type DecisionSender = (req: DecisionSendRequest) => Promise<DecisionSendResult>;
/**
 * Fate of a queued delivery: `submitted` (receipt) / `seen` (its text is in the coordinator
 * transcript) = delivered; `accepted` (still queued) / `busy` (receipt unknown, coordinator not
 * idle yet) = wait; `lost` (receipt unknown, coordinator idle, text absent) = re-send.
 */
export type DecisionReceiptState = 'submitted' | 'seen' | 'accepted' | 'busy' | 'lost';
export type DecisionReceiptChecker = (sessionId: string, wireMessageId: string, text: string) => Promise<DecisionReceiptState>;

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

export type DeliveryAttempt = 'sent' | 'queued' | 'duplicate' | 'failed' | 'skipped';

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
    if (opts?.respectRetryDelay && delivery.lastAttemptAt && nowMs - Date.parse(delivery.lastAttemptAt) < decisionRetryDelayMs(delivery.attempts ?? 1)) return 'skipped';
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
        const attempts = (fd.delivery.attempts ?? 0) + 1;
        const confirmLater = result.ok && (result.queued || result.duplicate) && !!result.sessionId && !!result.wireMessageId;
        const next: MissionDecisionDelivery = !result.ok
            ? { ...fd.delivery, state: 'pending', lastAttemptAt: attemptIso, attempts }
            : confirmLater
                ? { ...fd.delivery, state: 'queued', lastAttemptAt: attemptIso, sessionId: result.sessionId, wireMessageId: result.wireMessageId }
                : { ...fd.delivery, state: 'sent', lastAttemptAt: attemptIso };
        items.updateItem(meshId, itemId, { decision: { ...fd, delivery: next } });
        if (!result.ok) {
            // Warn on the first failure and then sparsely; the backoff keeps retrying quietly.
            const line = `delivery of ${messageId} to mesh ${meshId} failed (${result.code}, attempt ${attempts}): ${result.error} — will retry in ${Math.round(decisionRetryDelayMs(attempts) / 1000)}s`;
            if (attempts === 1 || attempts % 10 === 0) LOG.warn('MissionDecision', line);
            else LOG.debug('MissionDecision', line);
        }
        notifyMissionChanged(meshId);
        return !result.ok ? 'failed' : confirmLater ? 'queued' : result.duplicate ? 'duplicate' : 'sent';
    } finally {
        inFlight.delete(messageId);
    }
}

/** Items of a mesh whose delivery is pending (oldest first). */
export function pendingDecisionDeliveries(meshId: string): string[] {
    return deliveriesInState(meshId, 'pending');
}

function deliveriesInState(meshId: string, state: MissionDecisionDelivery['state']): string[] {
    return MeshRuntimeStore.getInstance().missionItems()
        .listByKindStates(meshId, 'decision', ['open', 'answered'])
        .filter(i => i.decision?.delivery?.state === state)
        .map(i => i.id);
}

/** The attempt-scoped messageId: the revision id, then `…:a2`, `…:a3` for re-sends of a lost queued attempt. */
function nextAttemptMessageId(messageId: string): string {
    const m = /^(.*):a(\d+)$/.exec(messageId);
    return m ? `${m[1]}:a${Number(m[2]) + 1}` : `${messageId}:a2`;
}

/**
 * Confirm a `queued` delivery against the coordinator send receipt. `submitted` → `sent`;
 * still `accepted` → keep waiting; `uncertain`/`failed`/`missing` (the queue was dropped,
 * e.g. by a daemon restart) → re-arm `pending` under a new attempt messageId. Never throws.
 */
export async function confirmQueuedDecision(meshId: string, itemId: string, check: DecisionReceiptChecker): Promise<'sent' | 'waiting' | 'rearmed' | 'skipped'> {
    const items = MeshRuntimeStore.getInstance().missionItems();
    const d = items.getItem(meshId, itemId)?.decision;
    const dl = d?.delivery;
    if (!d || !dl || dl.state !== 'queued' || !dl.sessionId || !dl.wireMessageId) return 'skipped';
    let state: DecisionReceiptState;
    try { state = await check(dl.sessionId, dl.wireMessageId, formatDecisionDelivery(itemId, d)); }
    catch (e: any) { LOG.debug('MissionDecision', `receipt check for ${dl.messageId} failed: ${e?.message || e}`); return 'waiting'; }
    if (state === 'accepted' || state === 'busy') return 'waiting';
    const fresh = items.getItem(meshId, itemId)?.decision;
    if (!fresh?.delivery || fresh.delivery.messageId !== dl.messageId || fresh.delivery.state !== 'queued') return 'skipped';
    // Re-arm sends at once: drop the receipt ids and the attempt time that would hold the retry back.
    const { sessionId: _s, wireMessageId: _w, lastAttemptAt: _t, ...base } = fresh.delivery;
    const delivered = state === 'submitted' || state === 'seen';
    const next: MissionDecisionDelivery = delivered
        ? { ...fresh.delivery, state: 'sent' }
        : { ...base, state: 'pending', messageId: nextAttemptMessageId(dl.messageId) };
    items.updateItem(meshId, itemId, { decision: { ...fresh, delivery: next } });
    if (!delivered) LOG.warn('MissionDecision', `queued delivery ${dl.messageId} never reached the coordinator (its queue was dropped) — re-sending as ${next.messageId}`);
    notifyMissionChanged(meshId);
    return delivered ? 'sent' : 'rearmed';
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
        return {
            ok: true,
            ...(sent.status === 'duplicate' ? { duplicate: true } : {}),
            ...(sent.status === 'queued' ? { queued: true } : {}),
            ...(sent.coordinatorSessionId ? { sessionId: sent.coordinatorSessionId } : {}),
            ...(sent.messageId ? { wireMessageId: sent.messageId } : {}),
        };
    };
}

/** Messages of the coordinator transcript scanned for a delivery whose receipt is unknown. */
const TRANSCRIPT_SCAN_LIMIT = 80;

/**
 * Checker over `outgoing_receipts` (same routing as `send_chat`), falling back to the
 * coordinator transcript (`read_chat`) when the receipt cannot say.
 */
export function createDecisionReceiptChecker(getPorts: () => Promise<import('../assistant/assistant-project-ports.js').AssistantProjectPorts>): DecisionReceiptChecker {
    return async (sessionId, wireMessageId, text) => {
        const ports = await getPorts();
        const out: any = await ports.execute('outgoing_receipts', { targetSessionId: sessionId, messageIds: [wireMessageId] });
        if (!out?.success) throw new Error(out?.error || 'outgoing_receipts failed');
        const receipt = Array.isArray(out.receipts) ? out.receipts.find((r: any) => r?.messageId === wireMessageId) : undefined;
        if (receipt?.state === 'submitted') return 'submitted';
        if (receipt?.state === 'accepted') return 'accepted';
        const chat: any = await ports.execute('read_chat', { targetSessionId: sessionId, limit: TRANSCRIPT_SCAN_LIMIT });
        if (!chat?.success) throw new Error(chat?.error || 'read_chat failed');
        const messages: any[] = Array.isArray(chat.messages) ? chat.messages : [];
        const needle = text.trim();
        const seen = messages.some(m => m?.role === 'user' && (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).includes(needle));
        if (seen) return 'seen';
        return chat.status === 'idle' ? 'lost' : 'busy';
    };
}

/** Sender + receipt checker bound to a running daemon's components (the housekeeping tick). */
export function componentsDecisionTransport(components: DaemonComponents): { send: DecisionSender; check: DecisionReceiptChecker } {
    const getPorts = async () => {
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
    };
    return { send: createCoordinatorDecisionSender(getPorts), check: createDecisionReceiptChecker(getPorts) };
}

/**
 * One housekeeping pass for a hosted mesh: deadlines first (an auto-applied
 * answer arms a delivery), then every pending delivery (retry-throttled).
 * Cheap when idle: two indexed reads of the mesh's decision items.
 */
export async function runDecisionTick(meshId: string, send: DecisionSender, nowMs: number = Date.now(), check?: DecisionReceiptChecker): Promise<{ autoApplied: number; delivered: number; failed: number }> {
    const out = { autoApplied: 0, delivered: 0, failed: 0 };
    try {
        out.autoApplied = processDecisionDeadlines(meshId, nowMs).autoApplied.length;
        // Queued attempts first: a dropped one is re-armed and goes out in the same pass.
        if (check) for (const itemId of deliveriesInState(meshId, 'queued')) await confirmQueuedDecision(meshId, itemId, check);
        for (const itemId of pendingDecisionDeliveries(meshId)) {
            const r = await deliverDecisionAnswer(meshId, itemId, send, { nowMs, respectRetryDelay: true });
            if (r === 'sent' || r === 'queued' || r === 'duplicate') out.delivered++;
            else if (r === 'failed') out.failed++;
        }
    } catch (e: any) {
        LOG.warn('MissionDecision', `decision tick failed for mesh ${meshId}: ${e?.message || e}`);
    }
    return out;
}
