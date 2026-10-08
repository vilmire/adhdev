/**
 * Worker session bind registry (wiring-unification, worker-idle-detach fix,
 * 2026-09-24; restart persistence 2026-10-07).
 *
 * Layer-neutral (outside both `mesh/**` and `providers/**`) for the same reason
 * as `isWorkerMcpEnabled` in runtime-defaults.ts: `mesh/**` mints/revokes binds
 * and `providers/**` (`cli-provider-events.ts`'s idle-edge detach gate) reads
 * `hasLiveWorkerSessionBind()`, and the import-boundary gate forbids a VALUE
 * import between those layers. `runtime-defaults.ts` re-exports everything here
 * so existing imports keep working.
 *
 * State: possession of a live bind proves only "the daemon spawned a worker for
 * this session" (see `mesh/worker-mcp-isolation.ts`'s module header) — never an
 * authorization token.
 *
 * ─── Restart survival (2026-10-07) ──────────────────────────────────────
 *
 * The bind lives in the worker MCP server's process env
 * (`ADHDEV_WORKER_SESSION_BIND`), read once at spawn. With session-host restore
 * a daemon restart does NOT kill the worker: the hosted runtime comes back
 * (`origin=restore`) and keeps calling with the bind it was handed. An
 * in-memory-only registry then refused every `report_completion`,
 * `drain_mailbox` and `progress_update` from a restored worker, and re-minting
 * cannot help because the running process cannot learn a new value.
 *
 * So the registry is persisted through an injected port
 * (`WorkerSessionBindPersistence`, backed by mesh-runtime.db — see
 * `mesh/worker-session-bind-store.ts`), keyed by SHA-256 of the bind. The raw
 * secret is NEVER persisted: a stolen database yields hashes that cannot be
 * presented. A persisted row is honoured only while its session is live on
 * this daemon (the injected liveness probe), and rows for sessions that did
 * not come back are pruned once the full restore set is known
 * (`reconcileWorkerSessionBindsAfterRestore`).
 *
 * In memory every entry is keyed by the same hash, so an entry rehydrated from
 * the store (raw bind unknown until the worker presents it) is a first-class
 * live bind — `hasLiveWorkerSessionBind()` is true for a restored worker before
 * its first call.
 */
import * as crypto from 'crypto';
import type { SessionLifecycleBus, Unsubscribe } from './sessions/lifecycle-bus.js';

export interface WorkerSessionBinding {
    bind: string;
    meshId: string;
    /** Session this bind names. Attribution resolves through THIS, not the caller. */
    sessionId: string;
    nodeId?: string;
    /**
     * The task this worker was auto-launched for, when the spawn knew one.
     * Advisory ONLY — a disambiguator for the session→task lookup, never an
     * authority. A session that has moved on to another task resolves to the
     * task its CURRENT attempt names, not to this one.
     */
    spawnedForTaskId?: string;
    mintedAtMs: number;
    /**
     * True when this bind was minted by a PREVIOUS daemon incarnation and
     * re-adopted from the persisted registry for a restored session. The task
     * tokens of that incarnation are gone too, so the exchange may re-mint one
     * for the session's current attempt (worker-mcp-isolation.ts).
     */
    restored?: boolean;
}

/** The persisted shape: everything but the secret, keyed by its SHA-256. */
export interface PersistedWorkerSessionBind {
    bindHash: string;
    meshId: string;
    sessionId: string;
    nodeId?: string;
    spawnedForTaskId?: string;
    mintedAtMs: number;
}

/** Durable store port. Every method may throw; the registry treats persistence as best-effort. */
export interface WorkerSessionBindPersistence {
    put(row: PersistedWorkerSessionBind): void;
    get(bindHash: string): PersistedWorkerSessionBind | null;
    delete(bindHash: string): void;
    deleteForSession(sessionId: string): number;
    list(): PersistedWorkerSessionBind[];
}

/** What `workerSessionBindStatus` can say about a presented bind. */
export type WorkerSessionBindStatus =
    /** Not a usable string at all. */
    | 'invalid'
    /** Live on this daemon (in memory, or adopted from the store just now). */
    | 'live'
    /** Revoked during this daemon incarnation (session ended, reclaim cut, re-mint). */
    | 'revoked'
    /** Persisted, but its session is not live on this daemon (not restored, or not yet). */
    | 'session_not_live'
    /** Never seen by this incarnation and not persisted — typically minted before a restart that lost it. */
    | 'unknown';

