import * as os from 'os';
import * as path from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { shortHash } from '../system/hash.js';
import { expandWorkerIsolationPlaceholders, resolveWorkerMcpIsolation, type WorkerMcpConfigOverrideDelivery, type WorkerMcpIsolation } from '../mesh/worker-mcp-isolation.js';
import { resolveWorkerMcpServerLaunch } from './mesh-coordinator.js';
import type { MeshCoordinatorDelegatedWorkerIsolation } from '../providers/contracts.js';
import type { PreLaunchTrust } from '../providers/spec/fsm-types.js';
import { LOG } from '../logging/logger.js';
import {
    loadPreLaunchTrustFromSpecPath,
    recordWorkerAutoTrustGrant,
    resolveLaunchTrustPlan,
    type ResolvedTrustPlan,
    type TrustLifecycle,
} from '../providers/trust-provenance-ledger.js';

const DEFAULT_COORDINATOR_DELEGATED_ENV_UNSETS = [
    'ADHDEV_INLINE_MESH',
    'ADHDEV_MCP_TRANSPORT',
    'ADHDEV_MESH_ID',
    'HERMES_EPHEMERAL_SYSTEM_PROMPT',
] as const;

export interface CoordinatorDelegatedCliLaunchOptionsInput {
    cliType: string;
    workspace: string;
    cliArgs?: string[];
    env?: Record<string, string>;
    isolation?: MeshCoordinatorDelegatedWorkerIsolation;
    /**
     * WORKER-MCP: the provider's declared `meshCoordinator.mcpConfig`, used to
     * write a worker-scoped config to the path the provider already names.
     * Absent (or gate off) ⇒ prior behavior, unchanged.
     */
    mcpConfig?: {
        mode?: string;
        format?: string;
        path?: string;
        serverName?: string;
    };
    /** Stable per-launch key so two workers never share a private HOME. */
    sessionKey?: string;
    /** Provider spec path; worker trust declarations are loaded in this module. */
    resolvedSpecPath?: string;
    /** Optional validated/test seam; production supplies resolvedSpecPath. */
    preLaunchTrust?: PreLaunchTrust;
    /** Optional lifecycle override retained for embeddings/tests. */
    trustLifecycle?: TrustLifecycle;
    trustContext?: {
        meshId?: string;
        nodeId?: string;
        taskId?: string;
    };
    /** Test/embedding seams; production uses the daemon's normal roots. */
    realHome?: string;
    workerHomeBaseDir?: string;
    trustLedgerPath?: string;
    nowMs?: number;
    runtimeEnv?: NodeJS.ProcessEnv;
    /**
     * WORKER-MCP Phase B: mesh + runtime session this worker is being launched
     * for. Present ⇒ the written config carries a worker MCP server entry and a
     * session bind, giving the worker `report_completion`. Absent ⇒ Phase A
     * behavior (isolating config, no server).
     */
    bindContext?: {
        meshId: string;
        sessionId: string;
        nodeId?: string;
        spawnedForTaskId?: string;
    };
}

export interface CoordinatorDelegatedCliLaunchOptions {
    cliArgs: string[];
    env: Record<string, string>;
    /** Set only when the worker-MCP gate produced an isolation surface. */
    workerIsolation?: WorkerMcpIsolation;
    /** Present (or explicitly null) when this provider declares pre-launch trust. */
    resolvedTrustPlan?: ResolvedTrustPlan | null;
}

function hasCliArg(args: string[], flag: string): boolean {
    return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Decide the session-registry spawnedAtMs (the native-history session-floor) for a
 * newly registered CLI instance.
 *
 * - Fresh launch (attachExisting=false): now (nowMs). A real live spawn floor
 *   isolates a fresh session's own store and holds prior-session leak protection.
 * - Attach WITH a recoverable record startedAt (a PAST timestamp): that startedAt.
 *   Restoring a hosted runtime (coordinator / MAGI replica / hermes / claude /
 *   codex) after a daemon restart, the real spawn time is in the past. Using it
 *   restores each session's per-session birth-floor so co-located antigravity
 *   runtimes resolve their OWN conversation (ownerConfirmed) instead of the
 *   floor-less newest-by-mtime path that let a replica claim the coordinator's conv.
 * - Attach with NO recoverable startedAt: 0 — disables the floor for this session
 *   (recent_window_ms still bounds the look-back). NEVER use nowMs here: nowMs is in
 *   the FUTURE relative to existing transcripts and would push the floor past every
 *   transcript file, losing them (the ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP regression).
 */
export function resolveHostedSpawnedAtMs(
    attachExisting: boolean,
    attachStartedAtMs: number | undefined,
    nowMs: number,
): number {
    if (!attachExisting) return nowMs;
    if (typeof attachStartedAtMs === 'number' && attachStartedAtMs > 0) return attachStartedAtMs;
    return 0;
}

function hasConfigOverride(args: string[], key: string): boolean {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const next = args[index + 1];
        if ((arg === '-c' || arg === '--config') && typeof next === 'string') {
            if (next === key || next.startsWith(`${key}=`) || next.startsWith(`${key}.`)) return true;
        }
        if (arg.startsWith('--config=')) {
            const value = arg.slice('--config='.length);
            if (value === key || value.startsWith(`${key}=`) || value.startsWith(`${key}.`)) return true;
        }
    }
    return false;
}

