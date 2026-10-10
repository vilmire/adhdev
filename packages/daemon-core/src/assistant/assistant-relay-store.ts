/**
 * Relay thread/row store port (design 2026-10-07-assistant-layer.md §4.6:
 * `assistant_threads`, `assistant_relays` — ids, times and enums only, never a
 * body; the body is re-read at send time).
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
    /** Insert a committed coordinator attempt. False when the attempt is already recorded (dedupe). */
    recordCommitted(row: Omit<AssistantRelayRow, 'deliveredAt' | 'relayedAt'>): boolean;
    /**
     * Settle rows that left the queue. `rendered` is the subset whose own body
     * went out in the envelope; the rest settle unrendered and are counted by
     * `countUnrendered`. Pass the same list twice when every row was rendered.
     */
    markDelivered(attemptIds: readonly string[], at: number, rendered?: readonly string[]): void;
    /** Undelivered rows, oldest commit first. */
    listUndelivered(): AssistantRelayRow[];
    /** Rows that settled without their own body being sent (silent loss). */
    countUnrendered(): UnrenderedRelayCounts;
    /** Retention: delivered rows after 7 d, closed threads after 30 d. */
    prune(now: number): void;
}

export const RELAY_DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const THREAD_CLOSED_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Shared shaping so both store implementations order the counts the same way. */
export function toUnrenderedCounts(byMesh: ReadonlyMap<string, number>): UnrenderedRelayCounts {
    const rows = [...byMesh.entries()]
        .map(([meshId, count]) => ({ meshId, count }))
        .sort((a, b) => b.count - a.count || a.meshId.localeCompare(b.meshId));
    return { total: rows.reduce((n, r) => n + r.count, 0), byMesh: rows };
}

export class InMemoryAssistantRelayStore implements AssistantRelayStore {
    private readonly threads = new Map<string, AssistantThreadRow>();
    private readonly relays = new Map<string, AssistantRelayRow>();

    openThread(meshId: string, at: number): void {
        const t = this.threads.get(meshId);
        if (t && t.closedAt === null) t.lastSendAt = at;
        else this.threads.set(meshId, { meshId, openedAt: at, lastSendAt: at, closedAt: null });
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

    markDelivered(attemptIds: readonly string[], at: number, rendered?: readonly string[]): void {
        const sent = new Set(rendered ?? attemptIds);
        for (const id of attemptIds) {
            const r = this.relays.get(id);
            if (!r || r.deliveredAt !== null) continue;
            r.deliveredAt = at;
            if (sent.has(id)) r.relayedAt = at;
        }
    }

    listUndelivered(): AssistantRelayRow[] {
        return [...this.relays.values()]
            .filter((r) => r.deliveredAt === null)
            .sort((a, b) => a.committedAt - b.committedAt || a.attemptId.localeCompare(b.attemptId))
            .map((r) => ({ ...r }));
    }

    countUnrendered(): UnrenderedRelayCounts {
        const byMesh = new Map<string, number>();
        for (const r of this.relays.values()) {
            if (r.deliveredAt === null || r.relayedAt !== null) continue;
            byMesh.set(r.meshId, (byMesh.get(r.meshId) ?? 0) + 1);
        }
        return toUnrenderedCounts(byMesh);
    }

    prune(now: number): void {
        for (const [id, r] of this.relays) {
            if (r.deliveredAt !== null && now - r.deliveredAt > RELAY_DELIVERED_RETENTION_MS) this.relays.delete(id);
        }
        for (const [id, t] of this.threads) {
            if (t.closedAt !== null && now - t.closedAt > THREAD_CLOSED_RETENTION_MS) this.threads.delete(id);
        }
    }
}
