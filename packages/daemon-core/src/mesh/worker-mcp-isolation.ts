/**
 * Worker MCP isolation — Phase A (identity + isolation).
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §3 (decision A), §9.2 (G).
 *
 * ─── What this module is for ────────────────────────────────────────────
 *
 * A coordinator-spawned worker today inherits the coordinator's full mesh MCP
 * surface (60 published / 66 callable tools, plus the coordinator system
 * prompt exposed as an MCP resource). Isolation is provider-DECLARED, and only
 * 2 of 8 shipped CLI providers declare it — so 6 provider types spawn workers
 * holding `mesh_send_task`, `mesh_remove_node` and `mesh_restart_daemon`.
 *
 * The threat model is NOT a malicious worker. A worker already has a shell; MCP
 * isolation is not that defence line. It is the *over-privileged accident* —
 * the worker that reaches for a coordinator tool it should never have had and
 * restarts a node mid-flight.
 *
 * ─── The two things this module provides ────────────────────────────────
 *
 * 1. A worker-scoped MCP config written to the path the provider ALREADY
 *    declares (`meshCoordinator.mcpConfig.path`). All 8 providers declare that
 *    path, so this needs no new per-provider knowledge — the coordinator entry
 *    is replaced by a worker entry rather than the provider being asked to
 *    describe how to disable itself.
 *
 * 2. A per-task token minted by the DAEMON and carried inside that config.
 *
 * ★The token is deliberately NOT an env-var self-assertion. `ADHDEV_COORDINATOR_
 * SESSION_ID` already failed exactly that way and the code says so out loud
 * (`mesh-work-queue.ts` / `mesh-runtime-store.ts`: "a process can set [it] on
 * itself, so this must never become an authorization gate"). A worker CAN read
 * its own token — that is fine and unavoidable. What matters is that the token
 * is *minted and verified by the daemon*: possession proves the daemon issued
 * it for this task, which self-declared env values can never prove.
 *
 * ─── Flag gate ──────────────────────────────────────────────────────────
 *
 * Everything here is behind `ADHDEV_WORKER_MCP` (default OFF). With the gate
 * off, `resolveWorkerMcpIsolation()` returns null and every caller must fall
 * through to byte-identical prior behavior.
 *
 * ─── Scope boundary (Phase A) ───────────────────────────────────────────
 *
 * Minting, storage and expiry only. The VERIFYING consumer (`report_completion`
 * and the worker tool surface) is Phase B. A token minted here and never
 * verified changes no behavior — which is why this phase is safe to land first.
 */

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { existsSync, mkdirSync, writeFileSync, symlinkSync, copyFileSync, statSync, rmSync } from 'fs';

import { shortHash } from '../system/hash.js';
import { LOG } from '../logging/logger.js';
import {
    buildMeshCoordinatorMcpServerEntry,
    getMcpServersKey,
    isSupportedMeshCoordinatorConfigFormat,
    serializeMeshCoordinatorMcpConfig,
} from './mesh-coordinator-config.js';
import type { MeshCoordinatorConfigFormat } from './mesh-refine-gates.js';
import { isWorkerMcpEnabled } from '../runtime-defaults.js';

// ─── Flag gate ──────────────────────────────────────────────────────────
// Moved to ../runtime-defaults.ts (layer-neutral — import-boundary gate blocks
// providers/** from importing mesh/** values). Re-exported here so existing
// mesh/** consumers (mesh-queue-assignment.ts, mesh-work-queue.ts,
// worker-handoff-dispatch.ts, this module's own test suite) keep working
// unchanged.
export { isWorkerMcpEnabled };

// ─── Token minting ──────────────────────────────────────────────────────

export interface WorkerTaskTokenBinding {
    meshId: string;
    taskId: string;
    /** Retry/redrive generation. A new attempt mints a NEW token (§9.2). */
    attemptId?: string;
    sessionId?: string;
    nodeId?: string;
}

export interface WorkerTaskToken extends WorkerTaskTokenBinding {
    /** The opaque secret handed to the worker. Never logged, never sent to the server. */
    token: string;
    mintedAtMs: number;
}

/**
 * Live tokens, keyed by the token secret itself so verification is an O(1)
 * lookup that cannot be tricked by a caller-supplied identifier.
 *
 * In-memory ONLY, by design (§9.2). A daemon restart invalidates every token,
 * which is the correct outcome: the workers those tokens belonged to did not
 * survive the restart either.
 *
 * ★Never persist this map to seqscribe, a status_report, or any server-bound
 * payload. Integration plan §6.1 (no secrets in topics) applies to this token;
 * `WORKER_TOKEN_CANARY_PREFIX` below exists so a regression test can assert it.
 */
const LIVE_TOKENS = new Map<string, WorkerTaskToken>();

/** Secondary index: `${meshId}${taskId}` -> token secrets, for expiry-by-task. */
const TOKENS_BY_TASK = new Map<string, Set<string>>();

function taskKey(meshId: string, taskId: string): string {
    return `${meshId}${taskId}`;
}

/**
 * Mint a per-task worker token bound to (meshId, taskId, attemptId, sessionId,
 * nodeId).
 *
 * ★Idempotency is deliberately NOT provided here. Re-minting for the same
 * (task, attempt) yields a fresh secret and revokes the previous one, because
 * the only way to reach this twice for one attempt is a re-dispatch — and a
 * re-dispatched worker must not be able to report through the stale token its
 * predecessor was handed. This mirrors `dispatchNonce`'s purpose at the same
 * layer, and is what structurally blocks the REDRIVE-DUP family (a late report
 * from a superseded dispatch).
 */
