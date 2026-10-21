/**
 * Relay thread/row store port (design 2026-10-07-assistant-layer.md §4.6:
 * `assistant_threads`, `assistant_relays`, and bounded local attempt bodies).
 *
 * The durable implementation is `SqliteAssistantRelayStore`
 * (assistant-relay-sqlite-store.ts, tables in `mesh-runtime.db`).
 * `InMemoryAssistantRelayStore` implements the same port for tests and as the
 * fallback when the runtime store cannot open; it loses rows on restart.
 */

export type AssistantRelayKind = 'relay';

export interface AssistantThreadRow {
    meshId: string;
    openedAt: number;
    lastSendAt: number;
    closedAt: number | null;
    /**
     * When the stall notice went out for the current quiet stretch. Persisted so
     * a daemon restart does not re-send it; absent until the first notice.
     */
    stallNotifiedAt?: number;
    /** Durable remote poll high-water attemptId cursor (survives daemon restarts). */
    lastCursor?: string | null;
    /** Durable remote coordinator session id (detects coordinator session replacement). */
    coordinatorSessionId?: string | null;
}

export interface AssistantRelayRow {
    attemptId: string;
    meshId: string;
    coordinatorSessionId: string;
    committedAt: number;
    /** The row left the queue (settled) — NOT a promise that its body was sent. */
    deliveredAt: number | null;
    /**
     * This row's OWN body reached the assistant. Null while `deliveredAt` is
     * set means the row was folded into another turn's envelope and its body
     * never went out — see `countUnrendered`.
     */
    relayedAt: number | null;
    kind: AssistantRelayKind;
    /** Outcome enum of the commit (content-free). */
    outcome: string;
}

/** Relay rows that settled without their own body being sent (per project). */
export interface UnrenderedRelayCounts {
    /** Total across every mesh. */
    total: number;
    /** meshId → count, descending by count. Ids only, never a body. */
    byMesh: Array<{ meshId: string; count: number }>;
}

export interface AssistantRelayStore {
    /** `project_send` opens (or refreshes) the project's thread. */
    openThread(meshId: string, at: number): void;
    closeThread(meshId: string, at: number): void;
    isThreadOpen(meshId: string): boolean;
    openThreads(): AssistantThreadRow[];
    /** Record that the stall notice for the thread's current quiet stretch went out. */
    markStallNotified(meshId: string, at: number): void;
    /** Persist remote high-water cursor and coordinatorSessionId on the thread row. */
    setThreadCursor?(meshId: string, cursor: string | null, coordinatorSessionId?: string | null): void;
    /** Insert a committed coordinator attempt. False when the attempt is already recorded (dedupe). */
    recordCommitted(row: Omit<AssistantRelayRow, 'deliveredAt' | 'relayedAt'>): boolean;
    /**
     * Settle rows that left the queue. `rendered` is the subset whose own body
     * went out in the envelope; the rest settle unrendered and are counted by
     * `countUnrendered`. Pass the same list twice when every row was rendered.
     */
    markDelivered(attemptIds: readonly string[], at: number, rendered?: readonly string[], coverage?: readonly RenderedAttemptCoverage[]): void;
    /** Complete manifests of actual rendered parts, not the captured report. */
    listDeliveredCoverage(now: number): StoredAttemptCoverage[];
    /** Undelivered rows, oldest commit first. */
    listUndelivered(): AssistantRelayRow[];
    /**
     * Rows that settled without their own body being sent (silent loss).
     * `since` limits it to rows settled at or after that time.
     */
    countUnrendered(since?: number): UnrenderedRelayCounts;
    /** Caller must validate terminal/generation/native provenance before storing or reading. */
    captureAttemptBody(attemptId: string, meshId: string, sessionId: string, body: string, at: number, evidenceRef: string, meta?: AttemptBodyMeta): void;
    readAttemptBody(attemptId: string, meshId: string, sessionId: string, now: number, evidenceRef: string): string | null;
    /**
     * A v2 exact capture whose evidence ref starts with `stablePrefix`
     * (version, generation, terminal, source hashes — not the parts hash).
     * v1 rows are not returned: they pinned a truncated screen row.
     */
    readVerifiedAttemptBody(attemptId: string, meshId: string, sessionId: string, now: number, stablePrefix: string): VerifiedAttemptBody | null;
    readReceipt(key: string, now: number): string | null;
    writeReceipt(key: string, value: string, at: number, kind?: RelayReceiptKind): void;
    /** Retention: bodies after 24 h, delivered rows after 7 d, closed threads after 30 d. */
    prune(now: number): void;
}

