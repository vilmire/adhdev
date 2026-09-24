import * as crypto from 'crypto';
import type { SessionLifecycleBus, Unsubscribe } from './sessions/lifecycle-bus.js';

// Trunk flag for the worker-MCP feature (docs/design/2026-08-28-worker-mcp.md).
// ★Default ON since 2026-09-18 (owner approval). It shipped default-OFF through
// the Phase A/B rollout; the 2026-09-18 live verification found delivery AND
// isolation healthy on 6 of 7 CLIs (claude, codex, opencode, antigravity,
// cursor, kimi), which is what the default-flip was gated on.
//
// Lives here (layer-neutral) rather than in mesh/worker-mcp-isolation.ts so both
// mesh/** and providers/** can read it without a cross-layer value import
// (import-boundary gate) — mesh/worker-mcp-isolation.ts re-exports it for its
// existing consumers. Read through a function (not a module-level const) so
// tests can flip the variable per-case without module-cache surgery, and so a
// daemon that has the flag toggled in its environment does not need a rebuild
// to see it.
//
// ─── Why the unrecognized-value branch flipped with the default ─────────────
//
// While the default was OFF this read an ON-list: only '1'/'true'/'on'/'yes'
// enabled it, so a typo'd value ('yep') left a security-relevant feature off —
// the safe direction then. With the default ON the safe direction inverts, so
// this is now an OFF-list: only the documented off spellings disable it, and a
// typo falls through to the default rather than silently stripping every worker
// of its isolation. The empty string is deliberately NOT an off spelling — an
// inherited-but-blank var is "unset", not "the operator asked for off" (see
// config/env-overrides.ts, which treats '' as absent for exactly this reason).
export function isWorkerMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.ADHDEV_WORKER_MCP;
    if (typeof raw !== 'string') return true;
    const value = raw.trim().toLowerCase();
    if (value === '') return true;
    return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
}

export const DEFAULT_CDP_SCAN_INTERVAL_MS = 30_000;
export const DEFAULT_CDP_DISCOVERY_INTERVAL_MS = 30_000;

export const DEFAULT_STATUS_INITIAL_REPORT_DELAY_MS = 2_000;
export const DEFAULT_STATUS_SERVER_REPORT_INTERVAL_MS = 30_000;
export const DEFAULT_STATUS_P2P_REPORT_INTERVAL_MS = 5_000;

export const MIN_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS = 5_000;
export const DEFAULT_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS = 15_000;

export const MIN_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS = 5_000;
export const DEFAULT_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS = 10_000;

export const DEFAULT_SESSION_HOST_READY_TIMEOUT_MS = 15_000;

export const STANDALONE_CDP_SCAN_INTERVAL_MS = 15_000;

// Default HTTP/WS port of the standalone daemon (localhost:3847). Single source
// of truth for every client that dials the standalone surface (daemon-standalone
// itself, the MCP server's local transport, dashboards).
export const DEFAULT_STANDALONE_PORT = 3847;

// ---------------------------------------------------------------------------
// Mesh P2P timeout windows (env-overridable)
// ---------------------------------------------------------------------------

// Reads a mesh timeout (ms) from the first non-empty env var in `names`, clamped
// to [1_000, 120_000]; falls back to `defaultMs` when none is set or the value is
// out of range. The clamp lets a slow real link be tuned up (TURN-relayed peers
// whose RTT is many seconds) and lets the test harness shrink the window to its
// 1s minimum, without ever degenerating to 0 or an absurd value. Multiple names
// are accepted so a renamed constant can keep honoring a legacy alias.
export function readMeshTimeoutEnvMs(names: string | string[], defaultMs: number): number {
    const candidates = Array.isArray(names) ? names : [names];
    for (const name of candidates) {
        const raw = process.env[name]?.trim();
        if (!raw) continue;
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 120_000) return parsed;
        return defaultMs;
    }
    return defaultMs;
}

// ---------------------------------------------------------------------------
// Worker session bind registry (wiring-unification, worker-idle-detach fix,
// 2026-09-24).
//
// Lives here (layer-neutral) for the SAME reason as `isWorkerMcpEnabled`
// above: both `mesh/**` (the minting/revocation side — `mesh/worker-mcp-
// isolation.ts` re-exports everything below for its existing consumers, and
// `mesh/turn-ledger/runtime-ledger.ts`'s `revokeCutSessionWorkerBind`) and
// `providers/**` (the read side — `cli-provider-events.ts`'s idle-edge detach
// gate needs `hasLiveWorkerSessionBind()` to decide whether a worker's own
// `generating_completed` may tear down its task stamp) need to reach this
// registry, and the import-boundary gate (`check:boundaries`) forbids a VALUE
// import in either direction between those two layers. Moving the registry to
// this neutral top-level module (outside both scanned buckets) means neither
// side has to reach across the boundary at all.
//
// State: possession of a live bind proves only "the daemon spawned a worker
// for this session" (see the fuller rationale that used to sit here, still
// documented at length in `mesh/worker-mcp-isolation.ts`'s module header) —
// never an authorization token. In-memory ONLY, by design: a daemon restart
// invalidates every bind, which is correct because the worker process behind
// it did not survive the restart either.
// ---------------------------------------------------------------------------

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
}

const LIVE_BINDS = new Map<string, WorkerSessionBinding>();

