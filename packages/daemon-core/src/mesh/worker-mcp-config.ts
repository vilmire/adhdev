// Worker MCP config: where each provider reads its MCP server list, writing /
// removing the worker's adhdev entry (workspace or worker-private target), and the
// isolation placeholder expansion. Split out of worker-mcp-isolation.ts
// (re-exported there).

import type { MeshCoordinatorConfigFormat } from './mesh-refine-gates.js';
import type { WorkerPrivateMcpConfigSpec } from './worker-home-specs.js';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    isSupportedMeshCoordinatorConfigFormat,
    buildMeshCoordinatorMcpServerEntry,
    getMcpServersKey,
    parseMeshCoordinatorMcpConfig,
    serializeMeshCoordinatorMcpConfig,
} from './mesh-coordinator-config.js';
import {
    existsSync,
    readFileSync,
    mkdirSync,
    writeFileSync,
} from 'fs';
import { ensureLocalGitExclude } from '../git/git-local-exclude.js';
import { LOG } from '../logging/logger.js';
import { verifyWorkerSessionBind } from '../worker-session-bind-registry.js';
import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';

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
    /**
     * Session the written entry belongs to. When the target turns out to be a
     * SHARED file, the entry is recorded so `releaseWorkerMcpSharedEntries`
     * (wired to session teardown) can take it back out. Ignored for a private
     * target, which is never shared.
     */
    teardownSessionId?: string;
}

/**
 * Resolve a provider-declared config path for a WORKER launch.
 *
 * Mirrors the coordinator's `resolveMcpConfigPath` with one deliberate
 * difference: `~` resolves against the worker-private HOME when there is one.
 * That single substitution is what makes a home-rooted provider isolable at
 * all — the coordinator resolver has no such seam, which is why antigravity
 * workers currently share the coordinator's global file.
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
 * SHARED-WORKSPACE CLOBBER (2026-09-22, fixed 2026-09-25). A workspace-relative
 * declared path (`.mcp.json`) resolves to `<workspace>/.mcp.json`, and a worker
 * on the BASE node runs in the coordinator's own workspace — so without this
 * function's private-path detour, a forced-config-file launch would write into
 * the SAME file the coordinator reads. Measured on the preview coordinator
 * machine: the repo-root `.mcp.json` held the WORKER entry (`adhdev mcp --mode
 * ipc --worker`) at 22:57 and the coordinator entry at 23:06 — each writer had
 * replaced the other's entry outright.
 *
 * Two independent mitigations now exist for the two provider shapes:
 *  - A launch that FORCES an explicit config file (claude's `--mcp-config …
 *    --strict-mcp-config`) uses THIS function to go to a per-session private
 *    file instead — the CLI reads ONLY that file, so nothing requires the
 *    worker config to live at the auto-import path at all, and the shared
 *    workspace file is never touched. Returns null when the declared path is
 *    home-rooted or absolute (already private or deliberately pinned) or when
 *    the launch does not force a file — an auto-importing CLI must still find
 *    its config where it looks.
 *  - For an AUTO-IMPORTING provider with no forced-config-file flag (cursor-cli,
 *    grok-cli, kimi, opencode) this function returns null and
 *    `resolveWorkerMcpPlacement` sends the entry to the provider's private
 *    USER-level layer instead (2026-10-07), falling back to an inline env var or
 *    a teardown-undone MERGE only when a workspace layer would shadow it. A
 *    provider with no private layer (claude-cli on a non-forced launch) merges.
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

/** Where one worker launch's MCP entry goes. See `resolveWorkerMcpPlacement`. */
export type WorkerMcpPlacement =
    | { kind: 'private_file'; path: string; note: string }
    | { kind: 'shared_merge'; note: string }
    | { kind: 'inline_env'; envVar: string; note: string }
    | { kind: 'skip'; note: string };