export interface AttemptBodyMeta {
    completeness: 'final_native' | 'envelope_unverified';
    parts?: Array<{ at: number; chars: number }>;
}

export interface VerifiedAttemptBody {
    body: string;
    evidenceRef: string;
    parts: Array<{ at: number; chars: number }>;
}

export interface RenderedAttemptCoverage {
    attemptId: string;
    coordinatorSessionId: string;
    /** Empty is valid: every native reply was outside the rendered cap. */
    replies: Array<{ messageAt: number; contentHash: string }>;
}
export interface StoredAttemptCoverage extends RenderedAttemptCoverage { renderedAt: number }
const coverageOrder = (a: StoredAttemptCoverage, b: StoredAttemptCoverage) => a.renderedAt - b.renderedAt
    || Buffer.compare(Buffer.from(a.attemptId), Buffer.from(b.attemptId));

export const RELAY_COVERAGE_TTL_MS = 24 * 60 * 60_000;
export const RELAY_COVERAGE_MAX_ROWS = 4_096;
export const RELAY_COVERAGE_MAX_REPLIES = 4_096;
export const RELAY_COVERAGE_MAX_BYTES = 2 * 1_048_576;

/** Allow-list metadata so neither implementation can persist reply bodies. */
export function copyRenderedCoverage(value: RenderedAttemptCoverage): RenderedAttemptCoverage | null {
    const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
    if (!value || !id(value.attemptId) || !id(value.coordinatorSessionId) || !Array.isArray(value.replies) || value.replies.length > 600) return null;
    if (!value.replies.every(r => r && Number.isSafeInteger(r.messageAt) && Number.isFinite(new Date(r.messageAt).getTime())
        && typeof r.contentHash === 'string' && /^[a-f0-9]{64}$/.test(r.contentHash))) return null;
    return { attemptId: value.attemptId, coordinatorSessionId: value.coordinatorSessionId,
        replies: value.replies.map(r => ({ messageAt: r.messageAt, contentHash: r.contentHash })) };
}

export const ATTEMPT_BODY_TTL_MS = 24 * 60 * 60_000;
export const ATTEMPT_BODY_MAX_CHARS = 1_048_576;
export const ATTEMPT_BODY_MAX_ROWS = 128;
export const ATTEMPT_BODY_TOTAL_BYTES = 8 * ATTEMPT_BODY_MAX_CHARS;

export const RELAY_DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60_000;
/**
 * How far back a missed report still counts. A folded report's body is gone
 * after ATTEMPT_BODY_TTL_MS, so an older loss can no longer be acted on; a
 * lifetime total only repeats the same number to every new assistant session.
 */
export const MISSED_REPORT_WINDOW_MS = ATTEMPT_BODY_TTL_MS;
export const THREAD_CLOSED_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** v2 evidence refs are a JSON array. `stablePrefix` is the array without the parts hash. */
export function evidencePrefixMatches(evidenceRef: string, stablePrefix: string): boolean {
    try {
        const arr = JSON.parse(evidenceRef) as unknown;
        if (!Array.isArray(arr) || arr[0] !== 2) return false;
        return JSON.stringify(arr.slice(0, 7)) === stablePrefix;
    } catch {
        return false;
    }
}

/** Shared shaping so both store implementations order the counts the same way. */
export function toUnrenderedCounts(byMesh: ReadonlyMap<string, number>): UnrenderedRelayCounts {
    const rows = [...byMesh.entries()]
        .map(([meshId, count]) => ({ meshId, count }))
        .sort((a, b) => b.count - a.count || a.meshId.localeCompare(b.meshId));
    return { total: rows.reduce((n, r) => n + r.count, 0), byMesh: rows };
}

/** Isolated budgets prevent transcript reads from evicting delivery state. */
export const RELAY_RECEIPT_CAPS = { legacy: 4096, read: 4096, page: 4096, notice: 4096, counter: 4096, capture: 4096, readability: 4096 } as const;
export type RelayReceiptKind = keyof typeof RELAY_RECEIPT_CAPS;

