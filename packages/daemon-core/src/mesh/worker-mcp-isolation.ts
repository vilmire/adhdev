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
 * Everything here is behind `ADHDEV_WORKER_MCP` — ★default ON since 2026-09-18
 * (owner approval; see runtime-defaults.ts for the flip and its rationale).
 * With the gate explicitly off, `resolveWorkerMcpIsolation()` returns null and
 * every caller must fall through to byte-identical prior behavior. That
 * fall-through is still load-bearing: it is the supported rollback path, not a
 * dead branch.
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
import { existsSync, mkdirSync, writeFileSync, symlinkSync, copyFileSync, statSync, rmSync, realpathSync } from 'fs';

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
    /**
     * Path relative to the PRIVATE ROOT — i.e. the path as the CLI sees it under
     * the override, e.g. `.gemini/antigravity-cli/antigravity-oauth-token` for a
     * `HOME`-rooted spec, or plain `auth.json` for codex under `CODEX_HOME`.
     *
     * ★The real-home SOURCE is not always this same path. When the spec declares
     * `configRootPrefix`, the private root stands in for `~/<prefix>`, so the
     * source is `~/<prefix>/<relativePath>` while the target stays
     * `<root>/<relativePath>`. `prepareWorkerPrivateHome` applies that.
     *
     * ★Why this is spelled out (live regression, rc.16, fixed 2026-09-19).
     *
     * The four env-var specs were written with root-relative paths — correct for
     * the target — but `prepareWorkerPrivateHome` joined BOTH source and target
     * from the one string. So codex looked for `~/auth.json` and kimi for
     * `~/config.toml`; neither exists (they live under `~/.codex` and
     * `~/.kimi-code`). The entries are deliberately NOT `required` — see each
     * spec for the fail-OPEN argument, which remains right — so every source
     * missed the `existsSync` check and was SKIPPED SILENTLY. The private root
     * was created empty and the CLI launched with no credentials at all:
     *
     *   codex-cli → exit 1 after 3s, `unexpected_exit`
     *   kimi      → "Model 'kimi-code/k3' is not configured in config.toml"
     *
     * Measured on disk at the time: of 34 `codex-cli-*` private roots, 33 were
     * completely empty and ZERO contained `auth.json`. The `HOME`-rooted specs
     * (antigravity) were unaffected, which is why the class went unnoticed.
     *
     * ★A test asserting `existsSync(source)` or inspecting `skipped` cannot catch
     * this — a skip is indistinguishable from a legitimately absent optional
     * file. The regression test asserts the TARGET exists inside the root.
     */
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

/**
 * A surface whose path inside HOME is not knowable until launch time because it
 * is derived from the WORKSPACE.
 *
 * ★Why this exists at all (measured 2026-09-17, cursor-cli).
 *
 * `WorkerHomeImport.relativePath` is a static string, which works for every
 * antigravity surface because antigravity roots its transcripts at a fixed
 * `~/.gemini/antigravity-cli/conversations`. cursor does not: it files each
 * workspace under `~/.cursor/projects/<slug>/`, where `<slug>` is derived from
 * the workspace path. A static spec cannot name that directory.
 *
 * The daemon still reads transcripts from the REAL home — `expandPath()` in
 * `providers/spec/native-history-executor.ts` expands a literal `~` through
 * `os.homedir()` unconditionally, consulting `envOverrides` only for `${VAR}`
 * syntax. So a cursor worker writing transcripts into its private HOME would be
 * invisible to the daemon and every cursor worker would report zero assistant
 * messages — the same trap documented for antigravity below, arriving through a
 * path a static `relativePath` cannot express.
 *
 * ★`relativePath` here is deliberately the LEAF (`agent-transcripts`), never the
 * project directory itself. The project directory also holds `mcp-approvals.json`
 * and `.workspace-trusted`; linking the parent would route the worker's approval
 * writes straight back into the owner's real store — re-opening exactly the leak
 * the private HOME exists to close.
 */
export interface WorkerWorkspaceLink {
    /**
     * Directory under HOME that holds one entry per workspace,
     * e.g. `.cursor/projects`.
     */
    projectsDir: string;
    /**
     * Surface INSIDE the per-workspace directory to link through. Must be a
     * leaf, not the per-workspace directory itself — see the note above.
     */
    relativePath: string;
    mode: 'symlink';
}