/**
 * Decide where a worker's MCP entry is delivered, in preference order:
 *
 *  1. A file only this launch reads — the forced `--mcp-config` file (claude),
 *     the worker-private root for a `~/` declared path (antigravity), or the
 *     private root's USER-level layer for a workspace-relative declared path
 *     (`WorkerPrivateMcpConfigSpec`: kimi, cursor-cli, opencode, grok-cli),
 *     as long as no workspace layer that outranks it declares the same name.
 *  2. On such a collision: an inline config env var outranking every file
 *     layer, when the CLI has one (opencode).
 *  3. Otherwise a MERGE into the declared workspace file that keeps every other
 *     entry and is undone at session teardown (`releaseWorkerMcpSharedEntries`).
 *     This is also the path for a provider with no private alternative at all.
 *
 * ★A collision is the base-node case: a coordinator of a compatible provider
 * registered `adhdev-mesh` in this very workspace. Writing only the private
 * layer there would let the coordinator's entry win, handing the worker the
 * coordinator's tool surface — so the shadow has to sit at a layer that
 * outranks it.
 */
export function resolveWorkerMcpPlacement(input: {
    declaredPath: string;
    format: MeshCoordinatorConfigFormat;
    serverName: string;
    workspace: string;
    workerHome?: string;
    configRootPrefix?: string;
    privateMcpConfig?: WorkerPrivateMcpConfigSpec;
    /** `resolvePrivateWorkerMcpConfigPath`'s answer for this launch. */
    forcedPrivatePath?: string | null;
    hasServer: boolean;
}): WorkerMcpPlacement {
    const declared = String(input.declaredPath || '').trim();
    if (input.forcedPrivatePath) {
        return {
            kind: 'private_file',
            path: input.forcedPrivatePath,
            note: `launch forces an explicit config file — worker config kept out of the shared workspace (${declared} untouched)`,
        };
    }
    if (declared.startsWith('~') && input.workerHome) {
        return {
            kind: 'private_file',
            path: resolveWorkerMcpConfigPath(declared, input.workspace, input.workerHome, input.configRootPrefix),
            note: `${declared} resolved inside the worker-private root`,
        };
    }
    if (path.isAbsolute(declared)) {
        return { kind: 'shared_merge', note: `${declared} is a pinned absolute path — merging the worker entry into it` };
    }
    const alt = input.privateMcpConfig;
    if (!alt || !input.workerHome) {
        return {
            kind: 'shared_merge',
            note: `${declared} is workspace-relative and this provider has no private MCP layer — merging into the shared file (undone at session teardown)`,
        };
    }
    const shadowing = alt.overriddenBy.filter((rel) => workerMcpConfigDeclaresServer(
        path.join(input.workspace, rel), input.format, input.serverName,
    ));
    if (shadowing.length === 0) {
        return {
            kind: 'private_file',
            path: path.join(input.workerHome, alt.relativePath),
            note: `worker config written to the private user layer (${alt.relativePath}) — ${declared} in the workspace untouched`,
        };
    }
    const why = `workspace ${shadowing.join(', ')} already declares "${input.serverName}" and would shadow the private layer`;
    if (!input.hasServer) {
        // Phase A (no worker server): there is no entry to shadow the
        // coordinator's with, and an empty write would only erase it.
        return { kind: 'skip', note: `${why} — no worker server to deliver, workspace left untouched` };
    }
    if (alt.inlineEnvVar) {
        return { kind: 'inline_env', envVar: alt.inlineEnvVar, note: `${why} — delivering inline via ${alt.inlineEnvVar}` };
    }
    return { kind: 'shared_merge', note: `${why} — merging into ${declared} (entry restored at session teardown)` };
}

