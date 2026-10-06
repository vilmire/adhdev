/**
 * Relay thread/row store port (design 2026-10-07-assistant-layer.md §4.6:
 * `assistant_threads`, `assistant_relays` — ids, times and enums only, never a
 * body; the body is re-read at send time).
 *
 * The durable implementation belongs in `mesh-runtime.db` (schema unit, not
 * landed). `InMemoryAssistantRelayStore` implements the same port for tests
 * and as the pre-schema default; it loses rows on restart, which only means
 * no backlog survives a daemon restart until the SQLite store is wired.
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
    deliveredAt: number | null;
    kind: AssistantRelayKind;
    /** Outcome enum of the commit (content-free). */
    outcome: string;
}

export interface AssistantRelayStore {
    /** `project_send` opens (or refreshes) the project's thread. */
    openThread(meshId: string, at: number): void;
    closeThread(meshId: string, at: number): void;
    isThreadOpen(meshId: string): boolean;
    openThreads(): AssistantThreadRow[];
    /** Insert a committed coordinator attempt. False when the attempt is already recorded (dedupe). */
    recordCommitted(row: Omit<AssistantRelayRow, 'deliveredAt'>): boolean;
    markDelivered(attemptIds: readonly string[], at: number): void;
    /** Undelivered rows, oldest commit first. */
    listUndelivered(): AssistantRelayRow[];
    /** Retention: delivered rows after 7 d, closed threads after 30 d. */
    prune(now: number): void;
}

export const RELAY_DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const THREAD_CLOSED_RETENTION_MS = 30 * 24 * 60 * 60_000;

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

    recordCommitted(row: Omit<AssistantRelayRow, 'deliveredAt'>): boolean {
        if (this.relays.has(row.attemptId)) return false;
        this.relays.set(row.attemptId, { ...row, deliveredAt: null });
        return true;
    }

    markDelivered(attemptIds: readonly string[], at: number): void {
        for (const id of attemptIds) {
            const r = this.relays.get(id);
            if (r && r.deliveredAt === null) r.deliveredAt = at;
        }
    }

    listUndelivered(): AssistantRelayRow[] {
        return [...this.relays.values()]
            .filter((r) => r.deliveredAt === null)
            .sort((a, b) => a.committedAt - b.committedAt || a.attemptId.localeCompare(b.attemptId))
            .map((r) => ({ ...r }));
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
