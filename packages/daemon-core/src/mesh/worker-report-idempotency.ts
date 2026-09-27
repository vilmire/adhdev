/**
 * Worker report delivery idempotency — the daemon half of the durable report outbox.
 *
 * ─── Why ────────────────────────────────────────────────────────────────
 *
 * Under daemon overload (2026-09-27, seqscribe resync storm) the worker MCP's IPC call
 * timed out after 15s while the daemon was still working through it. The worker saw a
 * failure; whether the daemon had filed the report was unknowable from its side. Three
 * such timeouts in a row, and a finished investigation never reached the coordinator.
 *
 * The mcp-server now keeps every report in a durable outbox and re-sends it until the
 * daemon gives a definitive answer (mcp-server/src/tools/worker-report-outbox.ts). Re-sending
 * is only safe if a re-send of a report the daemon DID process is recognised as the same
 * report. Each delivery therefore carries a client-minted `deliveryId`, stable across every
 * retry of one report, and this module remembers the daemon's accepted answer per id.
 *
 * A replay hit returns the remembered answer (flagged `duplicate`) without touching the
 * ledger again — so a completion lands exactly once and a progress note pages the
 * coordinator exactly once, however many times the transport made the client retry.
 * (The ledger's own UNIQUE(attempt, kind, outcome) key is the second, storage-level
 * defence for completions; progress notes have no such key, which is why this exists.)
 *
 * In memory by design: the credential it is keyed by (the session bind) is itself
 * in-memory only and dies with the daemon, so nothing here could outlive its key.
 */

/** Mirrors WORKER_REPORT_MAX_DELIVERY_DELAY_MS (worker-report.ts) — the outbox's retry window. */
export const WORKER_DELIVERY_REPLAY_TTL_MS = 2 * 60 * 60 * 1000;
const WORKER_DELIVERY_REPLAY_MAX_ENTRIES = 2000;

export type WorkerDeliveryKind = 'report' | 'progress';

interface RememberedDelivery {
    response: Record<string, unknown>;
    atMs: number;
}

const remembered = new Map<string, RememberedDelivery>();

/** A usable delivery id, or undefined (absent / malformed → no idempotency, prior behavior). */
export function normalizeWorkerDeliveryId(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const id = raw.trim();
    return /^[A-Za-z0-9_.:-]{8,128}$/.test(id) ? id : undefined;
}

function deliveryKey(kind: WorkerDeliveryKind, credential: { token?: unknown; bind?: unknown }, deliveryId: string): string | undefined {
    const bind = typeof credential.bind === 'string' ? credential.bind.trim() : '';
    const token = typeof credential.token === 'string' ? credential.token.trim() : '';
    const who = bind || token;
    // Scoped by credential: one worker's id can never replay another worker's answer.
    return who ? `${kind}\u0000${who}\u0000${deliveryId}` : undefined;
}

/** The accepted answer this exact delivery already got, if any (fresh within the TTL). */
export function recallWorkerDelivery(
    kind: WorkerDeliveryKind,
    credential: { token?: unknown; bind?: unknown },
    deliveryId: string | undefined,
    nowMs = Date.now(),
): (Record<string, unknown> & { success: true }) | undefined {
    if (!deliveryId) return undefined;
    const key = deliveryKey(kind, credential, deliveryId);
    if (!key) return undefined;
    const hit = remembered.get(key);
    if (!hit) return undefined;
    if (nowMs - hit.atMs > WORKER_DELIVERY_REPLAY_TTL_MS) {
        remembered.delete(key);
        return undefined;
    }
    return { ...hit.response, success: true };
}

/**
 * Remember an ACCEPTED answer. Refusals are deliberately not remembered: a refusal
 * records nothing, so re-evaluating a re-send is both safe and more accurate (the
 * refusal may have been transient, e.g. `storage_failed` / `forward_failed`).
 */
export function rememberWorkerDelivery(
    kind: WorkerDeliveryKind,
    credential: { token?: unknown; bind?: unknown },
    deliveryId: string | undefined,
    response: Record<string, unknown> & { success?: unknown },
    nowMs = Date.now(),
): void {
    if (!deliveryId || response?.success !== true) return;
    const key = deliveryKey(kind, credential, deliveryId);
    if (!key) return;
    remembered.delete(key);
    remembered.set(key, { response, atMs: nowMs });
    while (remembered.size > WORKER_DELIVERY_REPLAY_MAX_ENTRIES) {
        const oldest = remembered.keys().next().value;
        if (oldest === undefined) break;
        remembered.delete(oldest);
    }
}

/** @internal Test-only reset. */
export function __resetWorkerDeliveryReplayForTests(): void {
    remembered.clear();
}