interface BindEntry extends Omit<WorkerSessionBinding, 'bind'> {
    bindHash: string;
    /** The raw secret, once known (always for a bind minted here; after first presentation for a restored one). */
    bind?: string;
}

/** In-memory registry, keyed by SHA-256(bind). */
const LIVE_BINDS = new Map<string, BindEntry>();

/** Secondary index: `${meshId}\0${sessionId}` -> bind hashes, for re-mint and revoke. */
const BINDS_BY_SESSION = new Map<string, Set<string>>();

/**
 * Hashes revoked during this incarnation (bounded, FIFO), so a revoked bind is
 * told apart from one this daemon never knew (`bind_unknown_after_restart`).
 */
const REVOKED_HASHES = new Set<string>();
const REVOKED_HASHES_CAP = 4096;

let persistence: WorkerSessionBindPersistence | null = null;
let isSessionLive: ((sessionId: string) => boolean) | null = null;

function sessionKey(meshId: string, sessionId: string): string {
    return `${meshId}\0${sessionId}`;
}

/** SHA-256 hex of a bind secret — the only form that is ever persisted. */
export function hashWorkerSessionBind(bind: string): string {
    return crypto.createHash('sha256').update(bind, 'utf8').digest('hex');
}

/** Canary prefix for the boundary regression test — see WORKER_TOKEN_CANARY_PREFIX (worker-mcp-isolation.ts). */
export const WORKER_BIND_CANARY_PREFIX = 'wsb_';

/**
 * Install (or clear, with null) the durable store and the liveness probe. Boot
 * (S7 `bootMeshRuntime`) installs both; without them the registry is
 * in-memory only, exactly as before.
 */
export function setWorkerSessionBindPersistence(
    port: WorkerSessionBindPersistence | null,
    liveness: ((sessionId: string) => boolean) | null = null,
): void {
    persistence = port;
    isSessionLive = liveness;
}

function persistBestEffort(fn: (port: WorkerSessionBindPersistence) => void): void {
    if (!persistence) return;
    try { fn(persistence); } catch { /* best-effort: the in-memory registry stays authoritative */ }
}

function toPersisted(entry: BindEntry): PersistedWorkerSessionBind {
    return {
        bindHash: entry.bindHash,
        meshId: entry.meshId,
        sessionId: entry.sessionId,
        ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
        ...(entry.spawnedForTaskId ? { spawnedForTaskId: entry.spawnedForTaskId } : {}),
        mintedAtMs: entry.mintedAtMs,
    };
}

function addEntry(entry: BindEntry): void {
    LIVE_BINDS.set(entry.bindHash, entry);
    const key = sessionKey(entry.meshId, entry.sessionId);
    let set = BINDS_BY_SESSION.get(key);
    if (!set) {
        set = new Set<string>();
        BINDS_BY_SESSION.set(key, set);
    }
    set.add(entry.bindHash);
}

function adoptPersisted(row: PersistedWorkerSessionBind): BindEntry {
    const entry: BindEntry = {
        bindHash: row.bindHash,
        meshId: row.meshId,
        sessionId: row.sessionId,
        ...(row.nodeId ? { nodeId: row.nodeId } : {}),
        ...(row.spawnedForTaskId ? { spawnedForTaskId: row.spawnedForTaskId } : {}),
        mintedAtMs: row.mintedAtMs,
        restored: true,
    };
    addEntry(entry);
    return entry;
}

function sessionLiveHere(sessionId: string): boolean {
    if (!isSessionLive) return false;
    try { return isSessionLive(sessionId) === true; } catch { return false; }
}

/**
 * Mint (or re-mint) the session bind handed to a worker at spawn.
 *
 * Re-minting for the same session REVOKES the prior bind. A second spawn for one
 * session means the first worker is gone; leaving its bind live would let a
 * zombie process keep exchanging it for tokens against a session it no longer owns.
 */
