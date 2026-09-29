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
 *
 * ─── Layout ─────────────────────────────────────────────────────────────
 *
 * This module holds token minting / session binding, the top-level
 * resolveWorkerMcpIsolation and the delivery status. The pieces it composes live
 * beside it and are re-exported here: worker-home-specs.ts (per-provider private
 * HOME specs), worker-private-home.ts (materializing that home) and
 * worker-mcp-config.ts (writing / removing the worker MCP config entry).
 */

import * as crypto from 'crypto';

import { LOG } from '../logging/logger.js';
import { isSupportedMeshCoordinatorConfigFormat } from './mesh-coordinator-config.js';
import {
    isWorkerMcpEnabled,
    mintWorkerSessionBind,
    verifyWorkerSessionBind,
    revokeWorkerSessionBindsForSession,
    subscribeWorkerBindRevocation,
    revokeWorkerSessionBind,
    hasLiveWorkerSessionBind,
    __resetWorkerSessionBindsForTest,
    liveWorkerSessionBindCount,
    WORKER_BIND_CANARY_PREFIX,
    type WorkerSessionBinding,
} from '../runtime-defaults.js';
import { resolvePrivateWorkerMcpConfigPath, writeWorkerMcpConfig, WORKER_SESSION_BIND_ENV, type WorkerMcpServerCommand } from './worker-mcp-config.js';
import { prepareWorkerPrivateHome } from './worker-private-home.js';
import { findWorkerPrivateHomeSpec } from './worker-home-specs.js';
export { deriveCursorWorkspaceSlug, WORKER_PRIVATE_HOME_SPECS, findWorkerPrivateHomeSpec } from './worker-home-specs.js';
export type { WorkerHomeImport, WorkerWorkspaceLink, WorkerPrivateHomeSpec } from './worker-home-specs.js';
export { prepareWorkerPrivateHome, resolveWorkerTrustHome } from './worker-private-home.js';
export type { PreparedWorkerHome, WorkerHomeLinkKind, WorkerTrustHome } from './worker-private-home.js';
export { resolveWorkerMcpConfigPath, resolvePrivateWorkerMcpConfigPath, writeWorkerMcpConfig, removeWorkerMcpConfigEntry, WORKER_HOME_PLACEHOLDER, WORKER_SESSION_BIND_ENV, expandWorkerIsolationPlaceholders } from './worker-mcp-config.js';
export type { WorkerMcpServerCommand, WriteWorkerMcpConfigInput } from './worker-mcp-config.js';

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
// ─── Registry moved to runtime-defaults.ts (2026-09-24) ──────────────────
//
// Same reason as `isWorkerMcpEnabled` above: `providers/**` (specifically
// `cli-provider-events.ts`'s idle-edge detach gate) needs to read
// `hasLiveWorkerSessionBind()`, and the import-boundary gate forbids a
// providers/** -> mesh/** value import. Moving the registry to the
// layer-neutral `runtime-defaults.ts` lets both sides read it with no
// cross-layer import in either direction. Imported (not merely re-exported)
// above so this file's OWN code (`exchangeWorkerSessionBind` below) keeps a
// real local binding to call, and re-exported here for this file's and this
// package's existing consumers (mesh/turn-ledger/runtime-ledger.ts,
// boot/stages/mesh-runtime.ts, and this module's own test suite).
export {
    mintWorkerSessionBind,
    verifyWorkerSessionBind,
    revokeWorkerSessionBindsForSession,
    subscribeWorkerBindRevocation,
    revokeWorkerSessionBind,
    hasLiveWorkerSessionBind,
    __resetWorkerSessionBindsForTest,
    liveWorkerSessionBindCount,
    WORKER_BIND_CANARY_PREFIX,
    type WorkerSessionBinding,
};

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
    /**
     * Set when this provider REQUIRES a worker-private HOME/config root and it
     * could not be established. The value is the failure reason (log-safe, no
     * secrets).
     *
     * ★Fail-CLOSED contract: a launch seam that sees this MUST NOT start the
     * worker. Without the private root the CLI resolves its config against the
     * real home and inherits the coordinator's MCP servers — the leak this
     * module exists to close. `buildCoordinatorDelegatedCliLaunchOptions`
     * enforces it by throwing `worker_private_home_failed`. The field (rather
     * than a throw from here) keeps this function's "never throws" contract,
     * so `deriveWorkerMcpDeliveryStatus` can still classify the outcome.
     */
    privateHomeError?: string;
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
            if (prepared.failed.length) notes.push(`failed imports (private HOME kept): ${prepared.failed.join(', ')}`);
        } catch (err: any) {
            // A private HOME we could not build must NOT silently downgrade to
            // "worker shares the coordinator's home" — that is the exact
            // inheritance being removed. Skip the config write too, and say so.
            //
            // ★Until 2026-09-27 this branch returned a result with no
            // `workerHome` and the launch went ahead anyway — against the REAL
            // home, i.e. with the coordinator's MCP servers in view (fail OPEN;
            // reached on every unprivileged win32 host through a directory
            // import, see `materializeWorkerHomeLink`). Per-import failures no
            // longer land here at all (they are skipped with a WARN inside
            // `prepareWorkerPrivateHome`); what remains is a failure of the
            // isolation CORE — the root could not be created, a `required`
            // import is missing/unlinkable, or a credential source is not
            // owner-only. Those now set `privateHomeError`, which the launch
            // seam turns into a refused launch. Operators who deliberately want
            // un-isolated workers opt out with ADHDEV_WORKER_MCP=off.
            const reason = String(err?.message || err);
            result.privateHomeError = reason;
            notes.push(`private HOME unavailable (${reason}) — worker launch refused (fail closed)`);
            LOG.warn('WorkerMcp', `private HOME preparation failed for ${input.providerType}: ${reason} — refusing to launch the worker un-isolated`);
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

/**
 * Short, non-content reason codes for why a worker's MCP server was or was not
 * delivered at launch. This is the vocabulary `deriveWorkerMcpDeliveryStatus`
 * classifies `resolveWorkerMcpIsolation`'s outcome into — an enum, never free
 * text, because `delivered`/`reason` is meant to ride on mesh_status /
 * mesh_list_nodes session entries and dispatch/claim responses (allow-list
 * surfaces per CLAUDE.md's server content boundary). The full human-readable
 * explanation stays in `WorkerMcpIsolation.notes`, which only ever reaches the
 * daemon's own log.
 */
export const WORKER_MCP_DELIVERY_REASONS = [
    /** Gate off, or this launch was never given mesh bind context — no delivery was ever attempted. */
    'not_applicable',
    /** Everything resolved: a server entry plus a live session bind. */
    'delivered',
    /** Provider needs a private HOME/config-root and building it threw. */
    'private_home_failed',
    /** config_override delivery mode declared, but no server or bind context supplied. */
    'config_override_missing_context',
    /** config_override delivery mode declared, but minting the bind or building the descriptor threw. */
    'config_override_failed',
    /** Provider declares no `meshCoordinator.mcpConfig.path` at all. */
    'no_mcp_config_declared',
    /** Provider's declared config format has no auto-import writer. */
    'unsupported_config_format',
    /** Declared path is home-rooted and this provider has no private HOME — refused to touch the coordinator's own config. */
    'home_rooted_no_private_home',
    /** Writing the config file itself threw. */
    'config_write_failed',
    /** None of the above matched but the isolation object still carries no bind — an unclassified gap, kept distinct from a silent `delivered: true`. */
    'unknown',
] as const;

export type WorkerMcpDeliveryReason = typeof WORKER_MCP_DELIVERY_REASONS[number];

/** The allow-list shape this status is carried in on session entries and dispatch/claim responses. */
export interface WorkerMcpDeliveryStatus {
    delivered: boolean;
    /** Present only when `delivered` is false and a bind was actually expected (i.e. not `not_applicable`). */
    reason?: WorkerMcpDeliveryReason;
}

/**
 * Classify what `resolveWorkerMcpIsolation` actually produced into the
 * coordinator-visible `{ delivered, reason? }` shape.
 *
 * `isolation` is the gate's return value for THIS launch (`null` when the
 * ADHDEV_WORKER_MCP gate is off) and `hadBindContext` is whether the caller
 * even asked for a worker identity (`input.bindContext` was present) — a
 * launch with no bind context was never going to deliver anything, and that
 * is not a failure, so it reads as `not_applicable` rather than `delivered:
 * false`.
 */
export function deriveWorkerMcpDeliveryStatus(
    isolation: WorkerMcpIsolation | null,
    hadBindContext: boolean,
): WorkerMcpDeliveryStatus {
    if (!hadBindContext) return { delivered: false, reason: 'not_applicable' };
    if (!isolation) return { delivered: false, reason: 'not_applicable' };

    const delivered = Boolean(isolation.bind) && (isolation.configHasServer === true || !!isolation.delivery);
    if (delivered) return { delivered: true };

    const notes = isolation.notes.join(' | ');
    const reason: WorkerMcpDeliveryReason = notes.includes('private HOME unavailable')
        ? 'private_home_failed'
        : notes.includes('config_override delivery unavailable')
            ? 'config_override_missing_context'
            : notes.includes('config_override delivery failed')
                ? 'config_override_failed'
                : notes.includes('no mcpConfig.path declared')
                    ? 'no_mcp_config_declared'
                    : notes.includes('is not auto-import writable')
                        ? 'unsupported_config_format'
                        : notes.includes('refusing to overwrite the coordinator config')
                            ? 'home_rooted_no_private_home'
                            : notes.includes('config write failed')
                                ? 'config_write_failed'
                                : 'unknown';
    return { delivered: false, reason };
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
