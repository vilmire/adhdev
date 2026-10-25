/** Content-free read and notice receipts. Never persist coordinator text. */
import { createHash } from 'node:crypto';
import type { AssistantRelayStore } from './assistant-relay-store.js';
import type { AuditedCoordinatorReply } from './assistant-native-window.js';

export const receiptKey = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const gapGroup = (reply: AuditedCoordinatorReply): string => receiptKey('gap', reply.sessionId,
    reply.nativeTurnProof ? [reply.nativeTurnProof.nativeSessionId, reply.nativeTurnProof.turnId, reply.messageId]
        : reply.attemptId ?? Math.floor(reply.messageAt / 60_000));

export class RelayGapTracker {
    constructor(private readonly store: AssistantRelayStore, private readonly now: () => number) {}

    notified(reply: AuditedCoordinatorReply, recipient: string | null): boolean {
        return this.store.readReceipt(receiptKey(recipient, gapGroup(reply)), this.now()) !== null;
    }
    markNotified(reply: AuditedCoordinatorReply, recipient: string | null): void {
        this.store.writeReceipt(receiptKey(recipient, gapGroup(reply)), '1', this.now(), 'notice');
    }
    /** Exact-reply notice receipt: a held unreadable reply is announced once, even after its group was. */
    replyNotified(reply: AuditedCoordinatorReply, recipient: string | null): boolean {
        return this.store.readReceipt(receiptKey('notified-reply', recipient, reply.sessionId, reply.messageId), this.now()) !== null;
    }
    markReplyNotified(reply: AuditedCoordinatorReply, recipient: string | null): void {
        this.store.writeReceipt(receiptKey('notified-reply', recipient, reply.sessionId, reply.messageId), '1', this.now(), 'notice');
    }
    wasRead(reply: AuditedCoordinatorReply, recipient: string | null): boolean {
        return (!!reply.messageId && this.store.readReceipt(receiptKey('read', recipient, reply.sessionId, reply.messageId), this.now()) === 'full')
            || (!!reply.attemptId && !!reply.attemptReportId
                && this.store.readReceipt(receiptKey('read', recipient, reply.sessionId, reply.attemptId, reply.attemptReportId), this.now()) === 'full');
    }

    /** Called only for successful project_read results returned to the assistant. */
    recordRead(result: Record<string, any>, recipient: string | null): void {
        const session = result.coordinatorSessionId;
        if (typeof session !== 'string' || result.success === false || result.sourceComplete === false) return;
        const pages = Array.isArray(result.messages) ? result.messages : [result];
        for (const page of pages) {
            if (page.role !== undefined && page.role !== 'assistant' && page.role !== 'agent') continue;
            if (page.kind !== undefined && page.kind !== 'standard') continue;
            const id = page.attemptId ?? page.messageId;
            if (typeof id !== 'string' || typeof page.text !== 'string' || !Number.isSafeInteger(page.totalChars)
                || page.totalChars < 0 || page.sourceComplete === false) continue;
            const key = page.attemptId
                ? receiptKey('read', recipient, session, id, page.reportId)
                : receiptKey('read', recipient, session, id);
            const previous = this.store.readReceipt(key, this.now());
            if (previous === 'full') continue;

            // Keep only the contiguous prefix: reading the last page alone does
            // not acknowledge an unread middle. A changed reportId resets it.
            let old: { end: number; reportId?: string } = { end: 0 };
            try { if (previous) old = JSON.parse(previous); } catch { /* no receipt */ }
            const identity = page.reportId ?? id;
            if (old.reportId !== identity) old = { end: 0, reportId: identity };
            const offset = page.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > old.end) continue;
            const end = Math.max(old.end, Math.min(page.totalChars, (Number.isSafeInteger(page.nextOffset) ? page.nextOffset : offset + page.text.length)));
            const full = end === page.totalChars && page.complete === true;
            this.store.writeReceipt(key, full ? 'full' : JSON.stringify({ end, reportId: identity }), this.now(), 'read');

        }
    }
}

/** Every emitted pointer uses the same content-bound cursor as project_read. */
export function buildReadableReplyGap(replies: readonly AuditedCoordinatorReply[], project: string): string {
    const last = replies.at(-1)!;
    const klass = !last.attemptId ? 'no_attempt' : last.restartClosed ? 'restart_closed' : 'inside_attempt';
    const target = { project, coordinatorSessionId: last.sessionId, messageId: last.messageId, offset: 0 };
    return `[ADHDev relay gap] ${replies.length} coordinator ${replies.length === 1 ? 'reply was' : 'replies were'} not relayed in full (${klass}); latest at ${new Date(last.messageAt).toISOString().slice(11, 19)} UTC. `
        + `Read the available message with project_read ${JSON.stringify(target)}.`;
}