export interface WorkerPrivateHomeSpec {
    /** Provider type this spec applies to. */
    providerType: string;
    /**
     * ★Environment variable the CLI reads its CONFIG ROOT from, when that root
     * is not `$HOME`.
     *
     * Absent (antigravity, cursor, grok) means the provider roots its config in
     * `~`, so the launch seam redirects `HOME` itself and the private directory
     * IS the worker's home.
     *
     * Present (codex, kimi, opencode, hermes) means the CLI exposes a dedicated
     * config-root variable, and redirecting that variable is strictly cheaper
     * and safer than redirecting `HOME`:
     *
     *  - `HOME` is read by everything the worker spawns — git, ssh, the shell,
     *    every tool the agent invokes. Repointing it to isolate ONE CLI's MCP
     *    table changes the behavior of the whole process tree, and each surface
     *    that breaks has to be linked back one file at a time. That is the debt
     *    the three `HOME`-rooted specs above carry, and it is only paid because
     *    those CLIs offer no alternative.
     *  - A dedicated variable moves exactly the config root and nothing else,
     *    so surfaces the CLI keeps OUTSIDE that root (opencode's `auth.json`
     *    under `XDG_DATA_HOME`) stay reachable with no import at all.
     *
     * ★Measured, not assumed — each value below was verified by running the
     * installed CLI with the variable pointed at an empty directory and
     * confirming the owner's MCP servers disappeared. See each spec's comment.
     *
     * When set, `~`-rooted `mcpConfig.path` values still resolve against the
     * private directory (that is what makes the provider isolable), but the
     * launch seam must NOT export `HOME` — see `cli-delegated-launch.ts`.
     */
    homeEnvVar?: string;
    /**
     * ★The HOME-relative directory that the private root STANDS IN FOR.
     *
     * Only meaningful alongside `homeEnvVar`. When the env var names a config
     * directory rather than a home, the private root IS that directory — so the
     * real-home counterpart of anything inside it lives one segment deeper, at
     * `~/<prefix>/…`, while inside the root it sits at the top level.
     *
     * ★This asymmetry governs TWO axes, and both must honour it:
     *
     *  1. **Config write** (`resolveWorkerMcpConfigPath`). The declared
     *     `mcpConfig.path` is shared with the COORDINATOR writer, which resolves
     *     it against the real home and must keep doing so — so it cannot be
     *     rewritten to suit the worker. The prefix is collapsed off the declared
     *     `~/<prefix>/…` path so the worker writes where the CLI actually reads.
     *
     *  2. **Imports** (`prepareWorkerPrivateHome`). `WorkerHomeImport.relativePath`
     *     is declared ROOT-relative — the path as the CLI sees it under the
     *     override. The prefix is therefore PREPENDED to reach the real-home
     *     source. See `WorkerHomeImport.relativePath` for the measurements, and
     *     for the live regression that established this field must span both.
     *
     * Measured 2026-09-19 (all three under an override pointed at a scratch dir):
     *
     *   HERMES_HOME=<dir> hermes config path     → <dir>/config.yaml
     *   HERMES_HOME=<dir> hermes config env-path → <dir>/.env
     *   CODEX_HOME=<dir with auth.json AT ROOT>  codex login status
     *     → "Logged in using ChatGPT";  nested <dir>/.codex/auth.json → "Not logged in"
     *   KIMI_CODE_HOME=<dir with config.toml AT ROOT> kimi --prompt "say OK"
     *     → ran to completion;  nested <dir>/.kimi-code/… → "No model configured",
     *       identical to an EMPTY root (so the nested layout imports nothing)
     *
     * Absent means the private root is a HOME (antigravity, cursor, grok — they
     * redirect `HOME` itself, so real and private paths coincide) or a root the
     * declared paths are already relative to (opencode: `XDG_CONFIG_HOME`, whose
     * `opencode/` subdirectory is named explicitly in `ensureDirs`).
     */
    configRootPrefix?: string;
    imports: WorkerHomeImport[];
    /**
     * Directories that must exist (empty) in the private HOME. These are the
     * surfaces being ISOLATED — creating them empty is what stops the CLI from
     * falling back to the real HOME's copy.
     */
    ensureDirs?: string[];
    /**
     * Surfaces keyed by a workspace-derived directory name, resolved at prepare
     * time from `opts.workspace`. See `WorkerWorkspaceLink`.
     */
    workspaceLinks?: WorkerWorkspaceLink[];
}

/**
 * Derive cursor's per-workspace project directory name from a workspace path.
 *
 * ★The rule is: collapse every run of non-alphanumeric characters to ONE `-`,
 * then strip leading/trailing dashes. Not a per-separator substitution.
 *
 * ★This was measured live 2026-09-17 by running `cursor-agent` under an
 * isolated HOME and reading back the directory it created — and the first
 * measurement got it WRONG in a way worth recording, because it is the exact
 * silent-failure this whole mechanism is exposed to.
 *
 * The first probe used a workspace whose path contained no dashes, so
 * "replace each separator with a dash" and "collapse runs of non-alphanumerics"
 * produced identical output and the probe could not tell them apart. Against a
 * real ADHDev worktree path — which contains `/-Users-vilmire--adhdev-…` — the
 * two rules diverge: cursor writes `…-501-Users-vilmire-adhdev-…` where the
 * naive rule yields `…-501--Users-vilmire--adhdev-…`. A second probe with a
 * deliberately dash-laden path (`/-lead--double/x` → `…-lead-double-x`) settled
 * it, and the collapse rule then reproduced all three live observations exactly,
 * including a 186-character slug.
 *
 * ★The failure mode is silent: a wrong slug is not an error, it is a symlink to
 * a directory the CLI never writes. Transcripts would land in the worker's
 * private HOME, the daemon would glob the real home and find nothing, and every
 * cursor worker would report zero assistant messages with no diagnostic. Do not
 * "simplify" this back to a separator substitution.
 *
 * ★No length cap: a 186-char slug was produced intact. The `…--<7hex>`-suffixed
 * directories in the owner's real store are a SEPARATE cursor disambiguation
 * case (five distinct worktree paths sharing one 51-char prefix), deliberately
 * not modelled here — it has not been measured, and guessing at it would
 * reintroduce exactly the silent mis-key described above.
 *
 * Resolves symlinks first because cursor keys off the path it actually opens.
 */