function ensureEmptyDelegatedMcpConfig(workspace: string): string {
    const baseDir = path.join(os.tmpdir(), 'adhdev-delegated-agent-empty-mcp');
    mkdirSync(baseDir, { recursive: true });
    const workspaceHash = shortHash(path.resolve(workspace || os.tmpdir()));
    const filePath = path.join(baseDir, `${workspaceHash}.json`);
    writeFileSync(filePath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
    return filePath;
}


function renderWorkerMcpConfigOverrideTemplate(
    template: string,
    delivery: WorkerMcpConfigOverrideDelivery,
): string {
    const replacements: Record<string, string> = {
        serverName: delivery.serverName,
        command_json: JSON.stringify(delivery.command),
        args_json: JSON.stringify(delivery.args),
        env_vars_json: JSON.stringify(delivery.envVars),
    };
    let rendered = template;
    for (const [name, value] of Object.entries(replacements)) {
        rendered = rendered.split(`{{${name}}}`).join(value);
        rendered = rendered.split(`{${name}}`).join(value);
    }
    return rendered;
}

function renderWorkerMcpDeliveryArgs(
    cliArgs: string[],
    delivery: WorkerMcpConfigOverrideDelivery,
): string[] {
    const templates = [
        delivery.commandTemplate,
        delivery.argsTemplate,
        delivery.envVarsTemplate,
        delivery.enabledTemplate,
        delivery.shellEnvExcludeTemplate,
    ];
    const renderedArgs: string[] = [];
    for (const template of templates) {
        if (!template) continue;
        const override = renderWorkerMcpConfigOverrideTemplate(template, delivery);
        const separator = override.indexOf('=');
        const key = separator > 0 ? override.slice(0, separator).trim() : '';
        if (!key || hasConfigOverride([...renderedArgs, ...cliArgs], key)) continue;
        renderedArgs.push(delivery.flag, override);
    }
    return renderedArgs;
}

export function buildCoordinatorDelegatedCliLaunchOptions(
    input: CoordinatorDelegatedCliLaunchOptionsInput,
): CoordinatorDelegatedCliLaunchOptions {
    const cliArgs = Array.isArray(input.cliArgs) ? [...input.cliArgs] : [];
    const env: Record<string, string> = { ...(input.env || {}) };
    const envUnsets = new Set<string>(DEFAULT_COORDINATOR_DELEGATED_ENV_UNSETS);
    for (const key of input.isolation?.env?.unset || []) {
        if (typeof key === 'string' && key.trim()) envUnsets.add(key.trim());
    }

    // WORKER-MCP (design §3). Returns null while the ADHDEV_WORKER_MCP gate is
    // off, and every use below is guarded on that null — so gate-off output is
    // byte-identical to the pre-feature behavior. This is the ONE place the
    // config/HOME axis consults the flag.
    const workerIsolation = resolveWorkerMcpIsolation({
        providerType: input.cliType,
        workspace: input.workspace,
        sessionKey: input.sessionKey || input.workspace,
        mcpConfig: input.mcpConfig,
        workerMcpDelivery: input.isolation?.workerMcpDelivery,
        realHome: input.realHome,
        baseDir: input.workerHomeBaseDir,
        // Phase B: with a mesh+session to bind, the worker gets a MINIMAL MCP
        // server (`--mode worker`) plus the bind it exchanges for its task
        // token. Without one, Phase A's shape stands — a config with no servers
        // at all, whose isolation win is that the coordinator's 60-tool entry is
        // absent from the file the worker reads.
        ...(input.bindContext
            ? { bindContext: input.bindContext, server: resolveWorkerMcpServerLaunch() }
            : {}),
    }, input.runtimeEnv || process.env);

    // TRUST-PROVENANCE C: private HOME/imports above must exist before the
    // grant is ledgered. The driver receives this already-absolute plan and
    // materializes it into the per-worker copy immediately before PTY spawn.
    const preLaunchTrust = input.preLaunchTrust
        || loadPreLaunchTrustFromSpecPath(input.resolvedSpecPath)
        || undefined;
    let resolvedTrustPlan: ResolvedTrustPlan | null | undefined;
    if (preLaunchTrust) {
        resolvedTrustPlan = null;
        if (workerIsolation?.workerHome) {
            const lifecycle: TrustLifecycle = input.trustLifecycle || {
                kind: 'worktree',
                worktreePath: path.resolve(input.workspace),
                ...(input.trustContext?.meshId ? { meshId: input.trustContext.meshId } : {}),
                ...(input.trustContext?.nodeId ? { nodeId: input.trustContext.nodeId } : {}),
                ...(input.trustContext?.taskId ? { taskId: input.trustContext.taskId } : {}),
                expiresAt: null,
            };
            const candidate = resolveLaunchTrustPlan({
                provider: input.cliType,
                workspace: input.workspace,
                trust: preLaunchTrust,
                storeHome: workerIsolation.workerHome,
                scope: 'worker',
                origin: 'worker_auto',
                sessionKey: input.sessionKey || input.workspace,
                lifecycle,
            });
            if (candidate) {
                try {
                    const recorded = recordWorkerAutoTrustGrant(candidate, {
                        ledgerPath: input.trustLedgerPath,
                        nowMs: input.nowMs,
                    });
                    resolvedTrustPlan = candidate;
                    workerIsolation.notes.push(
                        `${recorded.reused ? 'reused' : 'recorded'} worker-auto trust grant ${recorded.grant.grantId}`,
                    );
                } catch (err: any) {
                    // Ledger is the source of truth. Never create an unledgered
                    // projection, and never fall back to the user's real store.
                    workerIsolation.notes.push(`worker trust ledger unavailable (${err?.message || err})`);
                    LOG.warn('WorkerTrust', `worker-auto trust grant failed for ${input.cliType}: ${err?.message || err}`);
                }
            }
        }
    }

    // Provider-declared env VALUES (env.set), applied before the unset sweep so
    // `unset` always wins on a key named by both — the clear is the stronger,
    // safer outcome and keeping that order means a manifest can never
    // resurrect a variable the daemon scrubs unconditionally.
    //
    // Only meaningful when the worker-MCP gate is on: `{{workerHome}}` expands
    // to a worker-private HOME that only exists under the gate, so applying
    // these with the gate off would export a placeholder-laden path.
    const envSet = input.isolation?.env?.set;
    if (workerIsolation && envSet && typeof envSet === 'object') {
        for (const [rawKey, rawValue] of Object.entries(envSet)) {
            const key = typeof rawKey === 'string' ? rawKey.trim() : '';
            if (!key || envUnsets.has(key)) continue;
            if (typeof rawValue !== 'string' || !rawValue.trim()) continue;
            const expanded = expandWorkerIsolationPlaceholders(rawValue, workerIsolation);
            if (expanded) env[key] = expanded;
        }
    }

    // Point the worker at its private HOME. Without this the CLI still reads
    // the real `~` and the whole private-HOME construction is inert — the
    // directory would exist and simply never be consulted.
    //
    // Applied by the daemon rather than requiring a manifest `env.set` entry:
    // the HOME redirection is a property of "this provider roots its config in
    // ~", which the daemon already knows from WORKER_PRIVATE_HOME_SPECS. A
    // provider can still override the variable NAME via env.set (above) for a
    // CLI that uses something other than HOME; that declaration wins because it
    // is applied first and this only fills HOME when unset.
    if (workerIsolation?.workerHome && !envUnsets.has('HOME') && !env.HOME) {
        env.HOME = workerIsolation.workerHome;
        // win32 resolves the profile through USERPROFILE, not HOME.
        if (process.platform === 'win32' && !env.USERPROFILE) {
            env.USERPROFILE = workerIsolation.workerHome;
        }
    }

    for (const key of envUnsets) env[key] = '';

    // config_override delivery is intentionally rendered at the launch seam:
    // the bind VALUE goes only into the Codex process environment, while argv
    // carries the non-secret variable name for Codex to forward to its MCP
    // child. shellEnvExcludeTemplate can simultaneously scrub it from shell
    // tool children without blocking the explicit MCP forwarding path.
    if (workerIsolation?.delivery && workerIsolation.bind) {
        env[workerIsolation.delivery.bindEnvVar] = workerIsolation.bind;
        const deliveryArgs = renderWorkerMcpDeliveryArgs(cliArgs, workerIsolation.delivery);
        cliArgs.unshift(...deliveryArgs);
    }

    for (const rule of input.isolation?.args || []) {
        if (!rule || typeof rule !== 'object') continue;
        if (rule.mode === 'empty_mcp_config') {
            if (rule.flag && !hasCliArg(cliArgs, rule.flag)) {
                cliArgs.unshift(rule.flag, ensureEmptyDelegatedMcpConfig(input.workspace));
            }
            if (rule.strictFlag && !hasCliArg(cliArgs, rule.strictFlag)) {
                cliArgs.unshift(rule.strictFlag);
            }
            continue;
        }
        if (rule.mode === 'config_override') {
            const key = String(rule.dedupeKey || rule.key || '').trim();
            const flag = String(rule.flag || '').trim();
            if (!key || !flag || hasConfigOverride(cliArgs, key)) continue;
            cliArgs.unshift(flag, `${rule.key}=${rule.value}`);
        }
    }

    return {
        cliArgs,
        env,
        ...(workerIsolation ? { workerIsolation } : {}),
        ...(resolvedTrustPlan !== undefined ? { resolvedTrustPlan } : {}),
    };
}