export function mintWorkerTaskToken(binding: WorkerTaskTokenBinding): WorkerTaskToken {
    const meshId = String(binding.meshId || '').trim();
    const taskId = String(binding.taskId || '').trim();
    if (!meshId || !taskId) {
        throw new Error('mintWorkerTaskToken requires both meshId and taskId');
    }

    // Revoke any prior token for this exact (task, attempt) — see the
    // re-dispatch note above.
    const attemptId = binding.attemptId ? String(binding.attemptId).trim() : undefined;
    for (const existing of tokensForTask(meshId, taskId)) {
        if ((existing.attemptId || undefined) === attemptId) revokeWorkerTaskToken(existing.token);
    }

    const minted: WorkerTaskToken = {
        meshId,
        taskId,
        ...(attemptId ? { attemptId } : {}),
        ...(binding.sessionId ? { sessionId: String(binding.sessionId).trim() } : {}),
        ...(binding.nodeId ? { nodeId: String(binding.nodeId).trim() } : {}),
        // 32 bytes of CSPRNG. base64url so it survives JSON, env and argv
        // without escaping.
        token: `wtk_${crypto.randomBytes(32).toString('base64url')}`,
        mintedAtMs: Date.now(),
    };

    LIVE_TOKENS.set(minted.token, minted);
    const key = taskKey(meshId, taskId);
    let set = TOKENS_BY_TASK.get(key);
    if (!set) {
        set = new Set<string>();
        TOKENS_BY_TASK.set(key, set);
    }
    set.add(minted.token);
    return minted;
}

/**
 * Resolve a token secret to its binding. Phase B's `report_completion` gate is
 * the first real consumer; Phase A ships it so mint/expire can be tested
 * end-to-end.
 *
 * Returns null for an unknown OR revoked token — a caller must treat null as
 * fail-closed, never as "unbound, allow through".
 */
export function verifyWorkerTaskToken(token: unknown): WorkerTaskToken | null {
    if (typeof token !== 'string' || !token.trim()) return null;
    return LIVE_TOKENS.get(token.trim()) || null;
}

function tokensForTask(meshId: string, taskId: string): WorkerTaskToken[] {
    const set = TOKENS_BY_TASK.get(taskKey(meshId, taskId));
    if (!set) return [];
    const out: WorkerTaskToken[] = [];
    for (const secret of set) {
        const found = LIVE_TOKENS.get(secret);
        if (found) out.push(found);
    }
    return out;
}

export function revokeWorkerTaskToken(token: string): boolean {
    const found = LIVE_TOKENS.get(token);
    if (!found) return false;
    LIVE_TOKENS.delete(token);
    const key = taskKey(found.meshId, found.taskId);
    const set = TOKENS_BY_TASK.get(key);
    if (set) {
        set.delete(token);
        if (set.size === 0) TOKENS_BY_TASK.delete(key);
    }
    return true;
}

/**
 * Expire every token for a task. Called from the single terminal-acceptance
 * chokepoint (`commitTaskTerminalAndAdvanceGraph`).
 *
 * ★Idempotent by construction — a second call for an already-expired task
 * removes nothing and returns 0. That matters because the chokepoint has a
 * replay fence that re-enters with `{committed:true, duplicate:true}`, so this
 * hook MUST tolerate being called again for a row that is already terminal.
 */
export function expireWorkerTaskTokensForTask(meshId: string, taskId: string): number {
    const tokens = tokensForTask(meshId, taskId);
    let removed = 0;
    for (const entry of tokens) {
        if (revokeWorkerTaskToken(entry.token)) removed += 1;
    }
    return removed;
}

/** Test-only reset so token state cannot leak between cases. */
export function __resetWorkerTaskTokensForTest(): void {
    LIVE_TOKENS.clear();
    TOKENS_BY_TASK.clear();
}

/** Diagnostic counter — never exposes the secrets themselves. */
export function liveWorkerTaskTokenCount(): number {
    return LIVE_TOKENS.size;
}

/**
 * The field names a boundary regression test should scan for when asserting
 * that a worker token never reaches seqscribe frames, status_report payloads
 * or server responses (design §14 "F(경계)", integration plan §6.1 canary
 * convention).
 */
export const WORKER_TOKEN_CANARY_PREFIX = 'wtk_';

// ─── Session binding (Phase B: closing the spawn≠claim gap) ─────────────

