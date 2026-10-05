// Worker MCP config: where each provider reads its MCP server list, writing /
// removing the worker's adhdev entry (workspace or worker-private target), and the
// isolation placeholder expansion. Split out of worker-mcp-isolation.ts
// (re-exported there).

import type { MeshCoordinatorConfigFormat } from './mesh-refine-gates.js';
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
 *    grok-cli, kimi, opencode — and claude-cli itself on a non-forced launch),
 *    this function returns null and `writeWorkerMcpConfig` MERGES onto the
 *    shared file instead of replacing it — see that function's `isPrivateWorkerTarget`
 *    branch below, which is the actual fix for those providers' clobber.
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
 * True when `target` is a path ONLY this worker launch can possibly read —
 * i.e. NOT the shared, auto-imported config file a CLI discovers on its own.
 *
 * - `privateConfigPath` set ⇒ a per-session temp file under
 *   `resolvePrivateWorkerMcpConfigPath`'s root — nothing else reads it.
 * - `workerHome` set ⇒ the target sits inside a worker-scoped HOME/config-root
 *   this daemon materialized for this launch alone.
 * Neither set ⇒ the target is `resolveWorkerMcpConfigPath`'s auto-import
 * location resolved against the REAL workspace (and, for a home-rooted
 * declared path with no worker HOME, `writeWorkerMcpConfig` already refuses
 * before reaching here) — i.e. exactly the SHARED-WORKSPACE CLOBBER case.
 */
function isPrivateWorkerTarget(input: Pick<WriteWorkerMcpConfigInput, 'privateConfigPath' | 'workerHome'>): boolean {
    return Boolean(input.privateConfigPath || input.workerHome);
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

    const entryEnv: Record<string, string> = {};
    if (input.token) entryEnv.ADHDEV_WORKER_TASK_TOKEN = input.token;
    if (input.bind) entryEnv.ADHDEV_WORKER_SESSION_BIND = input.bind;
    const workerEntry = input.server
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
        ? buildMeshCoordinatorMcpServerEntry(input.format, {
            command: input.server.command,
            args: input.server.args,
            ...(Object.keys(entryEnv).length ? { env: entryEnv } : {}),
        })
        : null;

    const serversKey = getMcpServersKey(input.format);
    let config: Record<string, any>;

    if (isPrivateWorkerTarget(input)) {
        const servers: Record<string, any> = {};
        if (workerEntry) servers[input.serverName] = workerEntry;
        config = { [serversKey]: servers };
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
        const existingServersRaw = existing[serversKey];
        const existingServers = (existingServersRaw && typeof existingServersRaw === 'object' && !Array.isArray(existingServersRaw))
            ? existingServersRaw
            : {};
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
    return target;
}

/**
 * Cleanup counterpart to the SHARED-target branch of `writeWorkerMcpConfig`:
 * remove ONLY the worker's own server entry from a shared auto-import config,
 * leaving every other top-level key and every sibling server entry untouched.
 *
 * Call this when a delegated worker session on a SHARED target ends, so the
 * coordinator's (or owner's) config does not keep carrying a dead worker
 * entry with a revoked bind/token after the process exits. A no-op (returns
 * false) when the file is missing, unparsable, or does not currently carry
 * `serverName` — safe to call speculatively without checking those first.
 *
 * Deliberately NOT called for a PRIVATE target (`isPrivateWorkerTarget`):
 * those live under a per-session temp dir or a worker-scoped HOME that gets
 * torn down as a whole directory, so per-entry surgery is unnecessary there.
 */
export function removeWorkerMcpConfigEntry(input: {
    declaredPath: string;
    format: MeshCoordinatorConfigFormat;
    serverName: string;
    workspace: string;
    workerHome?: string;
    configRootPrefix?: string;
    privateConfigPath?: string;
}): boolean {
    if (isPrivateWorkerTarget(input)) return false;
    if (!isSupportedMeshCoordinatorConfigFormat(input.format)) return false;
    const target = resolveWorkerMcpConfigPath(
        input.declaredPath,
        input.workspace,
        input.workerHome,
        input.configRootPrefix,
    );
    if (!existsSync(target)) return false;
    let existing: Record<string, any>;
    try {
        existing = parseMeshCoordinatorMcpConfig(readFileSync(target, 'utf-8'), input.format);
    } catch (err: any) {
        LOG.warn('WorkerMcp', `worker MCP cleanup: failed to parse ${target}: ${err?.message || err}`);
        return false;
    }
    const serversKey = getMcpServersKey(input.format);
    const serversRaw = existing[serversKey];
    const servers = (serversRaw && typeof serversRaw === 'object' && !Array.isArray(serversRaw)) ? serversRaw : null;
    if (!servers || !(input.serverName in servers)) return false;

    const nextServers = { ...servers };
    delete nextServers[input.serverName];
    const next = { ...existing, [serversKey]: nextServers };
    try {
        writeFileSync(target, serializeMeshCoordinatorMcpConfig(next, input.format), 'utf-8');
    } catch (err: any) {
        LOG.warn('WorkerMcp', `worker MCP cleanup: failed to write ${target}: ${err?.message || err}`);
        return false;
    }
    LOG.info('WorkerMcp', `removed worker MCP entry "${input.serverName}" from shared config ${target}`);
    return true;
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