/**
 * True when `target` is a path ONLY this worker launch can possibly read —
 * i.e. NOT the shared, auto-imported config file a CLI discovers on its own.
 *
 * Decided by WHERE the resolved target lands, never by which inputs were set:
 *
 * - `target` is `privateConfigPath` ⇒ a per-session file under
 *   `resolvePrivateWorkerMcpConfigPath`'s root or inside the worker root —
 *   nothing else reads it.
 * - `target` lies INSIDE `workerHome` ⇒ a worker-scoped HOME/config root this
 *   daemon materialized for this launch alone.
 *
 * ★Until 2026-10-07 this returned true whenever `workerHome` was SET. But
 * `resolveWorkerMcpConfigPath` only redirects `~/` paths into the private
 * root — a workspace-relative declared path (`.kimi-code/mcp.json`,
 * `.cursor/mcp.json`, `opencode.json`, `.mcp.json`) still resolved to
 * `<workspace>/…`, and the "private" branch REPLACED that shared file
 * wholesale for kimi, cursor-cli, opencode and grok-cli workers: the
 * coordinator's entry and the owner's servers were erased, and concurrent
 * base-node workers raced on the file.
 */
function isPrivateWorkerTarget(
    target: string,
    input: Pick<WriteWorkerMcpConfigInput, 'privateConfigPath' | 'workerHome'>,
): boolean {
    if (input.privateConfigPath && path.resolve(target) === path.resolve(input.privateConfigPath)) return true;
    return Boolean(input.workerHome) && isPathInside(target, input.workerHome!);
}