/**
 * ★The gap this exists to close (design §12.1a).
 *
 * Phase A measured that the spawn happens BEFORE the claim:
 *
 *     maybeAutoLaunchOneQueueSession → launch_cli   ← taskId known, attemptId does NOT exist
 *        → worker agent:ready
 *           → tryAssignQueueTask → claimNextTask → openTurnAttempt   ← attemptId born here
 *
 * So the token cannot be written into the worker's MCP config at spawn: at that
 * moment there is nothing to write. §12.1a left two ways out — rewrite the
 * config at claim time, or exchange for the token on the first tool call.
 *
 * ★The rewrite option is unsound, and the reason is not subtle: the worker CLI
 * reads its MCP config ONCE, when it spawns the MCP server process. Rewriting
 * the file afterwards updates bytes nobody re-reads. It would appear to work in
 * a test that inspects the file and fail in production, and it would force a
 * worker restart per task on a session that legitimately serves many tasks.
 *
 * ∴ the config carries a SESSION BIND — a stable, reusable handle minted once at
 * spawn — and the MCP server exchanges it for the live task token at the moment
 * it actually needs one. The bind survives retries, redrives and session reuse,
 * because it names the *session*, and the daemon resolves "which task is that
 * session working on right now" at call time from the ledger.
 *
 * ─── Why a bind is not just a weaker token ──────────────────────────────
 *
 * The bind is NOT an authorization token and must never be treated as one. It
 * proves only "the daemon spawned this worker for this session". Everything
 * that decides attribution — (taskId, attemptId) — is resolved daemon-side from
 * the CURRENT attempt at exchange time, never from anything the caller supplied.
 * So a leaked or replayed bind can, at worst, report on whatever its own session
 * is legitimately working on at that instant. That is precisely the authority the
 * worker already has, so the bind widens nothing.
 *
 * ★It is still a secret in the operational sense (possession is required), so it
 * shares the token's boundary rules: never in a topic, a status_report, or any
 * server-bound payload. `WORKER_BIND_CANARY_PREFIX` exists for that regression
 * test, and is deliberately a DIFFERENT prefix from the token's so a boundary
 * scan cannot pass by only checking one of them.
 */
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

/** Canary prefix for the boundary regression test — see WORKER_TOKEN_CANARY_PREFIX. */
export const WORKER_BIND_CANARY_PREFIX = 'wsb_';

/**
 * Mint (or re-mint) the session bind handed to a worker at spawn.
 *
 * Re-minting for the same session REVOKES the prior bind. A second spawn for one
 * session means the first worker is gone; leaving its bind live would let a
 * zombie process keep exchanging for tokens against a session it no longer owns.
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
 * Find the live token for a (meshId, sessionId, taskId) triple.
 *
 * This is the exchange lookup: the daemon has already resolved WHICH task the
 * session is on, and now needs that task's minted token. Matching on sessionId
 * as well as task is what stops a bind for session A from picking up a token
 * minted for session B on the same task (which a reassignment can produce).
 */
