/** Bounded capture retries and content-free visibility notices. */
import type { AssistantRelayStore } from './assistant-relay-store.js';
import type { AuditedCoordinatorReply } from './assistant-native-window.js';
import type { ReportContinuation } from './report-continuation.js';
import { receiptKey } from './relay-gap-tracker.js';
import { RELAY_CAPTURE_BACKOFF_MS, RELAY_CAPTURE_BACKOFF_MAX_MS, RELAY_NATIVE_WAIT_MS,
    RELAY_NATIVE_GRACE_MS, RELAY_READABILITY_CACHE_MS } from './assistant-relay-format.js';

export class RelayDeliveryPolicy {
    private readonly probes = new Map<string, Promise<boolean>>();
    constructor(private readonly store: AssistantRelayStore, private readonly now: () => number) {}

    expired(committedAt: number): boolean { return this.now() >= committedAt + RELAY_NATIVE_WAIT_MS + RELAY_NATIVE_GRACE_MS; }
    private retry(id: string): { failures: number; nextAt: number } {
        try { return JSON.parse(this.store.readReceipt(receiptKey('capture', id), this.now()) ?? 'null') ?? { failures: 0, nextAt: 0 }; }
        catch { return { failures: 0, nextAt: 0 }; }
    }
    due(id: string): boolean { return this.now() >= this.retry(id).nextAt; }
    initial(id: string): boolean { return this.retry(id).failures === 0; }
    failed(id: string): void {
        const failures = this.retry(id).failures + 1;
        const nextAt = this.now() + Math.min(RELAY_CAPTURE_BACKOFF_MAX_MS, RELAY_CAPTURE_BACKOFF_MS * 2 ** Math.min(20, failures - 1));
        this.store.writeReceipt(receiptKey('capture', id), JSON.stringify({ failures, nextAt }), this.now(), 'capture');
    }

    /** Cache successes and failures, including bounded probe timeouts. */
    readable(reply: AuditedCoordinatorReply, probe: () => Promise<boolean>): Promise<boolean> {
        const key = receiptKey('readability', reply.meshId, reply.sessionId, reply.messageId);
        const cached = this.store.readReceipt(key, this.now());
        if (cached) {
            const verdict = JSON.parse(cached) as { at: number; readable: boolean };
            if (this.now() - verdict.at < RELAY_READABILITY_CACHE_MS) return Promise.resolve(verdict.readable);
        }
        const pending = this.probes.get(key);
        if (pending) return pending;
        const run = Promise.resolve().then(probe).catch(() => false).then(readable => {
            this.store.writeReceipt(key, JSON.stringify({ at: this.now(), readable }), this.now(), 'readability');
            return readable;
        }).finally(() => this.probes.delete(key));
        this.probes.set(key, run);
        return run;
    }
}

export function unavailableReportNotice(count: number, project: string, cursor: ReportContinuation | null): string {
    const status = `[ADHDev relay gap] ${count} coordinator ${count === 1 ? 'report could' : 'reports could'} not be captured in full: native transcript unavailable after the capture grace. No partial envelope was delivered.`;
    return cursor ? `${status} Inspect the latest readable coordinator context (not a verified report for this attempt) with project_read ${JSON.stringify({ project, ...cursor })}.`
        : `${status} No readable coordinator message is available; ${count} ${count === 1 ? 'report could' : 'reports could'} not be read. Check project_status ${JSON.stringify({ project })}.`;
}

export function unreadableReplyNotice(count: number): string {
    return `[ADHDev relay gap] ${count} coordinator ${count === 1 ? 'reply could' : 'replies could'} not be read. No readable message cursor is available for these replies; inspect project_status for the coordinator state.`;
}