function isPathInside(target: string, root: string): boolean {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * True when the config file at `filePath` declares `serverName`. Used to decide
 * whether a workspace layer would SHADOW a worker entry written to the private
 * user layer (see `WorkerPrivateMcpConfigSpec.overriddenBy`). An unreadable or
 * unparsable file answers true — the conservative reading, because the private
 * entry's visibility then cannot be proven.
 */
export function workerMcpConfigDeclaresServer(
    filePath: string,
    format: MeshCoordinatorConfigFormat,
    serverName: string,
): boolean {
    if (!existsSync(filePath)) return false;
    try {
        const parsed = parseMeshCoordinatorMcpConfig(readFileSync(filePath, 'utf-8'), format);
        const servers = readServersRecord(parsed, format);
        return !!servers && Object.prototype.hasOwnProperty.call(servers, serverName);
    } catch {
        return true;
    }
}

function readServersRecord(config: Record<string, any>, format: MeshCoordinatorConfigFormat): Record<string, any> | null {
    const raw = config?.[getMcpServersKey(format)];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function buildWorkerEntry(input: Pick<WriteWorkerMcpConfigInput, 'format' | 'server' | 'token' | 'bind'>): Record<string, any> | null {
    if (!input.server) return null;
    const entryEnv: Record<string, string> = {};
    if (input.token) entryEnv.ADHDEV_WORKER_TASK_TOKEN = input.token;
    if (input.bind) entryEnv.ADHDEV_WORKER_SESSION_BIND = input.bind;
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
    return buildMeshCoordinatorMcpServerEntry(input.format, {
        command: input.server.command,
        args: input.server.args,
        ...(Object.keys(entryEnv).length ? { env: entryEnv } : {}),
    });
}

/**
 * The worker config as an INLINE string, for a CLI that accepts a whole config
 * through an environment variable outranking every file layer (opencode's
 * `OPENCODE_CONFIG_CONTENT`). Nothing is written to disk. Note the bind then
 * rides the CLI's process env — the same footing as the `config_override`
 * delivery (codex), accepted only on a collision where the alternative is a
 * write into a shared workspace file.
 */
export function buildInlineWorkerMcpConfig(
    input: Pick<WriteWorkerMcpConfigInput, 'format' | 'serverName' | 'server' | 'token' | 'bind'>,
): string {
    if (!isSupportedMeshCoordinatorConfigFormat(input.format)) {
        throw new Error(`worker_mcp_unsupported_format: ${String(input.format)}`);
    }
    const entry = buildWorkerEntry(input);
    const servers: Record<string, any> = entry ? { [input.serverName]: entry } : {};
    return JSON.stringify({ [getMcpServersKey(input.format)]: servers });
}

/**
 * Write the worker's MCP config to the provider-declared path.
 *
 * ★MERGE vs REPLACE depends on who else can read the target (SHARED-WORKSPACE
 * CLOBBER, measured 2026-09-22 on the preview coordinator machine: the
 * repo-root `.mcp.json` held the WORKER entry at 22:57 and the coordinator's
 * own entry at 23:06 — each writer erased the other, and a plain replace also
 * discarded any servers the owner kept in that file).
 *
 * - PRIVATE target (`isPrivateWorkerTarget` — a per-session temp file or a
 *   worker-scoped HOME/config-root nobody else reads): REPLACE, as before.
 *   The whole point of that path is that nothing the worker did not receive
 *   on purpose is reachable, so merging would re-admit whatever isolation
 *   this function exists to remove.
 * - SHARED target (the provider's plain auto-import path, resolved against
 *   the REAL workspace — a worker on the BASE node runs in the coordinator's
 *   own workspace and reads the SAME file the coordinator or the owner does):
 *   MERGE. Parse whatever is already on disk, keep every top-level key and
 *   every sibling server entry untouched, and add/replace ONLY
 *   `servers[serverName]` — mirrors the coordinator's own writer
 *   (`commands/high-family/mesh-coordinator-launch.ts`, which merges for the
 *   identical reason: it shares this file with the user). A parse failure on
 *   an existing shared file is NOT swallowed into a silent overwrite — the
 *   owner's file could hold servers this function has never seen; failing
 *   loudly here is safer than guessing it away.
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

    const workerEntry = buildWorkerEntry(input);
    const serversKey = getMcpServersKey(input.format);
    let config: Record<string, any>;
    const isPrivate = isPrivateWorkerTarget(target, input);
    let previousEntry: unknown;

    if (isPrivate) {
        // PRIVATE target: the server table is REPLACED — nothing the worker did
        // not receive on purpose may stay reachable. Other top-level keys are
        // kept: a private root may hold a sanitized copy of the owner's config
        // (opencode's `opencode.json` with `mcp` stripped carries the model and
        // provider definitions the worker must inherit). A file that does not
        // parse is replaced outright — nobody else reads it.
        let existing: Record<string, any> = {};
        if (existsSync(target)) {
            try {
                existing = parseMeshCoordinatorMcpConfig(readFileSync(target, 'utf-8'), input.format);
            } catch {
                existing = {};
            }
        }
        const servers: Record<string, any> = {};
        if (workerEntry) servers[input.serverName] = workerEntry;
        config = { ...existing, [serversKey]: servers };
    } else {
        // SHARED target — merge onto whatever is already there. A missing file
        // is the common case (first launch ever) and starts from `{}`, exactly
        // like the coordinator's own writer.
        let existing: Record<string, any> = {};
        if (existsSync(target)) {
            let raw: string;
            try {
                raw = readFileSync(target, 'utf-8');
            } catch (err: any) {
                throw new Error(`worker_mcp_shared_config_read_failed: ${target}: ${err?.message || err}`);
            }
            try {
                existing = parseMeshCoordinatorMcpConfig(raw, input.format);
            } catch (err: any) {
                // Never guess this away: the owner's file may hold servers we
                // cannot see the shape of. Refuse rather than silently replace.
                throw new Error(`worker_mcp_shared_config_parse_failed: ${target}: ${err?.message || err}`);
            }
        }
        const existingServers = readServersRecord(existing, input.format) || {};
        previousEntry = existingServers[input.serverName];
        config = {
            ...existing,
            [serversKey]: workerEntry
                ? { ...existingServers, [input.serverName]: workerEntry }
                : existingServers,
        };
        LOG.warn(
            'WorkerMcp',
            `merging worker MCP entry "${input.serverName}" into shared config ${target}`
            + ' (this file is not worker-private — see SHARED-WORKSPACE CLOBBER)',
        );
    }

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, serializeMeshCoordinatorMcpConfig(config, input.format), 'utf-8');
    // The entry carries the worker's session bind token: keep a workspace-local
    // file out of `git add -A` (see git-local-exclude.ts).
    ensureLocalGitExclude(input.workspace, target);
    if (!isPrivate && workerEntry && input.teardownSessionId) {
        recordSharedWorkerMcpEntry({
            sessionId: input.teardownSessionId,
            target,
            format: input.format,
            serverName: input.serverName,
            workspace: input.workspace,
            entry: workerEntry,
            previousEntry,
        });
    }
    return target;
}

/**
 * Cleanup counterpart to the SHARED-target branch of `writeWorkerMcpConfig`:
 * remove ONLY the worker's own server entry from a shared auto-import config,
 * leaving every other top-level key and every sibling server entry untouched.
 *
 * Called from session teardown through `releaseWorkerMcpSharedEntries`, so the
 * coordinator's (or owner's) config does not keep carrying a dead worker entry
 * with a revoked bind after the process exits. A no-op (returns false) when
 * the file is missing, unparsable, or does not currently carry `serverName` —
 * and, when `expectedEntry` is given, when the entry there is no longer the one
 * this worker wrote (another session has since replaced it).
 *
 * Deliberately a no-op for a PRIVATE target (`isPrivateWorkerTarget`): those
 * live under a per-session temp dir or a worker-scoped root that nobody else
 * reads, so per-entry surgery is unnecessary there.
 */
export function removeWorkerMcpConfigEntry(input: {
    declaredPath: string;
    format: MeshCoordinatorConfigFormat;
    serverName: string;
    workspace: string;
    workerHome?: string;
    configRootPrefix?: string;
    privateConfigPath?: string;
    /** Only remove when the entry on disk still equals this one. */
    expectedEntry?: unknown;
    /** Put this entry back instead of deleting the key (the one the worker shadowed). */
    restoreEntry?: unknown;
}): boolean {
    if (!isSupportedMeshCoordinatorConfigFormat(input.format)) return false;
    const target = input.privateConfigPath || resolveWorkerMcpConfigPath(
        input.declaredPath,
        input.workspace,
        input.workerHome,
        input.configRootPrefix,
    );
    if (isPrivateWorkerTarget(target, input)) return false;
    if (!existsSync(target)) return false;
    let existing: Record<string, any>;
    try {
        existing = parseMeshCoordinatorMcpConfig(readFileSync(target, 'utf-8'), input.format);
    } catch (err: any) {
        LOG.warn('WorkerMcp', `worker MCP cleanup: failed to parse ${target}: ${err?.message || err}`);
        return false;
    }
    const serversKey = getMcpServersKey(input.format);
    const servers = readServersRecord(existing, input.format);
    if (!servers || !(input.serverName in servers)) return false;
    if (input.expectedEntry !== undefined && !sameEntry(servers[input.serverName], input.expectedEntry)) return false;

    const nextServers = { ...servers };
    if (input.restoreEntry !== undefined) nextServers[input.serverName] = input.restoreEntry;
    else delete nextServers[input.serverName];
    const next = { ...existing, [serversKey]: nextServers };
    try {
        writeFileSync(target, serializeMeshCoordinatorMcpConfig(next, input.format), 'utf-8');
    } catch (err: any) {
        LOG.warn('WorkerMcp', `worker MCP cleanup: failed to write ${target}: ${err?.message || err}`);
        return false;
    }
    LOG.info(
        'WorkerMcp',
        `${input.restoreEntry !== undefined ? 'restored the shadowed' : 'removed worker MCP'} entry "${input.serverName}" in shared config ${target}`,
    );
    return true;
}

function sameEntry(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Shared-entry teardown ──────────────────────────────────────────────

interface SharedEntryHolder {
    sessionId: string;
    entry: Record<string, any>;
}

interface SharedEntryRecord {
    target: string;
    format: MeshCoordinatorConfigFormat;
    serverName: string;
    workspace: string;
    /** What sat under `serverName` before the FIRST live holder wrote (undefined = absent). */
    original: unknown;
    /** Live writers, oldest first; the last one is what should be on disk. */
    holders: SharedEntryHolder[];
}

const SHARED_ENTRIES = new Map<string, SharedEntryRecord>();

function sharedEntryKey(target: string, serverName: string): string {
    return `${path.resolve(target)}\u0000${serverName}`;
}

function recordSharedWorkerMcpEntry(input: {
    sessionId: string;
    target: string;
    format: MeshCoordinatorConfigFormat;
    serverName: string;
    workspace: string;
    entry: Record<string, any>;
    previousEntry: unknown;
}): void {
    const key = sharedEntryKey(input.target, input.serverName);
    let record = SHARED_ENTRIES.get(key);
    if (!record) {
        record = {
            target: input.target,
            format: input.format,
            serverName: input.serverName,
            workspace: input.workspace,
            // When the slot held a sibling worker's entry that THIS registry did
            // not record (written by a previous daemon incarnation), it is not
            // an original worth restoring — see `isDeadWorkerEntry`.
            original: input.previousEntry,
            holders: [],
        };
        SHARED_ENTRIES.set(key, record);
    }
    record.holders = record.holders.filter((holder) => holder.sessionId !== input.sessionId);
    record.holders.push({ sessionId: input.sessionId, entry: input.entry });
}

/** A worker entry whose bind is no longer live is not something to put back. */
function isDeadWorkerEntry(entry: unknown): boolean {
    const env = (entry as { env?: Record<string, unknown>; environment?: Record<string, unknown> } | null) || null;
    const bind = env?.env?.[WORKER_SESSION_BIND_ENV] ?? env?.environment?.[WORKER_SESSION_BIND_ENV];
    if (typeof bind !== 'string' || !bind) return false;
    return !verifyWorkerSessionBind(bind);
}

/**
 * Undo every SHARED worker MCP entry `sessionId` wrote (session teardown).
 *
 * Per (file, server name):
 *  - the entry on disk is no longer this session's → leave the file alone
 *    (someone else — a coordinator relaunch, the owner, a later worker — owns
 *    that slot now);
 *  - another live worker still holds the slot → put ITS entry back, so a
 *    surviving worker whose CLI reloads the file keeps its own server;
 *  - otherwise → restore what was there before the first worker wrote (the
 *    coordinator's entry), or delete the key when nothing was.
 *
 * In-memory only: entries written by a previous daemon incarnation are not
 * tracked across a restart (a restored worker keeps using its entry).
 */
export function releaseWorkerMcpSharedEntries(sessionId: string): number {
    const sid = String(sessionId || '').trim();
    if (!sid) return 0;
    let changed = 0;
    for (const [key, record] of [...SHARED_ENTRIES.entries()]) {
        const mine = record.holders.find((holder) => holder.sessionId === sid);
        if (!mine) continue;
        record.holders = record.holders.filter((holder) => holder.sessionId !== sid);
        const survivor = record.holders[record.holders.length - 1];
        const restoreEntry = survivor
            ? survivor.entry
            : (record.original !== undefined && !isDeadWorkerEntry(record.original) ? record.original : undefined);
        if (removeWorkerMcpConfigEntry({
            declaredPath: record.target,
            format: record.format,
            serverName: record.serverName,
            workspace: record.workspace,
            expectedEntry: mine.entry,
            ...(restoreEntry !== undefined ? { restoreEntry } : {}),
        })) changed += 1;
        if (!survivor) SHARED_ENTRIES.delete(key);
    }
    return changed;
}

/**
 * Wire `releaseWorkerMcpSharedEntries` to session teardown — except on
 * `daemon_shutdown`, where a hosted worker keeps running in the session host
 * and comes back on restore still reading its entry (same rule as
 * `subscribeWorkerBindRevocation`).
 */
export function subscribeWorkerMcpSharedConfigCleanup(bus: SessionLifecycleBus): Unsubscribe {
    return bus.on('terminated', (event) => {
        if (event.cause === 'daemon_shutdown') return;
        try {
            releaseWorkerMcpSharedEntries(event.sessionId);
        } catch (err: any) {
            LOG.warn('WorkerMcp', `shared worker MCP cleanup failed for ${event.sessionId}: ${err?.message || err}`);
        }
    }, { name: 'mesh.worker-mcp-shared-config' });
}

/** Test seam. */
export function __resetSharedWorkerMcpEntriesForTest(): void {
    SHARED_ENTRIES.clear();
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