export function findWorkerTaskTokenForSession(
    meshId: string,
    taskId: string,
    sessionId: string,
): WorkerTaskToken | null {
    const wanted = String(sessionId || '').trim();
    for (const candidate of tokensForTask(meshId, taskId)) {
        if (!candidate.sessionId || candidate.sessionId === wanted) return candidate;
    }
    return null;
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

// ─── Worker-private HOME ────────────────────────────────────────────────

/**
 * Files a home-rooted provider must still see inside its worker-private HOME
 * for the CLI to stay logged in.
 *
 * `mode` semantics:
 *  - `symlink` — the real file is linked, so a token REFRESHED by the worker
 *    (or by any sibling) is visible to everyone. Auth material must use this;
 *    a copy would freeze a refresh token and silently expire the worker.
 *  - `copy` — worker gets its own snapshot. For files the worker may rewrite
 *    and whose rewrite must not leak back into the user's real config.
 */
export interface WorkerHomeImport {
    /** Path relative to HOME, e.g. `.gemini/antigravity-cli/antigravity-oauth-token`. */
    relativePath: string;
    mode: 'symlink' | 'copy';
    /** When true, a missing source is an error rather than a skip. */
    required?: boolean;
    /**
     * Assert the source is owner-only (0600/0700) before importing. Set on
     * credential material; leave off for shared data directories, which are
     * legitimately group/world-readable and would otherwise be refused.
     */
    requireOwnerOnly?: boolean;
}

export interface WorkerPrivateHomeSpec {
    /** Provider type this spec applies to. */
    providerType: string;
    imports: WorkerHomeImport[];
    /**
     * Directories that must exist (empty) in the private HOME. These are the
     * surfaces being ISOLATED — creating them empty is what stops the CLI from
     * falling back to the real HOME's copy.
     */
    ensureDirs?: string[];
}

/**
 * ★antigravity-cli is the only provider carrying a private HOME in Phase A.
 *
 * Owner decision (2026-08-28, §12-1a): worker-private temp HOME with the auth
 * surface imported. Option (b) — a provider-level config-path override — was
 * measured as unavailable: antigravity exposes no such flag, so there is
 * nothing to point elsewhere.
 *
 * ─── ★The transcript trap (measured, and it decides the shape here) ───────
 *
 * A NAIVE private HOME — an empty tempdir with only the two auth files linked
 * in — silently destroys transcript collection for every antigravity worker.
 *
 * The reason is asymmetric HOME resolution. The worker writes its transcripts
 * under ITS `$HOME/.gemini/antigravity-cli/`, but the DAEMON reads them from
 * `os.homedir()` hard-coded in `providers/native-history/antigravity-cli-
 * transcript.ts` (`antigravityRoot()`, feeding ~8 private call sites) and in
 * `native-history/dispatcher.ts` (`resolveAntigravityPath`). Neither consults
 * the manifest's `watchPath`: the loader discards it (`provider-loader.ts`
 * sets `watchPath: undefined`) because antigravity resolves to the BUILT-IN
 * `reader: "antigravity-cli"` from its spec, not the declarative `source`
 * executor. So the `${VAR}`/`envOverrides` expansion that makes hermes's
 * HERMES_HOME precedent work is never reached on this path.
 *
 * Net effect of a naive tempdir HOME: worker writes to /tmp/…/.gemini/…,
 * daemon reads ~/.gemini/…, and every session reports zero assistant
 * messages. The completion engine would then fall back to screen-scraped
 * evidence — quietly degrading exactly the signal Phase B exists to improve.
 *
 * ─── The shape that avoids it ────────────────────────────────────────────
 *
 * Isolate ONLY the surface that must differ, and link the rest THROUGH to the
 * real home so the daemon's reader keeps working with no code change:
 *
 *  - `.gemini/config/` — created EMPTY and private. This is the coordinator's
 *    `mcp_config.json` surface, i.e. the entire point of the exercise. The
 *    worker's own config is written here, so the coordinator's 60-tool entry
 *    is absent rather than present-and-disabled.
 *  - `.gemini/antigravity-cli/{brain,conversations}` and `history.jsonl` —
 *    SYMLINKED to the real home. The worker writes transcripts into the real
 *    directories, so the daemon's `os.homedir()` reads find them exactly where
 *    they have always been.
 *  - `antigravity-oauth-token` — SYMLINKED, never copied. The CLI refreshes
 *    this blob in place; a copy would strand the worker on a token that
 *    expires mid-task while the real one rotates.
 *  - `settings.json` — COPIED. Carries non-secret onboarding/auth selection
 *    state, then receives the worker trust projection without a write-through
 *    path to the user's real settings.
 *  - `cache/onboarding.json` — COPIED. Suppresses the first-run colour-scheme
 *    and Terms-of-Service TUI, which nobody can answer inside a worker PTY.
 *
 * Launch planning now resolves an absolute trust plan after this copy exists,
 * records/reuses the daemon-owned worker-auto grant, and materializes the
 * provider-native projection into this per-worker file before PTY spawn.
 * Therefore no shared writable trust store or settings symlink is needed.
 *
 * `jetski_state.pbtxt` is deliberately NOT imported. It holds an
 * `installation_uuid` plus a `post_onboarding` block, so it reads like a third
 * onboarding candidate — but the observed hang is gated on
 * `cache/onboarding.json` alone, and the file is an install-identity record:
 * copying it would clone one installation's UUID across every worker HOME,
 * corrupting whatever telemetry or migration bookkeeping keys off it, and
 * symlinking it would expose that identity file to worker writes. Import it
 * only if a first-run screen is ever measured that onboarding.json does not
 * already suppress.
 *
 * ★Choosing symlinks over threading a HOME override through the reader is
 * deliberate. The override route means forwarding `envOverrides` through
 * `createNativeHistoryDispatcher` (which today does not forward it at all) and
 * parameterizing ~8 private call sites — a change to the shared transcript
 * reader, made for one provider, in the phase whose whole promise is
 * "gate off ⇒ byte-identical". Symlinks buy the same isolation with zero
 * change to any read path. If a second home-rooted provider ever needs this,
 * revisit — one provider does not justify re-plumbing the reader.
 */
export const WORKER_PRIVATE_HOME_SPECS: readonly WorkerPrivateHomeSpec[] = [
    {
        providerType: 'antigravity-cli',
        imports: [
            // Security.framework resolves the default keychain through HOME.
            // Keep the worker-private HOME while linking macOS's keychain
            // directory back to the real home. This stays optional and
            // platform-agnostic: hosts without this path use the generic
            // missing-import skip contract below.
            { relativePath: path.join('Library', 'Keychains'), mode: 'symlink' },
            { relativePath: path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'), mode: 'symlink', required: true, requireOwnerOnly: true },
            { relativePath: path.join('.gemini', 'antigravity-cli', 'settings.json'), mode: 'copy', requireOwnerOnly: true },
            // First-run onboarding completion — COPIED, never symlinked. Without
            // it the CLI opens its colour-scheme picker and then the Terms of
            // Service screen inside the worker PTY, where nobody is there to
            // answer: the session sits in `starting` making zero model calls
            // until it is reaped. Private HOMEs are keyed per TASK, so every
            // task would re-onboard without this.
            // Copy rather than symlink because the worker has no reason to
            // rewrite it, and a symlink would let a worker's write land in the
            // real user config. Not `required`: a host that has never run agy
            // (or any non-mac host laid out differently) must still launch, and
            // the generic missing-import skip contract covers it.
            { relativePath: path.join('.gemini', 'antigravity-cli', 'cache', 'onboarding.json'), mode: 'copy' },
            // Transcript surfaces — linked THROUGH so the daemon's
            // os.homedir()-rooted reader still finds what the worker writes.
            // Not `required`: a fresh machine may not have them yet, and the
            // CLI creates them on first use inside the linked-through parent.
            { relativePath: path.join('.gemini', 'antigravity-cli', 'brain'), mode: 'symlink' },
            { relativePath: path.join('.gemini', 'antigravity-cli', 'conversations'), mode: 'symlink' },
            { relativePath: path.join('.gemini', 'antigravity-cli', 'history.jsonl'), mode: 'symlink' },
        ],
        ensureDirs: [path.join('.gemini', 'config')],
    },
];

export function findWorkerPrivateHomeSpec(providerType: string): WorkerPrivateHomeSpec | null {
    const type = String(providerType || '').trim();
    if (!type) return null;
    return WORKER_PRIVATE_HOME_SPECS.find((spec) => spec.providerType === type) || null;
}

export interface PreparedWorkerHome {
    /** Absolute path to the worker-private HOME. */
    home: string;
    /** Imports that were actually materialized. */
    imported: string[];
    /** Imports whose source did not exist (non-required ones only). */
    skipped: string[];
}

/**
 * Materialize a worker-private HOME for a provider that roots its config in `~`.
 *
 * Keyed by (providerType, workspace, sessionKey) so two workers of the same
 * type on the same machine never share one — sharing would reintroduce exactly
 * the cross-worker inheritance this exists to remove.
 *
 * ★Auth files are symlinked with their source permissions left untouched. We
 * verify the source is 0600 and REFUSE to import a world/group-readable auth
 * file: silently widening the exposure of a credential while claiming to
 * "isolate" would be worse than not isolating at all.
 */
export function prepareWorkerPrivateHome(
    spec: WorkerPrivateHomeSpec,
    opts: { workspace: string; sessionKey: string; realHome?: string; baseDir?: string },
): PreparedWorkerHome {
    const realHome = opts.realHome || os.homedir();
    const baseDir = opts.baseDir || path.join(os.tmpdir(), 'adhdev-worker-home');
    const scope = shortHash(`${spec.providerType}${path.resolve(opts.workspace || '')}${opts.sessionKey}`);
    const home = path.join(baseDir, `${spec.providerType}-${scope}`);

    mkdirSync(home, { recursive: true });
    for (const dir of spec.ensureDirs || []) {
        mkdirSync(path.join(home, dir), { recursive: true });
    }

    const imported: string[] = [];
    const skipped: string[] = [];
    for (const entry of spec.imports) {
        const source = path.join(realHome, entry.relativePath);
        const target = path.join(home, entry.relativePath);
        if (!existsSync(source)) {
            if (entry.required) {
                throw new Error(
                    `worker_private_home_missing_required_import: ${entry.relativePath} not found under ${realHome}`,
                );
            }
            skipped.push(entry.relativePath);
            continue;
        }

        // Refuse to import a credential whose source permissions are already
        // loose. See the note above — isolation must not become a laundering
        // step for an over-permissive file. Only asserted for entries flagged
        // as credential material: shared data dirs (brain/, conversations/)
        // are legitimately 0755 and must not trip this.
        if (entry.requireOwnerOnly && process.platform !== 'win32') {
            const mode = statSync(source).mode & 0o777;
            if (mode & 0o077) {
                throw new Error(
                    `worker_private_home_insecure_source: ${entry.relativePath} is mode ${mode.toString(8)} (expected owner-only)`,
                );
            }
        }

        mkdirSync(path.dirname(target), { recursive: true });
        // Replace any stale entry from a previous launch that reused this key.
        try { rmSync(target, { force: true }); } catch { /* best effort */ }

        if (entry.mode === 'symlink') {
            try {
                symlinkSync(source, target);
            } catch (err: any) {
                // win32 without developer mode cannot create symlinks
                // unprivileged. Falling back to a copy keeps the worker
                // authenticated; the refresh-staleness caveat above is the
                // accepted cost on that platform.
                if (process.platform === 'win32') copyFileSync(source, target);
                else throw err;
            }
        } else {
            copyFileSync(source, target);
        }
        imported.push(entry.relativePath);
    }

    return { home, imported, skipped };
}

export interface WorkerTrustHome {
    /** Absolute worker-scoped HOME the trust store is resolved against. */
    home: string;
    imported: string[];
    skipped: string[];
}

/**
 * ★Resolve the worker-scoped HOME used by the TRUST axis, independent of
 * `ADHDEV_WORKER_MCP`.
 *
 * ─── Why this exists separately from resolveWorkerMcpIsolation() ─────────
 *
 * `pre_launch_trust` and worker-MCP isolation share one mechanism (a
 * worker-private HOME) but answer to different requirements, and coupling them
 * produced a live hang:
 *
 *   ADHDEV_WORKER_MCP is OFF by default ⇒ resolveWorkerMcpIsolation() returns
 *   null ⇒ the delegated launch had no `workerHome` ⇒ no trust plan was built
 *   ⇒ fsm-driver's fail-closed branch skipped the pre-trust write ⇒ every
 *   antigravity worker sat forever on "Do you trust the files in this folder?".
 *
 * The MCP axis is a HARDENING feature and is correctly opt-in: with it off the
 * worker keeps the (weaker) isolation it always had, which is a degradation,
 * not a stall. The trust axis is not like that — with it off the worker does
 * not run at all. So it must not inherit the MCP flag's default-off.
 *
 * ─── Why this cannot just resolve `~` to the daemon's HOME ───────────────
 *
 * That is the worker trust leak the fail-closed guard was written for: the
 * worktree path would be appended to the OWNER's personal `trustedWorkspaces`
 * array, silently granting every future interactive `agy` run in that
 * directory a trust the owner never approved. This function therefore always
 * returns a worker-scoped directory under the worker-home base dir, never the
 * real home — and the caller exports it as HOME so the CLI actually reads the
 * projected store rather than the owner's.
 *
 * Reuses WORKER_PRIVATE_HOME_SPECS wholesale, which is what keeps the
 * redirection safe: auth material and transcript directories are symlinked
 * THROUGH to the real home (so the worker stays logged in and the daemon's
 * os.homedir()-rooted transcript reader still finds what the worker writes),
 * while `settings.json` — the trust store itself — is COPIED, so the trust
 * projection has no write-through path back to the user's file.
 *
 * Returns null for a provider with no private-HOME spec (there is nothing to
 * isolate), and null on preparation failure — the caller must then fail closed
 * exactly as before rather than fall back to the real home.
 */
export function resolveWorkerTrustHome(input: {
    providerType: string;
    workspace: string;
    sessionKey: string;
    realHome?: string;
    baseDir?: string;
}): WorkerTrustHome | null {
    const spec = findWorkerPrivateHomeSpec(input.providerType);
    if (!spec) return null;
    try {
        const prepared = prepareWorkerPrivateHome(spec, {
            workspace: input.workspace,
            sessionKey: input.sessionKey,
            realHome: input.realHome,
            baseDir: input.baseDir,
        });
        return { home: prepared.home, imported: prepared.imported, skipped: prepared.skipped };
    } catch (err: any) {
        // Never downgrade to the real home — see the leak note above.
        LOG.warn('WorkerTrust', `worker trust HOME preparation failed for ${input.providerType}: ${err?.message || err}`);
        return null;
    }
}

// ─── Worker MCP config ──────────────────────────────────────────────────

export interface WorkerMcpServerCommand {
    command: string;
    args: string[];
}

export interface WriteWorkerMcpConfigInput {
    /** Provider-declared `meshCoordinator.mcpConfig.path`, verbatim (may start with `~/`). */
    declaredPath: string;
    format: MeshCoordinatorConfigFormat;
    serverName: string;
    workspace: string;
    /** Worker-private HOME, when the provider has one. `~` resolves against this. */
    workerHome?: string;
    /** Omit to write a config with NO servers at all (strongest isolation). */
    server?: WorkerMcpServerCommand;
    /** Minted worker token, carried in the server entry's env. */
    token?: string;
    /**
     * Session bind handed to the worker at spawn, exchanged for the live task
     * token at tool-call time. This — not `token` — is what a real spawn carries,
     * because at spawn there is no attempt to mint a token against (§12.1a).
     */
    bind?: string;
}

/**
 * Resolve a provider-declared config path for a WORKER launch.
 *
 * Mirrors the coordinator's `resolveMcpConfigPath` with one deliberate
 * difference: `~` resolves against the worker-private HOME when there is one.
 * That single substitution is what makes a home-rooted provider isolable at
 * all — the coordinator resolver has no such seam, which is why antigravity
 * and hermes workers currently share the coordinator's global file.
 */
export function resolveWorkerMcpConfigPath(
    declaredPath: string,
    workspace: string,
    workerHome?: string,
): string {
    const trimmed = String(declaredPath || '').trim();
    const home = workerHome || os.homedir();
    if (trimmed === '~') return home;
    if (trimmed.startsWith('~/')) return path.join(home, trimmed.slice(2));
    if (path.isAbsolute(trimmed)) return trimmed;
    return path.join(workspace, trimmed);
}

/**
 * Write the worker's MCP config to the provider-declared path.
 *
 * ★This REPLACES rather than merges. The coordinator writer merges because it
 * must preserve a user's own servers in a file it shares with them. A worker
 * config is different: it is written either into a worker-private HOME or to a
 * temp path the worker alone reads, and the entire point is that nothing the
 * worker did not receive on purpose is reachable. Merging would re-admit the
 * coordinator entry this function exists to remove.
 *
 * Refuses to write to a path inside the REAL home — that would be the
 * coordinator's own config, and clobbering it is the failure mode the design
 * calls out (§3: "치환이 코디를 깨뜨린다").
 */
export function writeWorkerMcpConfig(input: WriteWorkerMcpConfigInput): string {
    if (!isSupportedMeshCoordinatorConfigFormat(input.format)) {
        throw new Error(`worker_mcp_unsupported_format: ${String(input.format)}`);
    }
    const target = resolveWorkerMcpConfigPath(input.declaredPath, input.workspace, input.workerHome);

    const declared = String(input.declaredPath || '').trim();
    if (declared.startsWith('~') && !input.workerHome) {
        throw new Error(
            `worker_mcp_home_rooted_without_private_home: ${declared} would overwrite the coordinator config`,
        );
    }

    const servers: Record<string, any> = {};
    if (input.server) {
        // The bind/token ride INSIDE the config, not in the worker's process
        // env. Both are readable by the worker either way (§3 "남는 리스크"),
        // but keeping them here means the value travels only to the process
        // that reads this file, and never lands in a spawn env that gets
        // inherited further down a process tree.
        //
        // A real spawn carries the BIND; `token` exists for the degenerate case
        // where a caller already holds a live token (and for tests). Both may be
        // present — the server prefers the token and falls back to exchanging
        // the bind, so a config written either way boots.
        const entryEnv: Record<string, string> = {};
        if (input.token) entryEnv.ADHDEV_WORKER_TASK_TOKEN = input.token;
        if (input.bind) entryEnv.ADHDEV_WORKER_SESSION_BIND = input.bind;
        servers[input.serverName] = buildMeshCoordinatorMcpServerEntry(input.format, {
            command: input.server.command,
            args: input.server.args,
            ...(Object.keys(entryEnv).length ? { env: entryEnv } : {}),
        });
    }

    const config: Record<string, any> = { [getMcpServersKey(input.format)]: servers };
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, serializeMeshCoordinatorMcpConfig(config, input.format), 'utf-8');
    return target;
}

// ─── Placeholder expansion ──────────────────────────────────────────────

export const WORKER_HOME_PLACEHOLDER = '{{workerHome}}';
export const WORKER_SESSION_BIND_ENV = 'ADHDEV_WORKER_SESSION_BIND';

/**
 * Expand `{{workerHome}}` in a provider-declared `env.set` value.
 *
 * Returns null when the value needs a worker HOME that this launch does not
 * have — the caller then SKIPS the variable rather than exporting a literal
 * `{{workerHome}}`, which would send the CLI to a nonexistent directory.
 */
export function expandWorkerIsolationPlaceholders(
    value: string,
    isolation: { workerHome?: string },
): string | null {
    if (!value.includes(WORKER_HOME_PLACEHOLDER)) return value;
    if (!isolation.workerHome) return null;
    return value.split(WORKER_HOME_PLACEHOLDER).join(isolation.workerHome);
}

// ─── Top-level resolution ───────────────────────────────────────────────

export interface WorkerMcpIsolationInput {
    providerType: string;
    workspace: string;
    sessionKey: string;
    /** Provider's `meshCoordinator.mcpConfig`, if declared. */
    mcpConfig?: {
        mode?: string;
        format?: string;
        path?: string;
        serverName?: string;
    };
    /** Provider-declared non-file delivery for the worker MCP server. */
    workerMcpDelivery?: WorkerMcpConfigOverrideDeliveryInput;
    /** Minted worker token for the task this worker is being spawned for. */
    token?: string;
    /** Worker MCP server entry. Omit for a servers-{} config. */
    server?: WorkerMcpServerCommand;
    /**
     * Mesh + session this worker is being spawned for. Present ⇒ a session bind
     * is minted and carried in the config, which is what gives the worker a
     * reportable identity (§12.1a). Absent ⇒ Phase A behavior: an isolating
     * config with no worker server surface.
     */
    bindContext?: {
        meshId: string;
        sessionId: string;
        nodeId?: string;
        spawnedForTaskId?: string;
    };
    realHome?: string;
    baseDir?: string;
}

export interface WorkerMcpConfigOverrideDeliveryInput {
    mode: 'config_override';
    flag: string;
    serverName: string;
    commandTemplate: string;
    argsTemplate: string;
    envVarsTemplate: string;
    enabledTemplate: string;
    shellEnvExcludeTemplate?: string;
}

export interface WorkerMcpConfigOverrideDelivery extends WorkerMcpConfigOverrideDeliveryInput {
    command: string;
    args: string[];
    envVars: string[];
    bindEnvVar: typeof WORKER_SESSION_BIND_ENV;
}

export interface WorkerMcpIsolation {
    /** Worker-private HOME, when this provider needs one. */
    workerHome?: string;
    /** Config file actually written, if any. */
    configPath?: string;
    /** Runtime delivery descriptor for providers without an auto-import path. */
    delivery?: WorkerMcpConfigOverrideDelivery;
    /**
     * Session bind minted for this launch, when `bindContext` was supplied and
     * either a config was written or a runtime delivery descriptor was built.
     * ★Never log this value — it is a secret on
     * the same footing as the task token.
     */
    bind?: string;
    /** Human-readable notes for the launch log. */
    notes: string[];
}

/**
 * Build the worker's isolation surface for one launch.
 *
 * Returns null when the gate is off — callers MUST then behave exactly as
 * before. This is the single place the flag is consulted for the config/HOME
 * axis, so "gate off ⇒ byte-identical" is checkable at one seam instead of
 * being spread across every call site.
 *
 * Never throws for a provider it cannot isolate: a provider with no declared
 * mcpConfig path simply gets `notes` explaining why, and the launch proceeds
 * with the pre-existing (weaker) isolation. Failing a spawn outright because a
 * manifest is thin would turn a hardening feature into an outage.
 */
export function resolveWorkerMcpIsolation(
    input: WorkerMcpIsolationInput,
    env: NodeJS.ProcessEnv = process.env,
): WorkerMcpIsolation | null {
    if (!isWorkerMcpEnabled(env)) return null;

    const notes: string[] = [];
    const result: WorkerMcpIsolation = { notes };

    const spec = findWorkerPrivateHomeSpec(input.providerType);
    if (spec) {
        try {
            const prepared = prepareWorkerPrivateHome(spec, {
                workspace: input.workspace,
                sessionKey: input.sessionKey,
                realHome: input.realHome,
                baseDir: input.baseDir,
            });
            result.workerHome = prepared.home;
            notes.push(`private HOME ${prepared.home} (imported: ${prepared.imported.join(', ') || 'none'})`);
            if (prepared.skipped.length) notes.push(`skipped missing imports: ${prepared.skipped.join(', ')}`);
        } catch (err: any) {
            // A private HOME we could not build must NOT silently downgrade to
            // "worker shares the coordinator's home" — that is the exact
            // inheritance being removed. Skip the config write too, and say so.
            notes.push(`private HOME unavailable (${err?.message || err}) — falling back to declared isolation only`);
            LOG.warn('WorkerMcp', `private HOME preparation failed for ${input.providerType}: ${err?.message || err}`);
            return result;
        }
    }


    // Manual providers do not expose an auto-import path. A declared runtime
    // delivery therefore has to run before the path/format gates below. The
    // bind secret itself is deliberately absent from the descriptor's argv
    // templates; cli-manager places it in the parent CLI environment, and the
    // provider forwards only its variable NAME to the MCP child.
    const runtimeDelivery = input.workerMcpDelivery;
    if (runtimeDelivery?.mode === 'config_override') {
        if (!input.server || !input.bindContext?.meshId || !input.bindContext?.sessionId) {
            notes.push(`worker MCP config_override delivery unavailable for ${input.providerType} — missing server or bind context`);
            return result;
        }
        try {
            const binding = mintWorkerSessionBind(input.bindContext);
            result.bind = binding.bind;
            result.delivery = {
                ...runtimeDelivery,
                command: input.server.command,
                args: [...input.server.args],
                envVars: [WORKER_SESSION_BIND_ENV],
                bindEnvVar: WORKER_SESSION_BIND_ENV,
            };
            notes.push(`worker MCP config_override delivery prepared for ${runtimeDelivery.serverName} (session bind issued for ${binding.sessionId})`);
        } catch (err: any) {
            notes.push(`worker MCP config_override delivery failed (${err?.message || err})`);
        }
        return result;
    }
    const declaredPath = typeof input.mcpConfig?.path === 'string' ? input.mcpConfig.path.trim() : '';
    const format = input.mcpConfig?.format;
    const serverName = (input.mcpConfig?.serverName || 'adhdev-mesh').trim();

    if (!declaredPath) {
        notes.push(`no mcpConfig.path declared for ${input.providerType} — no worker config written`);
        return result;
    }
    if (!isSupportedMeshCoordinatorConfigFormat(format)) {
        notes.push(`mcpConfig.format ${String(format) || 'absent'} is not auto-import writable — relying on declared arg isolation`);
        return result;
    }
    if (declaredPath.startsWith('~') && !result.workerHome) {
        // hermes-cli lands here in Phase A (owner decision §12-3: hermes
        // deferred). Writing would clobber the coordinator's own config.
        notes.push(`${declaredPath} is home-rooted but ${input.providerType} has no private HOME — refusing to overwrite the coordinator config`);
        return result;
    }

    // Mint the session bind BEFORE the write, so the config can carry it. A bind
    // is only useful alongside a server entry — with no server there is no MCP
    // process to exchange it, so minting one would be dead state.
    //
    // ★Deliberately NOT minted when the config write below fails: a live bind
    // whose worker never received it is a token-shaped object nobody holds,
    // and it would keep the session's prior (revoked) bind from being the
    // honest "this session has no reportable worker" answer.
    let pendingBind: WorkerSessionBinding | null = null;
    if (input.server && input.bindContext?.meshId && input.bindContext?.sessionId) {
        try {
            pendingBind = mintWorkerSessionBind(input.bindContext);
        } catch (err: any) {
            notes.push(`worker session bind mint failed (${err?.message || err})`);
        }
    }

    try {
        result.configPath = writeWorkerMcpConfig({
            declaredPath,
            format,
            serverName,
            workspace: input.workspace,
            workerHome: result.workerHome,
            server: input.server,
            token: input.token,
            ...(pendingBind ? { bind: pendingBind.bind } : {}),
        });
        if (pendingBind) result.bind = pendingBind.bind;
        // The bind itself is a secret and never enters the note text.
        notes.push(
            `worker MCP config written to ${result.configPath}`
            + (pendingBind ? ` (session bind issued for ${pendingBind.sessionId})` : ''),
        );
    } catch (err: any) {
        if (pendingBind) revokeWorkerSessionBind(pendingBind.bind);
        notes.push(`worker MCP config write failed (${err?.message || err})`);
        LOG.warn('WorkerMcp', `config write failed for ${input.providerType}: ${err?.message || err}`);
    }

    return result;
}

// ─── Token exchange (the daemon side of the bind) ───────────────────────

export interface WorkerTokenExchangeResult {
    token: string;
    meshId: string;
    taskId: string;
    attemptId?: string;
    sessionId: string;
    nodeId?: string;
}

/**
 * Exchange a session bind for the live task token, given a resolver that answers
 * "which task is this session's CURRENT attempt on".
 *
 * ★The resolver is injected rather than imported so this module stays free of
 * the runtime store — `worker-mcp-isolation` is on the launch path and must not
 * drag the ledger into it (and the import-boundary gate would object). The
 * caller passes the lookup; this function owns the fail-closed policy.
 *
 * ★Every authoritative field comes from the DAEMON side: the bind names only a
 * session, the resolver names the task, and the token is looked up from the mint
 * table. Nothing the worker sent is trusted beyond "here is my bind".
 *
 * Returns null — fail-closed, never "unbound, allow through" — when the bind is
 * unknown/revoked, when the session has no current task, or when that task has
 * no live token (the normal shape after the task went terminal, which is exactly
 * when a report must be refused).
 */
export function exchangeWorkerSessionBind(
    bind: unknown,
    resolveCurrentTask: (meshId: string, sessionId: string) => { taskId: string; attemptId?: string } | null,
): WorkerTokenExchangeResult | null {
    const binding = verifyWorkerSessionBind(bind);
    if (!binding) return null;

    let current: { taskId: string; attemptId?: string } | null = null;
    try {
        current = resolveCurrentTask(binding.meshId, binding.sessionId);
    } catch {
        // A resolver failure is not evidence of authority — fail closed.
        return null;
    }
    if (!current?.taskId) return null;

    const token = findWorkerTaskTokenForSession(binding.meshId, current.taskId, binding.sessionId);
    if (!token) return null;

    // ★The attemptId is taken from the TOKEN, not from the resolver: the token is
    // what the reducer's causality checks are written against, and a token minted
    // for a superseded attempt must present ITS attemptId so the reducer can
    // reject it as stale. Papering over that difference here would move a
    // rejection the ledger is designed to make into a silent acceptance.
    return {
        token: token.token,
        meshId: binding.meshId,
        taskId: current.taskId,
        ...(token.attemptId ? { attemptId: token.attemptId } : {}),
        sessionId: binding.sessionId,
        ...(binding.nodeId ? { nodeId: binding.nodeId } : {}),
    };
}