export function deriveCursorWorkspaceSlug(workspace: string, realpath?: (p: string) => string): string {
    const raw = path.resolve(String(workspace || ''));
    let resolved = raw;
    try {
        resolved = (realpath || realpathSync)(raw);
    } catch {
        // A workspace that does not exist yet keeps its literal path — the
        // launch will create it, and the unresolved form is what cursor sees.
    }
    // Collapse every run of non-alphanumerics (separators, dashes, dots, win32
    // drive colons) to a single dash, then trim the ends.
    return resolved.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
    /**
     * ★cursor-cli (owner-approved 2026-09-17). Two measured gates, not one.
     *
     * A cursor worker was observed holding ZERO of its six worker tools while
     * carrying FIFTY of the owner's personal global MCP servers. The worker MCP
     * config the daemon writes is correct — cursor's READ side drops it:
     *
     *  ① Approval gate. `~/.cursor/projects/<slug>/mcp-approvals.json` is an
     *     allowlist keyed `<serverName>-<contentHash>`. The worker entry hashes
     *     differently from the coordinator's (different args and env), so it is
     *     unapproved — and an unapproved server is dropped SILENTLY, with no
     *     prompt. Worktree slugs have no approvals file at all, and the
     *     empty/absent state was measured to be the same silent drop.
     *  ② Global merge. cursor unions `~/.cursor/mcp.json` with the workspace
     *     config. The owner's personal servers arrive through that union, which
     *     is why the workspace-scoped config alone never isolated anything.
     *     (opencode looked isolated only because the owner has no global block.)
     *
     * The private HOME answers ②: `.cursor` is created EMPTY, so there is no
     * global `mcp.json` to union in. `meshCoordinator.launchArgs`'
     * `--approve-mcps` answers ①, and the two are a PAIR — `--approve-mcps`
     * without the empty HOME would approve the owner's global servers wholesale,
     * which is strictly worse than the status quo. Do not ship either alone.
     *
     * `cli-config.json` is deliberately NOT imported. It holds no token (auth
     * rides the keychain, and a `Library/Keychains` symlink alone was measured
     * sufficient: `✓ Logged in as …`), cursor REWRITES it on every invocation so
     * a symlink would let a worker mutate the owner's file, and it is 0644 so
     * `requireOwnerOnly` would throw on it. cursor recreates it unprompted.
     *
     * ★Workspace trust resets inside a private HOME, and the thing that keeps
     * cursor workers from wedging on the trust prompt is `--trust` in the
     * provider's `spawn.args`. An arg refactor that drops it stalls EVERY cursor
     * worker — the prompt is unanswerable inside a worker PTY.
     */
    {
        providerType: 'cursor-cli',
        imports: [
            // Auth. Measured sufficient on its own for `✓ Logged in as …`.
            // No requireOwnerOnly: this is a shared macOS data directory, not a
            // single credential file, and it is legitimately group-readable.
            { relativePath: path.join('Library', 'Keychains'), mode: 'symlink' },
        ],
        // The ISOLATED surface: empty means the owner's global `~/.cursor/mcp.json`
        // is not reachable and therefore cannot be merged in.
        ensureDirs: ['.cursor'],
        workspaceLinks: [
            // Transcripts must stay readable by the daemon, which globs the REAL
            // `~/.cursor/projects/*/agent-transcripts/*`. Leaf only — the parent
            // project directory holds `mcp-approvals.json` and
            // `.workspace-trusted`, and linking it would write the worker's
            // approvals into the owner's store.
            { projectsDir: path.join('.cursor', 'projects'), relativePath: 'agent-transcripts', mode: 'symlink' },
        ],
    },
    /**
     * ★grok-cli (measured live 2026-09-18, grok 1.0.34).
     *
     * A grok worker was observed holding SIXTY-ONE tools where six were
     * expected: the owner's personal `blender` (31), `godot` (13) and `tasks`
     * (11) servers were all present, and the worker's system prompt carried the
     * owner's cursor `user_rule` verbatim.
     *
     * ─── ★The measured mechanism, and why the obvious guess was wrong ────────
     *
     * The natural hypothesis was "grok shares `.mcp.json` with claude, so
     * claude's isolation does not cover grok". That is NOT what happens, and
     * acting on it would have fixed nothing.
     *
     * `grok inspect` labels every leaked server `.mcp.json [cursor]`, and the
     * bracketed tag is grok's COMPAT-SOURCE label, not a file path. grok ships a
     * harness-compatibility layer (`xai_grok_cursor::register()` in the binary;
     * `grok inspect` renders it as a "Harness Compatibility" block with
     * per-component `skills/rules/agents/mcps/hooks/sessions` toggles, all
     * defaulting to ON) that imports cursor's, claude's and codex's
     * configuration alongside its own.
     *
     * The leak is therefore HOME-scoped, and it was isolated to a single file by
     * probe: an otherwise-empty HOME containing ONLY `~/.cursor/mcp.json` — with
     * no `.mcp.json` anywhere and an empty workspace — still produced the server.
     * The owner's `~/.cursor/mcp.json` holds exactly `godot`, `blender`,
     * `context7`; `grok mcp list` (grok's own native store) is EMPTY. The same
     * compat layer imports cursor `rules`, which is where the `user_rule` in the
     * worker prompt came from.
     *
     * ∴ the leak arrives through `$HOME`, and a worker-private HOME closes it —
     * the identical shape cursor-cli already uses, for the identical reason.
     *
     * ─── Why the env toggles are NOT the fix ────────────────────────────────
     *
     * The binary exposes `GROK_CURSOR_MCPS_ENABLED` / `GROK_CLAUDE_MCPS_ENABLED`
     * (and per-component siblings), and setting them to `0` was measured to work
     * — too well. grok classifies the WORKSPACE `.mcp.json` under the same
     * compat source, so the toggle marks `adhdev-mesh` `[disabled]` along with
     * the owner's servers and the worker boots with zero tools. It is the
     * `--approve-mcps`-without-a-private-HOME failure in mirror image: an
     * isolation knob that also erases the surface being granted. Do not add
     * these to `env.set`.
     *
     * ─── ★The transcript trap (same class as antigravity's, and it applies) ──
     *
     * grok's manifest declares `nativeHistory.watchPath` as
     * `~/.grok/sessions/**` + chat_history.jsonl`, and `expandPath()` in
     * `providers/spec/native-history-executor.ts` expands a literal `~` through
     * `os.homedir()` UNCONDITIONALLY — `envOverrides` is consulted only for
     * `${VAR}` syntax. So a naive private HOME would have the worker writing
     * sessions under `/tmp/…/.grok/sessions` while the daemon globs
     * `~/.grok/sessions`, and every grok worker would report zero assistant
     * messages with no diagnostic.
     *
     * `.grok/sessions` is therefore SYMLINKED through to the real home, and this
     * was verified end-to-end rather than reasoned about: a headless run under a
     * prepared private HOME wrote its transcript directory into the REAL
     * `~/.grok/sessions/` (URL-encoded per cwd, as grok does).
     *
     * ─── What is isolated vs. linked ────────────────────────────────────────
     *
     *  - `.cursor` / `.claude` — created EMPTY. These are the ISOLATED surfaces:
     *    empty means the compat layer finds no owner config to import, which is
     *    the entire point. (`.grok` gets created implicitly by the imports.)
     *  - `auth.json` — SYMLINKED, never copied. grok refreshes this blob in
     *    place; a copy would strand the worker on a credential that expires
     *    mid-task while the real one rotates. Measured sufficient on its own: a
     *    headless run under the private HOME answered normally.
     *  - `.grok/sessions` — SYMLINKED. The transcript trap above.
     *  - `config.toml` — COPIED. Carries the owner's model default and
     *    `permission_mode`, which a worker should inherit, but grok REWRITES it
     *    (`grok mcp add` writes here), so a symlink would let a worker mutate
     *    the owner's file. It is 0644, so `requireOwnerOnly` must NOT be set.
     *  - `version.json` / `bin` — SYMLINKED so the worker resolves the same
     *    installed build and does not re-report its channel as `[unknown]`.
     *
     * `trusted_folders.toml` is deliberately NOT imported, and the resulting
     * `Project trusted: no` is ACCEPTED rather than worked around. In grok,
     * folder trust gates HOOK and PLUGIN execution — not the session — and every
     * probe ran to completion untrusted with no prompt. A worker that executes
     * none of the owner's project hooks is the isolation goal, not a regression.
     * Importing it would hand the worker the owner's hook-execution grants; a
     * symlink would additionally let a worker write new grants into the owner's
     * store, which is the worker-trust leak `resolveWorkerTrustHome()` exists to
     * prevent.
     *
     * ★No `delegatedWorkerIsolation.args` rule is declared for grok, and that is
     * correct, not an omission. cursor needs `--approve-mcps` because cursor
     * silently drops unapproved servers; grok has no approval gate — the private
     * HOME alone was measured to yield exactly one server (`adhdev-mesh`, source
     * `config`) with the owner's servers absent. The manifest's existing
     * `mcpConfig.path: ".mcp.json"` already lands the worker config where grok
     * reads it, so no path change is needed either.
     */
    {
        providerType: 'grok-cli',
        imports: [
            // Auth. Symlinked so an in-place refresh stays shared — see above.
            { relativePath: path.join('.grok', 'auth.json'), mode: 'symlink', required: true, requireOwnerOnly: true },
            // Transcripts — linked THROUGH so the daemon's os.homedir()-rooted
            // `watchPath` still finds what the worker writes. Not `required`: a
            // fresh machine may not have the directory yet, and grok creates it
            // on first use inside the linked-through parent.
            { relativePath: path.join('.grok', 'sessions'), mode: 'symlink' },
            // Non-secret preferences (model default, permission_mode). COPIED —
            // grok rewrites this file, and it is 0644 so it must not assert
            // owner-only.
            { relativePath: path.join('.grok', 'config.toml'), mode: 'copy' },
            // Installed-build identity, so the worker resolves the same version
            // and channel rather than reporting `[unknown]`.
            { relativePath: path.join('.grok', 'version.json'), mode: 'symlink' },
            { relativePath: path.join('.grok', 'bin'), mode: 'symlink' },
        ],
        // The ISOLATED surfaces: empty means grok's harness-compatibility layer
        // has no owner cursor/claude config to import — neither MCP servers nor
        // the `user_rule` that was observed in the worker prompt.
        ensureDirs: ['.cursor', '.claude'],
    },
    /**
     * ★codex-cli (measured live 2026-09-19, codex-cli 0.154.0).
     *
     * ─── The observation ────────────────────────────────────────────────────
     *
     * A codex worker was found RUNNING the owner's `node_repl` MCP server as a
     * child process. Not inferred from config — the child process was observed.
     *
     * ─── Why the existing rule did not stop it ──────────────────────────────
     *
     * codex's `delegatedWorkerIsolation.args` declares ONE `config_override`:
     * `-c mcp_servers.adhdev-mesh.enabled=false`. That disables the coordinator
     * entry by NAME, which is the only entry it knows to name. Every OTHER
     * server in `~/.codex/config.toml` is untouched — on this machine that is
     * `node_repl` and `computer-use`.
     *
     * This is the structural flaw in name-based disabling: it enumerates what to
     * remove, so it can only ever remove what was enumerated when it was written.
     * A server the owner adds tomorrow is inherited by every worker, silently.
     * An allow-list (isolate the root, then add back exactly one server) has the
     * opposite failure mode, which is the correct one here.
     *
     * ─── ★The fix, and why it is NOT a private HOME ─────────────────────────
     *
     * codex reads its config root from `$CODEX_HOME` (the binary's own `--help`
     * documents it under `--profile`: "Layer $CODEX_HOME/<name>.config.toml on
     * top of the base user config"). Measured on the installed 0.154.0:
     *
     *   CODEX_HOME=<empty dir> codex mcp list
     *     → "No MCP servers configured yet."      (owner's three are gone)
     *   CODEX_HOME=<dir with auth.json linked> codex login status
     *     → "Logged in using ChatGPT"             (auth survives)
     *
     * So one variable isolates the entire MCP table, and ONE symlink keeps the
     * worker authenticated. `HOME` is left alone, so git/ssh/shell inside the
     * worker behave exactly as before — see `homeEnvVar` above for why that
     * matters.
     *
     * ★`auth.json` is SYMLINKED, never copied. codex refreshes the ChatGPT token
     * in place; a copy would strand a long worker on a credential that expires
     * mid-task while the real one rotates. It is 0600, so `requireOwnerOnly`
     * holds and a loosened source is refused rather than laundered.
     *
     * ★`config.toml` is deliberately NOT imported, and that is the whole point:
     * it is the file the MCP table lives in. Importing it in any mode would
     * re-admit `node_repl`. The cost is that the worker loses the owner's
     * non-MCP preferences (model, sandbox policy) and falls back to codex's
     * built-in defaults — accepted, because the alternative is a filtered copy
     * that re-derives the enumeration failure described above.
     *
     * The worker MCP server arrives via `workerMcpDelivery`
     * (`config_override`), which injects it on argv and therefore does not
     * depend on any file in the config root. That part is unaffected by the
     * private root and remains correct.
     *
     * ★The `adhdev-mesh.enabled=false` rule, however, is NOT "redundant but
     * harmless" alongside this private root — an earlier revision of this
     * comment said so, and that was wrong. Measured 2026-09-19: because
     * `config.toml` is not imported, the entry does not exist in the private
     * root, so the override CREATES one carrying only `enabled=false`. codex
     * requires a transport (`command`/`url`) on every `mcp_servers` entry and
     * rejects the entire config —
     *
     *   Error loading config.toml: invalid transport
     *   in `mcp_servers.adhdev-mesh`
     *
     * — so the CLI exits before the session starts. The rule is therefore
     * declared `withholdWithPrivateHome: true` (provider manifest 1.1.23) and
     * applies only when there is no private root, which is exactly the
     * `ADHDEV_WORKER_MCP`-off case it was kept for. See the launch-seam
     * comment in `commands/cli-delegated-launch.ts`.
     */
    {
        providerType: 'codex-cli',
        homeEnvVar: 'CODEX_HOME',
        // `CODEX_HOME` names the `.codex` directory ITSELF, so `auth.json` sits
        // at the ROOT of the private dir while its real counterpart is
        // `~/.codex/auth.json`. Measured 2026-09-19: an `auth.json` linked at the
        // root reports "Logged in using ChatGPT"; the same link nested at
        // `<root>/.codex/auth.json` reports "Not logged in", exactly like an
        // empty root. Without this the import source resolved to `~/auth.json`,
        // which does not exist — see `WorkerHomeImport.relativePath`.
        configRootPrefix: '.codex',
        imports: [
            // ★NOT `required`. A failed required import aborts the private root
            // and falls back to the owner's config — a fail-OPEN for a spec
            // whose entire purpose is isolation, and the exact leak measured
            // here. A host authenticating codex by API key has no `auth.json`
            // and must still get an isolated worker.
            { relativePath: 'auth.json', mode: 'symlink', requireOwnerOnly: true },
        ],
    },
    /**
     * ★kimi (measured live 2026-09-19, kimi 2.0.0).
     *
     * ─── The gap ────────────────────────────────────────────────────────────
     *
     * kimi merges THREE MCP sources: `$KIMI_CODE_HOME/mcp.json` (global), the
     * repo-root `.mcp.json`, and `<cwd>/.kimi-code/mcp.json`. The daemon writes
     * the worker config to the third, so the first two are inherited.
     *
     * On this machine `~/.kimi-code/mcp.json` does not currently exist, so the
     * gap is DORMANT, not harmless: the day the owner adds a global server every
     * kimi worker inherits it, with no signal. Closing it now costs one env var.
     *
     * ─── ★The fix, and the measurement that makes it cheap ──────────────────
     *
     * `$KIMI_CODE_HOME` relocates kimi's entire home. Pointed at an empty dir,
     * kimi lost auth ("No model configured") — proving `config.toml` and
     * `credentials/` are read from there, i.e. the redirect is real.
     *
     * ★The decisive measurement: `~/.kimi-code/config.toml` contains ZERO `mcp`
     * declarations (verified by grep — the MCP table lives only in the separate
     * `mcp.json`). So `config.toml` can be symlinked through WHOLE, carrying the
     * owner's model/provider/auth settings, without carrying a single MCP entry.
     * The isolated surface is simply the absence of `mcp.json` in the private
     * root. Verified end-to-end: a private `KIMI_CODE_HOME` with the surfaces
     * below linked ran a real prompt to completion ("OK") — auth intact.
     *
     * `config.toml` is SYMLINKED rather than copied because it carries OAuth
     * storage keys that rotate; the same in-place-refresh argument as every
     * other credential here. It is 0600, so `requireOwnerOnly` holds.
     *
     * ★Sessions/logs are linked through so the worker's transcripts stay where
     * the daemon reads them — the same trap documented at length for antigravity
     * and grok. `session_index.jsonl` is the index the CLI appends to.
     */
    {
        providerType: 'kimi',
        homeEnvVar: 'KIMI_CODE_HOME',
        // `KIMI_CODE_HOME` names the `.kimi-code` directory ITSELF — the surfaces
        // below sit at the ROOT of the private dir, while their real
        // counterparts are `~/.kimi-code/…`. Measured 2026-09-19: the root
        // layout ran `kimi --prompt "say OK"` to completion; the same links
        // nested at `<root>/.kimi-code/…` failed with "No model configured",
        // byte-identical to an EMPTY root — i.e. the nested layout imports
        // nothing. That empty-root failure is the live rc.16 symptom.
        configRootPrefix: '.kimi-code',
        imports: [
            // Auth + model config. Carries no MCP entries (measured), so linking
            // it whole does not re-admit anything this spec exists to exclude.
            //
            // ★NOT `required`, deliberately. A failed required import aborts the
            // whole private root and falls back to "worker shares the owner's
            // config" — for an ISOLATION spec that is a fail-OPEN, and it would
            // trigger on any host that has not yet run kimi interactively. An
            // unauthenticated worker fails loudly and locally; a silently
            // un-isolated one does not.
            { relativePath: 'config.toml', mode: 'symlink', requireOwnerOnly: true },
            { relativePath: 'credentials', mode: 'symlink', requireOwnerOnly: true },
            // 0755 on disk — must NOT assert owner-only.
            { relativePath: 'oauth', mode: 'symlink' },
            // Install/region identity, so the worker does not re-onboard.
            { relativePath: 'region', mode: 'symlink' },
            { relativePath: 'device_id', mode: 'symlink', requireOwnerOnly: true },
            // Transcript surfaces — linked THROUGH to the real home.
            { relativePath: 'sessions', mode: 'symlink' },
            { relativePath: 'session_index.jsonl', mode: 'symlink' },
        ],
    },
    /**
     * ★opencode (measured live 2026-09-19).
     *
     * ─── The gap, and the measurement that redirected the fix ───────────────
     *
     * opencode merges the global `~/.config/opencode/opencode.json` into every
     * launch alongside the project config. Like kimi this is currently DORMANT
     * (the owner's global file declares no `mcp` block — which is precisely why
     * opencode "looked isolated" in the earlier cursor investigation) and would
     * activate silently the day a global server is added.
     *
     * ★The obvious fix — `OPENCODE_CONFIG`, which names an explicit config file
     * — was measured and REJECTED. It MERGES rather than replaces:
     *
     *   XDG_CONFIG_HOME=<dir with decoy-global>  OPENCODE_CONFIG=<worker file>
     *     → `opencode mcp list` reported BOTH `decoy-global` and the worker
     *       server. 2 servers, not 1.
     *
     * Pointing a config-FILE variable at the worker config therefore isolates
     * nothing; it only adds. The config ROOT is what governs:
     *
     *   XDG_CONFIG_HOME=<dir containing only the worker server>
     *     → exactly 1 server. The decoy is gone.
     *
     * ★This is the cheapest spec of the four, because opencode splits config
     * from state: credentials live in `XDG_DATA_HOME`
     * (`~/.local/share/opencode/auth.json`), NOT in the config root. Redirecting
     * `XDG_CONFIG_HOME` therefore isolates the MCP table while leaving auth,
     * sessions and the session DB completely untouched — no imports at all, and
     * nothing to keep in sync.
     *
     * ★`XDG_CONFIG_HOME` is a SHARED variable, unlike the three provider-private
     * ones above. Redirecting it moves the config root of any other XDG-aware
     * tool the worker spawns. Accepted here because opencode offers no private
     * equivalent that REPLACES (measured above), and because the blast radius is
     * still far narrower than `HOME`: XDG_CONFIG_HOME addresses config only,
     * while `HOME` additionally carries auth, caches, sessions and shell state.
     */
    {
        providerType: 'opencode',
        homeEnvVar: 'XDG_CONFIG_HOME',
        imports: [],
        // The ISOLATED surface. Empty means the owner's global
        // `opencode.json` is absent and cannot be merged in.
        ensureDirs: ['opencode'],
    },
    /**
     * ★hermes-cli (measured live 2026-09-19, hermes-agent 0.14.0).
     *
     * ─── This spec fixes DELIVERY, not only isolation ───────────────────────
     *
     * hermes was the one provider receiving NO worker MCP server at all. Its
     * `mcpConfig.path` is `~/.hermes/config.yaml` — the owner's real config —
     * and `resolveWorkerMcpIsolation()` refuses to write a home-rooted path when
     * there is no private home, because writing would clobber the coordinator's
     * own config. That refusal is correct and stays; the owner's config is not
     * something to overwrite.
     *
     * What changes is that the path no longer resolves INTO the owner's home.
     * With a private root the `~` in `~/.hermes/config.yaml` resolves against
     * it, so the write lands in the worker's own file and the refusal branch is
     * never reached. Isolation and delivery are the same fix here: the worker
     * gets its server precisely because it stopped sharing the owner's file.
     *
     * ─── ★The measurement ───────────────────────────────────────────────────
     *
     * `HERMES_HOME` is a first-class config-root override, read in
     * `hermes_constants.py` (`get_hermes_home()` → `os.environ["HERMES_HOME"]`,
     * falling back to `~/.hermes`). Both the config and the credential file are
     * resolved from it — `get_env_path()` returns `<HERMES_HOME>/.env`. Verified
     * against the installed CLI:
     *
     *   HERMES_HOME=<private>  hermes config path      → <private>/config.yaml
     *   HERMES_HOME=<private>  hermes config env-path  → <private>/.env
     *
     * So `.env` is symlinked through (credentials, refreshed in place) and
     * `config.yaml` is simply ABSENT from the private root — which is the
     * isolated surface. The owner's config declares `adhdev` and `adhdev-mesh`
     * under `mcp_servers`; neither reaches the worker.
     *
     * ★`--ignore-user-config` was considered and rejected as the mechanism. It
     * does isolate (it ignores `~/.hermes/config.yaml` while still loading
     * `.env`), but it discards ALL 72 top-level config keys including the model
     * and provider selection, and it offers nowhere to WRITE the worker server —
     * leaving delivery broken, which is half the defect. `HERMES_HOME` fixes
     * both with one variable.
     *
     * ★Deliberately NOT imported: `config.yaml` (the leak itself — importing it
     * in any mode re-admits the owner's `mcp_servers`) and the profile store.
     * The cost is the same accepted trade as codex: the worker falls back to
     * hermes's built-in defaults for non-MCP preferences rather than inheriting
     * a filtered copy whose filter would need maintaining.
     *
     * ★Priority note: `hermes/` has been dormant since 2026-07-19 (CLAUDE.md),
     * so this is the lowest-value of the four. It is included because the fix
     * turned out to be one env var plus one symlink — the same shape as codex —
     * rather than the structural redesign the deferral (§12-3) assumed.
     */
    {
        providerType: 'hermes-cli',
        homeEnvVar: 'HERMES_HOME',
        // `HERMES_HOME` names the `.hermes` directory itself, so the declared
        // `~/.hermes/config.yaml` collapses to `<root>/config.yaml` — which is
        // exactly what `hermes config path` reports under the override.
        configRootPrefix: '.hermes',
        imports: [
            // Credentials. Symlinked so a rotation stays shared. Not `required`:
            // a host driving hermes purely through provider env vars may have no
            // `.env`, and that must still launch.
            { relativePath: '.env', mode: 'symlink', requireOwnerOnly: true },
            // Transcript/session surfaces — linked THROUGH to the real home so
            // the daemon keeps reading what the worker writes.
            { relativePath: 'sessions', mode: 'symlink' },
        ],
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
    // ★The real-home base for SOURCES is not always `realHome` itself. When the
    // private root stands in for `~/<prefix>` (codex, kimi, hermes), imports are
    // declared root-relative, so the source lives one segment deeper. Joining
    // both ends from the same string — as this loop did until 2026-09-19 —
    // makes every such source miss, and because these entries are deliberately
    // optional the miss is a SILENT skip that yields an empty root and a CLI
    // launched with no credentials. See `WorkerHomeImport.relativePath`.
    const importPrefix = String(spec.configRootPrefix || '').trim();
    const sourceBase = importPrefix ? path.join(realHome, importPrefix) : realHome;
    for (const entry of spec.imports) {
        const source = path.join(sourceBase, entry.relativePath);
        const target = path.join(home, entry.relativePath);
        if (!existsSync(source)) {
            if (entry.required) {
                throw new Error(
                    `worker_private_home_missing_required_import: ${entry.relativePath} not found under ${sourceBase}`,
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

    // ─── Workspace-derived links ────────────────────────────────────────
    //
    // Resolved HERE rather than declared statically because the directory name
    // is a function of the workspace, which only this call knows. See
    // `WorkerWorkspaceLink` for why a static `relativePath` cannot express it.
    //
    // ★The real-side directory is CREATED when absent. A first-ever launch in a
    // workspace has no project directory yet, and the generic missing-import
    // skip contract would be wrong here: skipping leaves the worker writing
    // transcripts into its private HOME, where the daemon never looks — a
    // silent zero-message session rather than a visible failure. Creating the
    // real leaf is also what the CLI would have done on its own.
    for (const link of spec.workspaceLinks || []) {
        const slug = deriveCursorWorkspaceSlug(opts.workspace || '');
        if (!slug) continue;
        const rel = path.join(link.projectsDir, slug, link.relativePath);
        const source = path.join(realHome, rel);
        const target = path.join(home, rel);
        try {
            mkdirSync(source, { recursive: true });
            mkdirSync(path.dirname(target), { recursive: true });
            try { rmSync(target, { force: true, recursive: true }); } catch { /* best effort */ }
            symlinkSync(source, target);
            imported.push(rel);
        } catch (err: any) {
            // Never fatal. A worker that writes transcripts somewhere the daemon
            // cannot read is degraded, but a worker that fails to LAUNCH over a
            // transcript link is an outage — and on win32 without developer mode
            // a directory symlink is simply unavailable.
            LOG.warn('WorkerMcp', `workspace link ${rel} unavailable: ${err?.message || err}`);
            skipped.push(rel);
        }
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
 *   ADHDEV_WORKER_MCP was OFF by default ⇒ resolveWorkerMcpIsolation() returns
 *   null ⇒ the delegated launch had no `workerHome` ⇒ no trust plan was built
 *   ⇒ fsm-driver's fail-closed branch skipped the pre-trust write ⇒ every
 *   antigravity worker sat forever on "Do you trust the files in this folder?".
 *
 * The MCP axis is a HARDENING feature: with it off the worker keeps the
 * (weaker) isolation it always had, which is a degradation, not a stall. The
 * trust axis is not like that — with it off the worker does not run at all. So
 * it must not inherit the MCP flag's state in either direction.
 *
 * ★The MCP flag now defaults ON (2026-09-18), so the exact hang above is no
 * longer reachable by default — but the decoupling stays, because
 * ADHDEV_WORKER_MCP=off is still a supported opt-out and re-coupling these two
 * axes would make that opt-out silently stall every antigravity worker again.
 * The flip narrows this bug's blast radius; it does not remove the reason for
 * the split.
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
    /**
     * HOME-relative prefix that `workerHome` stands in for, when it is a named
     * config root rather than a home. See `WorkerPrivateHomeSpec.configRootPrefix`.
     */
    configRootPrefix?: string;
    /**
     * Absolute path to write instead of the declared one. Set only for a
     * forced-config-file launch whose declared path is workspace-relative — see
     * `resolvePrivateWorkerMcpConfigPath`.
     */
    privateConfigPath?: string;
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
 *
 * ★`configRootPrefix` handles the case where the private root is a NAMED config
 * root rather than a home: the declared path's leading `~/<prefix>` collapses to
 * the root itself, because the env var already points AT that directory. See
 * `WorkerPrivateHomeSpec.configRootPrefix` for the measurement behind it.
 */
export function resolveWorkerMcpConfigPath(
    declaredPath: string,
    workspace: string,
    workerHome?: string,
    configRootPrefix?: string,
): string {
    const trimmed = String(declaredPath || '').trim();
    const home = workerHome || os.homedir();
    if (trimmed === '~') return home;
    if (trimmed.startsWith('~/')) {
        let rest = trimmed.slice(2);
        // Collapse the segment the env var already names. Only when a private
        // root is actually in play — with no worker home this must stay the
        // plain real-home resolution the coordinator would do.
        const prefix = String(configRootPrefix || '').trim();
        if (workerHome && prefix) {
            if (rest === prefix) return home;
            if (rest.startsWith(`${prefix}/`)) rest = rest.slice(prefix.length + 1);
        }
        return path.join(home, rest);
    }
    if (path.isAbsolute(trimmed)) return trimmed;
    return path.join(workspace, trimmed);
}

/**
 * SHARED-WORKSPACE CLOBBER (2026-09-22). A workspace-relative declared path
 * (`.mcp.json`) resolves to `<workspace>/.mcp.json`, and a worker on the BASE
 * node runs in the coordinator's own workspace. `writeWorkerMcpConfig` REPLACES
 * rather than merges, on the stated premise that the target is "a worker-private
 * HOME or a temp path the worker alone reads" — which a shared workspace file is
 * not. Measured on the preview coordinator machine: the repo-root `.mcp.json`
 * held the WORKER entry (`adhdev mcp --mode ipc --worker`) at 22:57 and the
 * coordinator entry at 23:06. Each writer erased the other, and the replace also
 * discards any servers the owner keeps in that file.
 *
 * When the launch forces an explicit config file, the CLI reads ONLY that file
 * (strict mode), so nothing requires the worker config to live at the auto-import
 * path at all. It goes to a per-session private file instead and the workspace
 * file is never touched. Returns null when the declared path is home-rooted or
 * absolute (those are already private or deliberately pinned) or when the launch
 * does not force a file — an auto-importing CLI must still find its config where
 * it looks.
 */
export function resolvePrivateWorkerMcpConfigPath(input: {
    declaredPath: string;
    sessionKey: string;
    forcedConfigFile?: boolean;
    baseDir?: string;
}): string | null {
    if (!input.forcedConfigFile) return null;
    const declared = String(input.declaredPath || '').trim();
    if (!declared || declared.startsWith('~') || path.isAbsolute(declared)) return null;
    const root = path.join(input.baseDir || os.tmpdir(), 'adhdev-worker-mcp-config');
    const sessionDir = crypto.createHash('sha256').update(String(input.sessionKey || '')).digest('hex').slice(0, 16);
    return path.join(root, sessionDir, path.basename(declared));
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
    const target = input.privateConfigPath || resolveWorkerMcpConfigPath(
        input.declaredPath,
        input.workspace,
        input.workerHome,
        input.configRootPrefix,
    );

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
    /**
     * True when this launch FORCES the CLI to read one explicit config file
     * (claude's `empty_mcp_config` rule: `--mcp-config <file>` +
     * `--strict-mcp-config`), so the worker config does not have to sit at the
     * provider's auto-import path. See `resolvePrivateWorkerMcpConfigPath`.
     */
    forcedConfigFile?: boolean;
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
    /**
     * When set, `workerHome` is a provider-private CONFIG ROOT that must be
     * exported through THIS variable — and `HOME` must be left alone.
     *
     * Mirrors `WorkerPrivateHomeSpec.homeEnvVar`; see that field for why a
     * dedicated variable is preferred over redirecting `HOME` wherever the CLI
     * offers one. A caller that exports `HOME` regardless would repoint the
     * whole process tree's home for no benefit, and would strand every surface
     * this spec deliberately left outside its imports (opencode's auth being
     * the clearest case).
     */
    workerHomeEnvVar?: string;
    /** Config file actually written, if any. */
    configPath?: string;
    /**
     * True when `configPath` carries an actual worker MCP server entry (Phase B)
     * rather than Phase A's zero-server config.
     *
     * Callers that FORCE a provider to read one specific config file — claude's
     * `empty_mcp_config` rule pairs `--mcp-config <file>` with
     * `--strict-mcp-config` — must point at this file instead of an empty one
     * when this is true. Otherwise the isolation arg shadows the very worker
     * toolset that was just written, and the worker boots with zero tools.
     */
    configHasServer?: boolean;
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
            if (spec.homeEnvVar) result.workerHomeEnvVar = spec.homeEnvVar;
            notes.push(
                `private ${spec.homeEnvVar || 'HOME'} ${prepared.home}`
                + ` (imported: ${prepared.imported.join(', ') || 'none'})`,
            );
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

    const privateConfigPath = resolvePrivateWorkerMcpConfigPath({
        declaredPath,
        sessionKey: input.sessionKey,
        forcedConfigFile: input.forcedConfigFile,
        baseDir: input.baseDir,
    });
    if (privateConfigPath) {
        notes.push(`launch forces an explicit config file — worker config kept out of the shared workspace (${declaredPath} untouched)`);
    }

    try {
        result.configPath = writeWorkerMcpConfig({
            declaredPath,
            format,
            serverName,
            ...(privateConfigPath ? { privateConfigPath } : {}),
            workspace: input.workspace,
            workerHome: result.workerHome,
            ...(spec?.configRootPrefix ? { configRootPrefix: spec.configRootPrefix } : {}),
            server: input.server,
            token: input.token,
            ...(pendingBind ? { bind: pendingBind.bind } : {}),
        });
        if (input.server) result.configHasServer = true;
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
