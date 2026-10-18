/** Bounded capture retries, readability verdicts and content-free visibility notices. */
import type { AssistantRelayStore } from './assistant-relay-store.js';
import type { AuditedCoordinatorReply } from './assistant-native-window.js';
import type { ReportContinuation } from './report-continuation.js';
import { receiptKey, type RelayGapTracker } from './relay-gap-tracker.js';
import { RELAY_CAPTURE_BACKOFF_MS, RELAY_CAPTURE_BACKOFF_MAX_MS, RELAY_NATIVE_WAIT_MS,
    RELAY_NATIVE_GRACE_MS, RELAY_READABILITY_CACHE_MS, RELAY_UNREADABLE_HOLD_MS, RELAY_UNREADABLE_MAX_HELD,
    RELAY_UNREADABLE_MAX_ABANDONED } from './assistant-relay-format.js';

/** `undefined` from a probe means it could not answer (timeout/throw), which is not "unreadable". */
export type ReadabilityProbe = () => Promise<boolean | undefined>;
type Verdict = 'readable' | 'unreadable' | 'unknown';
interface CachedVerdict { at: number; v: Verdict; n?: number }
export interface GapResolution {
    readable: AuditedCoordinatorReply[];
    /** Unresolved replies that stay queued until readable or aged out. */
    pending: AuditedCoordinatorReply[];
}

const replyKey = (r: AuditedCoordinatorReply) => receiptKey(r.meshId, r.sessionId, r.messageId);

export class RelayDeliveryPolicy {
    private readonly probes = new Map<string, Promise<Verdict>>();
    private readonly abandoned = new Map<string, string>();
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
        this.store.writeReceipt(receiptKey('capture', id), JSON.stringify({ failures, nextAt: this.now() + this.backoff(failures) }), this.now(), 'capture');
    }
    private backoff(failures: number): number { return Math.min(RELAY_CAPTURE_BACKOFF_MAX_MS, RELAY_CAPTURE_BACKOFF_MS * 2 ** Math.min(20, failures - 1)); }

    /**
     * Definite answers are cached for RELAY_READABILITY_CACHE_MS. A probe that
     * timed out or threw is "unknown": it is never cached as unreadable and
     * is retried on the capture backoff.
     */
    private async verdict(reply: AuditedCoordinatorReply, probe: ReadabilityProbe): Promise<Verdict> {
        const key = receiptKey('readability', reply.meshId, reply.sessionId, reply.messageId);
        let cached: CachedVerdict | null = null;
        try { cached = JSON.parse(this.store.readReceipt(key, this.now()) ?? 'null') as CachedVerdict | null; } catch { /* re-probe */ }
        if (cached?.v) {
            const ttl = cached.v === 'unknown' ? this.backoff(cached.n ?? 1) : RELAY_READABILITY_CACHE_MS;
            if (this.now() - cached.at < ttl) return cached.v;
        }
        const pending = this.probes.get(key);
        if (pending) return pending;
        const run = Promise.resolve().then(probe).catch(() => undefined).then((answer): Verdict => {
            const v: Verdict = answer === undefined ? 'unknown' : answer ? 'readable' : 'unreadable';
            this.store.writeReceipt(key, JSON.stringify({ at: this.now(), v, ...(v === 'unknown' ? { n: (cached?.v === 'unknown' ? cached.n ?? 1 : 0) + 1 } : {}) }), this.now(), 'readability');
            return v;
        }).finally(() => this.probes.delete(key));
        this.probes.set(key, run);
        return run;
    }

    /** First time a reply was held back as not-yet-readable (durable, so a restart cannot extend the hold). */
    private heldSince(reply: AuditedCoordinatorReply, create: boolean): number | null {
        const key = receiptKey('unreadable-since', reply.meshId, reply.sessionId, reply.messageId);
        const stored = Number(this.store.readReceipt(key, this.now()));
        if (Number.isFinite(stored) && stored > 0) return stored;
        if (create) this.store.writeReceipt(key, String(this.now()), this.now(), 'readability');
        return create ? this.now() : null;
    }
    isHeld(reply: AuditedCoordinatorReply): boolean { return this.heldSince(reply, false) !== null; }

    /**
     * Split a gap notice's replies into readable-now and still-pending. Pending
     * replies are not announced and not marked notified: a later readable
     * verdict yields one actionable notice. Replies unreadable for longer than
     * RELAY_UNREADABLE_HOLD_MS (or beyond the per-notice cap) stop being watched
     * and are only counted.
     */
    async resolve(replies: readonly AuditedCoordinatorReply[], recipient: string | null, gaps: RelayGapTracker,
        covered: (r: AuditedCoordinatorReply) => boolean, probe: (r: AuditedCoordinatorReply) => ReadabilityProbe): Promise<GapResolution> {
        // A held reply keeps its own one-shot notice even when its attempt group was already announced.
        const open = (r: AuditedCoordinatorReply) => !covered(r) && !gaps.wasRead(r, recipient) && !gaps.replyNotified(r, recipient)
            && (!gaps.notified(r, recipient) || this.isHeld(r));
        const readable: AuditedCoordinatorReply[] = [];
        const pending: AuditedCoordinatorReply[] = [];
        for (const reply of replies.filter(open)) {
            const known = this.heldSince(reply, false);
            if (known !== null && this.now() - known >= RELAY_UNREADABLE_HOLD_MS) { this.abandon(reply); continue; }
            if (await this.verdict(reply, probe(reply)) === 'readable') readable.push(reply); else pending.push(reply);
        }
        // The probe awaited; the assistant may have read or been told about a reply meanwhile.
        const live = readable.filter(open);
        const keep = pending.filter(open);
        for (const reply of keep.slice(0, Math.max(0, keep.length - RELAY_UNREADABLE_MAX_HELD))) this.abandon(reply);
        const held = keep.slice(-RELAY_UNREADABLE_MAX_HELD);
        for (const reply of held) this.heldSince(reply, true);
        return { readable: live, pending: held };
    }

    private abandon(reply: AuditedCoordinatorReply): void {
        const key = replyKey(reply);
        this.abandoned.delete(key);
        this.abandoned.set(key, reply.meshId ?? '');
        while (this.abandoned.size > RELAY_UNREADABLE_MAX_ABANDONED) this.abandoned.delete(this.abandoned.keys().next().value!);
    }

    /** Held and abandoned unreadable replies per mesh, for the cumulative counter and project_status. */
    unreadableByMesh(held: readonly AuditedCoordinatorReply[], meshOf: (r: AuditedCoordinatorReply) => string | null): Map<string, number> {
        const out = new Map<string, number>();
        const seen = new Set<string>();
        const add = (key: string, mesh: string | null) => {
            if (!mesh || seen.has(key)) return;
            seen.add(key); out.set(mesh, (out.get(mesh) ?? 0) + 1);
        };
        for (const [key, mesh] of this.abandoned) add(key, mesh);
        for (const reply of held) if (this.isHeld(reply)) add(replyKey(reply), meshOf(reply));
        return out;
    }
}

export function unavailableReportNotice(count: number, project: string, cursor: ReportContinuation | null): string {
    const status = `[ADHDev relay gap] ${count} coordinator ${count === 1 ? 'report could' : 'reports could'} not be captured in full: native transcript unavailable after the capture grace. No partial envelope was delivered.`;
    return cursor ? `${status} Inspect the latest readable coordinator context (not a verified report for this attempt) with project_read ${JSON.stringify({ project, ...cursor })}.`
        : `${status} No readable coordinator message is available; ${count} ${count === 1 ? 'report could' : 'reports could'} not be read. Check project_status ${JSON.stringify({ project })}.`;
}