/** Secondary index: `${meshId}\0${sessionId}` -> bind secrets, for re-mint and revoke. */
const BINDS_BY_SESSION = new Map<string, Set<string>>();

function sessionKey(meshId: string, sessionId: string): string {
    return `${meshId}${sessionId}`;
}

/** Canary prefix for the boundary regression test — see WORKER_TOKEN_CANARY_PREFIX (worker-mcp-isolation.ts). */
export const WORKER_BIND_CANARY_PREFIX = 'wsb_';

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

    for (const existing of bindsForSession(meshId, sessionId)) revokeWorkerSessionBind(existing.bind);

    const minted: WorkerSessionBinding = {
        bind: `${WORKER_BIND_CANARY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`,
        meshId,
        sessionId,
        ...(input.nodeId ? { nodeId: String(input.nodeId).trim() } : {}),
        ...(input.spawnedForTaskId ? { spawnedForTaskId: String(input.spawnedForTaskId).trim() } : {}),
        mintedAtMs: Date.now(),
    };

    LIVE_BINDS.set(minted.bind, minted);
    const key = sessionKey(meshId, sessionId);
    let set = BINDS_BY_SESSION.get(key);
    if (!set) {
        set = new Set<string>();
        BINDS_BY_SESSION.set(key, set);
    }
    set.add(minted.bind);
    return minted;
}

function bindsForSession(meshId: string, sessionId: string): WorkerSessionBinding[] {
    const set = BINDS_BY_SESSION.get(sessionKey(meshId, sessionId));
    if (!set) return [];
    const out: WorkerSessionBinding[] = [];
    for (const secret of set) {
        const found = LIVE_BINDS.get(secret);
        if (found) out.push(found);
    }
    return out;
}

/** Resolve a bind secret. Null for unknown/revoked — callers MUST fail closed. */
export function verifyWorkerSessionBind(bind: unknown): WorkerSessionBinding | null {
    if (typeof bind !== 'string' || !bind.trim()) return null;
    return LIVE_BINDS.get(bind.trim()) || null;
}

/**
 * Revoke every bind naming `sessionId`, in any mesh (wiring-unification B4).
 * A dead worker's bind otherwise stayed live until a re-mint — a zombie
 * process could keep exchanging it for tokens. Returns how many were revoked.
 */
export function revokeWorkerSessionBindsForSession(sessionId: string): number {
    const sid = String(sessionId || '').trim();
    if (!sid) return 0;
    let revoked = 0;
    for (const binding of [...LIVE_BINDS.values()]) {
        if (binding.sessionId === sid && revokeWorkerSessionBind(binding.bind)) revoked += 1;
    }
    return revoked;
}

/** Revoke a session's binds when it terminates, whatever the cause (binds are in-memory only). */
export function subscribeWorkerBindRevocation(bus: SessionLifecycleBus): Unsubscribe {
    return bus.on('terminated', (event) => {
        revokeWorkerSessionBindsForSession(event.sessionId);
    }, { name: 'mesh.worker-binds' });
}

export function revokeWorkerSessionBind(bind: string): boolean {
    const found = LIVE_BINDS.get(bind);
    if (!found) return false;
    LIVE_BINDS.delete(bind);
    const key = sessionKey(found.meshId, found.sessionId);
    const set = BINDS_BY_SESSION.get(key);
    if (set) {
        set.delete(bind);
        if (set.size === 0) BINDS_BY_SESSION.delete(key);
    }
    return true;
}

/**
 * Does any live bind name `sessionId` (any mesh)? This is the "the worker can
 * call report_completion" fact the turn-evidence port stamps onto a turn_end
 * (`reportExpected`, reducer R9r): a bind is only minted alongside a written
 * worker MCP config / delivery, and is revoked when the session dies or a
 * reclaim cuts it, so a live one means a reporting surface exists right now.
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
    for (const binding of LIVE_BINDS.values()) {
        if (binding.sessionId === sid) return true;
    }
    return false;
}

/** Test-only reset so bind state cannot leak between cases. */
export function __resetWorkerSessionBindsForTest(): void {
    LIVE_BINDS.clear();
    BINDS_BY_SESSION.clear();
}

/** Diagnostic counter — never exposes the secrets themselves. */
export function liveWorkerSessionBindCount(): number {
    return LIVE_BINDS.size;
}

// SINGLE source of truth for the mesh cold-open *connect* budget — the time a
// caller grants a peer whose mesh DataChannel is not open yet to drive the
// cross-machine (often TURN-relayed) ICE/DTLS handshake before the response
// deadline takes over. Two call sites share this so an env override tunes BOTH:
//   - commands/router.ts direct-peer git_status probe (requireDirectPeerTruth)
//   - mesh/mesh-events-coordinator.ts remote task-dispatch (deliverTaskToSession)
// Before unification the coordinator hard-coded 45_000 while the router was
// env-overridable, so setting the env tuned the probe path but silently left the
// dispatch path at 45s — the same nominal 45s, but divergent the moment the env
// was set. Matches the daemon-cloud DaemonMeshManager CONNECT_TIMEOUT_MS (45s).
// `MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS` is honored as a backward-compat alias so
// environments already tuned under the old name keep working.
export const MESH_CONNECT_TIMEOUT_MS = readMeshTimeoutEnvMs(
    ['MESH_CONNECT_TIMEOUT_MS', 'MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS'],
    45_000,
);