export function mintWorkerSessionBind(input: {
    meshId: string;
    sessionId: string;
    nodeId?: string;
    spawnedForTaskId?: string;
}): WorkerSessionBinding {
    const meshId = String(input.meshId || '').trim();
    const sessionId = String(input.sessionId || '').trim();
    if (!meshId || !sessionId) {
        throw new Error('mintWorkerSessionBind requires both meshId and sessionId');
    }

    for (const hash of [...(BINDS_BY_SESSION.get(sessionKey(meshId, sessionId)) || [])]) revokeByHash(hash);
    // A previous incarnation's row for this session, never rehydrated, names the
    // worker this spawn replaces — drop it too, or it could be adopted later.
    persistBestEffort((port) => {
        for (const row of port.list()) {
            if (row.meshId === meshId && row.sessionId === sessionId) port.delete(row.bindHash);
        }
    });

    const bind = `${WORKER_BIND_CANARY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    const entry: BindEntry = {
        bindHash: hashWorkerSessionBind(bind),
        bind,
        meshId,
        sessionId,
        ...(input.nodeId ? { nodeId: String(input.nodeId).trim() } : {}),
        ...(input.spawnedForTaskId ? { spawnedForTaskId: String(input.spawnedForTaskId).trim() } : {}),
        mintedAtMs: Date.now(),
    };
    addEntry(entry);
    persistBestEffort((port) => port.put(toPersisted(entry)));
    return toBinding(entry, bind);
}

function toBinding(entry: BindEntry, bind: string): WorkerSessionBinding {
    return {
        bind,
        meshId: entry.meshId,
        sessionId: entry.sessionId,
        ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
        ...(entry.spawnedForTaskId ? { spawnedForTaskId: entry.spawnedForTaskId } : {}),
        mintedAtMs: entry.mintedAtMs,
        ...(entry.restored ? { restored: true } : {}),
    };
}

/**
 * Classify a presented bind, adopting a persisted row into memory when its
 * session is live here. `verifyWorkerSessionBind` is the fail-closed wrapper.
 */
export function workerSessionBindStatus(bind: unknown): { status: WorkerSessionBindStatus; binding?: WorkerSessionBinding } {
    if (typeof bind !== 'string' || !bind.trim()) return { status: 'invalid' };
    const raw = bind.trim();
    const hash = hashWorkerSessionBind(raw);
    const live = LIVE_BINDS.get(hash);
    if (live) {
        if (!live.bind) live.bind = raw;
        return { status: 'live', binding: toBinding(live, raw) };
    }
    if (REVOKED_HASHES.has(hash)) return { status: 'revoked' };
    let row: PersistedWorkerSessionBind | null = null;
    if (persistence) {
        try { row = persistence.get(hash); } catch { row = null; }
    }
    if (!row) return { status: 'unknown' };
    if (!sessionLiveHere(row.sessionId)) return { status: 'session_not_live' };
    const adopted = adoptPersisted(row);
    adopted.bind = raw;
    return { status: 'live', binding: toBinding(adopted, raw) };
}

/** Resolve a bind secret. Null for unknown/revoked/not-live — callers MUST fail closed. */
export function verifyWorkerSessionBind(bind: unknown): WorkerSessionBinding | null {
    return workerSessionBindStatus(bind).binding ?? null;
}

function rememberRevoked(hash: string): void {
    REVOKED_HASHES.add(hash);
    if (REVOKED_HASHES.size > REVOKED_HASHES_CAP) {
        const oldest = REVOKED_HASHES.values().next().value;
        if (oldest !== undefined) REVOKED_HASHES.delete(oldest);
    }
}

function revokeByHash(hash: string): boolean {
    const found = LIVE_BINDS.get(hash);
    persistBestEffort((port) => port.delete(hash));
    if (!found) return false;
    LIVE_BINDS.delete(hash);
    rememberRevoked(hash);
    const key = sessionKey(found.meshId, found.sessionId);
    const set = BINDS_BY_SESSION.get(key);
    if (set) {
        set.delete(hash);
        if (set.size === 0) BINDS_BY_SESSION.delete(key);
    }
    return true;
}

/**
 * Revoke every bind naming `sessionId`, in any mesh (wiring-unification B4).
 * A dead worker's bind otherwise stayed live until a re-mint — a zombie
 * process could keep exchanging it for tokens. Also drops persisted rows for
 * the session that were never rehydrated. Returns how many live binds were revoked.
 */
export function revokeWorkerSessionBindsForSession(sessionId: string): number {
    const sid = String(sessionId || '').trim();
    if (!sid) return 0;
    let revoked = 0;
    for (const entry of [...LIVE_BINDS.values()]) {
        if (entry.sessionId === sid && revokeByHash(entry.bindHash)) revoked += 1;
    }
    persistBestEffort((port) => { port.deleteForSession(sid); });
    return revoked;
}

/**
 * Revoke a session's binds when it terminates — except on `daemon_shutdown`:
 * a hosted worker torn down because THIS daemon is going away keeps running in
 * the session host and comes back on restore with the same bind in its env
 * (same rule as the coordinator registry's `subscribeCoordinatorRegistryRemoval`).
 */
export function subscribeWorkerBindRevocation(bus: SessionLifecycleBus): Unsubscribe {
    return bus.on('terminated', (event) => {
        if (event.cause === 'daemon_shutdown') return;
        revokeWorkerSessionBindsForSession(event.sessionId);
    }, { name: 'mesh.worker-binds' });
}

export function revokeWorkerSessionBind(bind: string): boolean {
    if (typeof bind !== 'string' || !bind.trim()) return false;
    return revokeByHash(hashWorkerSessionBind(bind.trim()));
}

/**
 * Boot, after the FULL hosted-session restore (`cli-manager-restore.ts`): adopt
 * persisted binds whose session came back and is live here, prune the rest.
 * `liveSessionIds` is the session host's live-runtime list; the liveness probe
 * additionally requires the session to be registered on THIS daemon.
 *
 * ★A row whose session IS in the live-runtime list but is NOT registered here
 * is KEPT (`deferred`), neither adopted nor pruned. That is a restore that
 * failed for this daemon (live 2026-10-08, Jupiter: `ghostty-vt binding
 * unavailable` on the 1.0.77 → 1.0.78-rc.1 upgrade) while the worker process
 * kept running in the session host. Pruning it there made the worker's
 * spawn-time bind permanently unknown: a later restore re-registered the
 * session, and every `report_completion` was refused
 * `bind_unknown_after_restart`. A kept row is still honoured only once its
 * session is live here (`workerSessionBindStatus` re-checks), so this never
 * accepts a bind for a session this daemon does not run; the row goes away on
 * a later boot whose live list no longer has the session, on a re-mint, or
 * when the re-registered session terminates.
 */
export function reconcileWorkerSessionBindsAfterRestore(liveSessionIds: ReadonlySet<string>): { rehydrated: number; pruned: number; deferred: number } {
    if (!persistence) return { rehydrated: 0, pruned: 0, deferred: 0 };
    let rows: PersistedWorkerSessionBind[] = [];
    try { rows = persistence.list(); } catch { return { rehydrated: 0, pruned: 0, deferred: 0 }; }
    let rehydrated = 0;
    let pruned = 0;
    let deferred = 0;
    for (const row of rows) {
        if (LIVE_BINDS.has(row.bindHash)) continue;
        if (!liveSessionIds.has(row.sessionId)) {
            persistBestEffort((port) => port.delete(row.bindHash));
            pruned += 1;
        } else if (sessionLiveHere(row.sessionId)) {
            adoptPersisted(row);
            rehydrated += 1;
        } else {
            deferred += 1;
        }
    }
    return { rehydrated, pruned, deferred };
}

/**
 * Does any live bind name `sessionId` (any mesh)? This is the "the worker can
 * call report_completion" fact the turn-evidence port stamps onto a turn_end
 * (`reportExpected`, reducer R9r): a bind is only minted alongside a written
 * worker MCP config / delivery, and is revoked when the session dies or a
 * reclaim cuts it, so a live one means a reporting surface exists right now.
 * A bind rehydrated for a restored session counts — its worker is still running.
 *
 * ★Worker-idle-detach fix (2026-09-24): this is ALSO the fact
 * `cli-provider-events.ts`'s `pushEvent` reads to decide whether a worker
 * session's own `generating_completed` may detach its mesh task stamp. A live
 * bind means the daemon still expects a `report_completion` call for
 * whatever this session is working — tearing the stamp down on the session's
 * own idle edge would strip `meshActiveTaskId`/`meshActiveAttemptId` before
 * that report can be routed. See the detach-site comment for the full
 * rationale and the three ways a bound worker's stamp DOES still clear
 * (owner revocation, a new stamp for a different task, or session exit).
 */
export function hasLiveWorkerSessionBind(sessionId: string): boolean {
    const sid = String(sessionId || '').trim();
    if (!sid) return false;
    for (const entry of LIVE_BINDS.values()) {
        if (entry.sessionId === sid) return true;
    }
    return false;
}

/**
 * Test-only reset so bind state cannot leak between cases. Clears the
 * in-memory registry ONLY (this is also what a daemon restart does) — the
 * installed persistence port and its rows are left alone.
 */
export function __resetWorkerSessionBindsForTest(): void {
    LIVE_BINDS.clear();
    BINDS_BY_SESSION.clear();
    REVOKED_HASHES.clear();
}

/** Diagnostic counter — never exposes the secrets themselves. */
export function liveWorkerSessionBindCount(): number {
    return LIVE_BINDS.size;
}