export class InMemoryAssistantRelayStore implements AssistantRelayStore {
    private readonly receipts = new Map<string, { value: string; at: number; kind: RelayReceiptKind }>();
    readReceipt(key: string, now: number): string | null {
        const row = this.receipts.get(key);
        return row && now - row.at < RELAY_DELIVERED_RETENTION_MS ? row.value : null;
    }
    writeReceipt(key: string, value: string, at: number, kind: RelayReceiptKind = 'legacy'): void {
        this.receipts.delete(key);
        this.receipts.set(key, { value, at, kind });
        const bucket = [...this.receipts].filter(([, row]) => row.kind === kind);
        for (const [oldKey] of bucket.slice(0, Math.max(0, bucket.length - RELAY_RECEIPT_CAPS[kind]))) this.receipts.delete(oldKey);
    }
    private readonly coverage = new Map<string, StoredAttemptCoverage>();
    private readonly bodies = new Map<string, { meshId: string; sessionId: string; body: string; at: number; evidenceRef: string; parts: Array<{ at: number; chars: number }> }>();
    private readonly threads = new Map<string, AssistantThreadRow>();
    private readonly relays = new Map<string, AssistantRelayRow>();

    openThread(meshId: string, at: number): void {
        const t = this.threads.get(meshId);
        if (t && t.closedAt === null) t.lastSendAt = at;
        else {
            this.threads.set(meshId, {
                meshId,
                openedAt: at,
                lastSendAt: at,
                closedAt: null,
                ...(t?.lastCursor !== undefined ? { lastCursor: t.lastCursor } : {}),
                ...(t?.coordinatorSessionId !== undefined ? { coordinatorSessionId: t.coordinatorSessionId } : {}),
            });
        }
    }

    markStallNotified(meshId: string, at: number): void {
        const t = this.threads.get(meshId);
        if (t && t.closedAt === null) t.stallNotifiedAt = at;
    }

    setThreadCursor(meshId: string, cursor: string | null, coordinatorSessionId?: string | null): void {
        const t = this.threads.get(meshId);
        if (!t) return;
        if (cursor !== null) t.lastCursor = cursor;
        if (coordinatorSessionId !== undefined && coordinatorSessionId !== null) {
            t.coordinatorSessionId = coordinatorSessionId;
        }
    }

    closeThread(meshId: string, at: number): void {
        const t = this.threads.get(meshId);
        if (t && t.closedAt === null) t.closedAt = at;
    }

    isThreadOpen(meshId: string): boolean {
        return this.threads.get(meshId)?.closedAt === null;
    }

    openThreads(): AssistantThreadRow[] {
        return [...this.threads.values()].filter((t) => t.closedAt === null).map((t) => ({ ...t }));
    }

    recordCommitted(row: Omit<AssistantRelayRow, 'deliveredAt' | 'relayedAt'>): boolean {
        if (this.relays.has(row.attemptId)) return false;
        this.relays.set(row.attemptId, { ...row, deliveredAt: null, relayedAt: null });
        return true;
    }

    markDelivered(attemptIds: readonly string[], at: number, rendered?: readonly string[], coverage: readonly RenderedAttemptCoverage[] = []): void {
        const sent = new Set(rendered ?? attemptIds);
        const fresh = new Set<string>();
        for (const id of attemptIds) {
            const r = this.relays.get(id);
            if (!r || r.deliveredAt !== null) continue;
            r.deliveredAt = at;
            if (sent.has(id)) { r.relayedAt = at; fresh.add(id); }
        }
        for (const value of coverage) {
            const c = copyRenderedCoverage(value);
            if (!c || !fresh.has(c.attemptId) || this.relays.get(c.attemptId)?.coordinatorSessionId !== c.coordinatorSessionId) continue;
            fresh.delete(c.attemptId);
            this.coverage.set(c.attemptId, { ...c, renderedAt: at });
        }
        this.pruneCoverage(at);
    }

    listDeliveredCoverage(now: number): StoredAttemptCoverage[] {
        this.pruneCoverage(now);
        return [...this.coverage.values()].sort(coverageOrder).map(c => ({ ...copyRenderedCoverage(c)!, renderedAt: c.renderedAt }));
    }

    private pruneCoverage(now: number): void {
        let count = 0, replies = 0, bytes = 0;
        const ordered = [...this.coverage.values()].sort(coverageOrder).reverse();
        for (const c of ordered) {
            const cost = Buffer.byteLength(JSON.stringify(c.replies), 'utf8') + Buffer.byteLength(c.attemptId, 'utf8')
                + Buffer.byteLength(c.coordinatorSessionId, 'utf8') + 32;
            if (now - c.renderedAt >= RELAY_COVERAGE_TTL_MS || ++count > RELAY_COVERAGE_MAX_ROWS
                || replies + c.replies.length > RELAY_COVERAGE_MAX_REPLIES || bytes + cost > RELAY_COVERAGE_MAX_BYTES) {
                this.coverage.delete(c.attemptId);
            } else { replies += c.replies.length; bytes += cost; }
        }
    }

    listUndelivered(): AssistantRelayRow[] {
        return [...this.relays.values()]
            .filter((r) => r.deliveredAt === null)
            .sort((a, b) => a.committedAt - b.committedAt || a.attemptId.localeCompare(b.attemptId))
            .map((r) => ({ ...r }));
    }

    countUnrendered(since?: number): UnrenderedRelayCounts {
        const byMesh = new Map<string, number>();
        for (const r of this.relays.values()) {
            if (r.deliveredAt === null || r.relayedAt !== null) continue;
            if (since !== undefined && r.deliveredAt < since) continue;
            byMesh.set(r.meshId, (byMesh.get(r.meshId) ?? 0) + 1);
        }
        return toUnrenderedCounts(byMesh);
    }

    captureAttemptBody(attemptId: string, meshId: string, sessionId: string, body: string, at: number, evidenceRef: string, meta?: AttemptBodyMeta): void {
        const row = this.relays.get(attemptId);
        if (!row || row.meshId !== meshId || row.coordinatorSessionId !== sessionId || !evidenceRef || !body || body.length > ATTEMPT_BODY_MAX_CHARS) return;
        if (meta?.completeness === 'envelope_unverified') return; // never persist an unverified body as exact
        const existing = this.bodies.get(attemptId);
        // Same ref keeps the first exact body. A different ref (v1 → v2, or a new parts hash) replaces it.
        if (existing && existing.evidenceRef === evidenceRef) { this.pruneBodies(at); return; }
        this.bodies.set(attemptId, { meshId, sessionId, body, at, evidenceRef, parts: meta?.parts ?? [] });
        this.pruneBodies(at);
    }
    readAttemptBody(attemptId: string, meshId: string, sessionId: string, now: number, evidenceRef: string): string | null {
        const b = this.bodies.get(attemptId);
        return b && b.evidenceRef === evidenceRef && !!evidenceRef && b.meshId === meshId && b.sessionId === sessionId && now - b.at <= ATTEMPT_BODY_TTL_MS ? b.body : null;
    }
    readVerifiedAttemptBody(attemptId: string, meshId: string, sessionId: string, now: number, stablePrefix: string): VerifiedAttemptBody | null {
        const b = this.bodies.get(attemptId);
        if (!b || b.meshId !== meshId || b.sessionId !== sessionId || now - b.at > ATTEMPT_BODY_TTL_MS) return null;
        if (!evidencePrefixMatches(b.evidenceRef, stablePrefix)) return null;
        return { body: b.body, evidenceRef: b.evidenceRef, parts: b.parts };
    }
    private pruneBodies(now: number): void {
        let total = 0, count = 0;
        for (const [id, b] of [...this.bodies].sort((a, b) => b[1].at - a[1].at || b[0].localeCompare(a[0]))) {
            if (now - b.at > ATTEMPT_BODY_TTL_MS || ++count > ATTEMPT_BODY_MAX_ROWS || total + Buffer.byteLength(b.body, 'utf8') > ATTEMPT_BODY_TOTAL_BYTES) this.bodies.delete(id);
            else total += Buffer.byteLength(b.body, 'utf8');
        }
    }

    prune(now: number): void {
        this.pruneCoverage(now);
        this.pruneBodies(now);
        for (const [id, r] of this.relays) {
            if (r.deliveredAt !== null && now - r.deliveredAt > RELAY_DELIVERED_RETENTION_MS) this.relays.delete(id);
        }
        for (const [id, t] of this.threads) {
            if (t.closedAt !== null && now - t.closedAt > THREAD_CLOSED_RETENTION_MS) this.threads.delete(id);
        }
    }
}
