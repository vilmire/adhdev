/**
 * DaemonCliManager — session launch: `startSession` (CLI/PTY) and the
 * `launch_cli` command (delegated-worker launch preparation + launch ledger).
 *
 * Split out of cli-manager.ts (file-size gate). Functions take the manager
 * through the compiler-checked {@link CliLaunchHost} view.
 */
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import chalk from 'chalk';
import { detectCLI } from '../detection/cli-detector.js';
import { loadConfig } from '../config/config.js';
import { getWorkspaceState, resolveLaunchDirectory } from '../config/workspaces.js';
import { meshRecord } from '../mesh/mesh-record.js';
import {
    resolveDelegatedWorkerAutoApproveModeForLaunch, logDelegatedWorkerModeDelivery,
} from '../mesh/delegated-worker-mode-delivery.js';
import { type ProviderModule } from '../providers/contracts.js';
import { LOG } from '../logging/logger.js';
import { readModelCache } from '../models/registry.js';
import {
    buildSessionLaunchRecord, resolveProviderDefaultModel, readLaunchProvenanceArgs, inferLaunchedBy,
    type LaunchProvenanceArgs, type SessionLaunchedBy, type SessionLaunchRecord,
} from '../sessions/launch-record.js';
import {
    loadPreLaunchTrustFromSpecPath, resolveLaunchTrustPlan, type ResolvedTrustPlan,
} from '../providers/trust-provenance-ledger.js';
import { deriveWorkerMcpDeliveryStatus, type WorkerMcpDeliveryStatus } from '../mesh/worker-mcp-isolation.js';
import { buildLegacyModelModeSummaryMetadata } from '../providers/summary-metadata.js';
import { expandModelLaunchArgs, resolveModelLaunchValue } from './model-launch-args.js';
import { buildCoordinatorDelegatedCliLaunchOptions } from './cli-delegated-launch.js';
import {
    applyAutoApproveModeLaunchArgs, expandThinkingLaunchArgs, resolveCliSessionBinding,
} from './cli-session-binding.js';
import type { DaemonCliManager } from './cli-manager.js';

/** The DaemonCliManager members these functions read or call (compiler-checked; no cast). */
export type CliLaunchHost = Pick<DaemonCliManager, 'adapters' | 'createAdapter' | 'deps' | 'persistRecentActivity' | 'providerLoader' | 'readProviderChannel' | 'registerCliInstance' | 'scheduleAutoClean' | 'startSession'>;

 // ─── Session start/management ──────────────────────────────
export async function startSession(host: CliLaunchHost, cliType: string, workingDir: string, cliArgs?: string[], initialModel?: string, options?: CliStartOptions): Promise<{ runtimeSessionId: string; providerSessionId?: string }> {
    const plan = planSessionStart(host, cliType, workingDir, options);
    return startCliPtySession(host, plan, cliType, cliArgs, initialModel);
}

/** What every start path shares: the resolved target and the finalized options. */
interface SessionStartPlan {
    resolvedDir: string;
    normalizedType: string;
    provider: ProviderModule | undefined;
    /** The runtime session id (preset by a delegated launch, else a fresh uuid). */
    key: string;
    options: CliStartOptions | undefined;
}

/**
 * Stage 1 — resolve the directory and provider, refuse a machine-disabled
 * provider, mint the session key, and finalize the launch options (trust plan,
 * coordinator session env).
 */
function planSessionStart(host: CliLaunchHost, cliType: string, workingDir: string, options: CliStartOptions | undefined): SessionStartPlan {
    const trimmed = (workingDir || '').trim();
    if (!trimmed) throw new Error('working directory required');
    const resolvedDir = trimmed.startsWith('~')
        ? trimmed.replace(/^~/, os.homedir())
        : path.resolve(trimmed);

 // cliType normalize (Resolve alias)
    const normalizedType = host.providerLoader.resolveAlias(cliType);
    const rawProvider = host.providerLoader.getByAlias(cliType);
    const provider = rawProvider ? (host.providerLoader.resolve(normalizedType) || rawProvider) : undefined;
    if (provider && (provider.category === 'cli') && !host.providerLoader.isMachineProviderEnabled(normalizedType)) {
        const displayName = provider.displayName || provider.name || normalizedType;
        throw new Error(
            `${displayName} is disabled on this machine.\n` +
            `Enable and detect this provider from the Machine Providers page before starting a runtime.`
        );
    }

 // Create UUID-based key (allows separate instances even for same type+dir).
 // A delegated worker launch supplies this id up front so the MCP config it
 // already wrote can name this session (see CliStartOptions.presetSessionKey).
    const key = options?.presetSessionKey?.trim() || crypto.randomUUID();

    // TRUST-PROVENANCE C: user launches retain the existing real-HOME
    // behavior, but the path is resolved here in launch planning. A
    // delegated launch must provide its worker-private plan explicitly;
    // absence is represented as null so no daemon-HOME fallback is possible.
    if (provider && provider.category === 'cli' && options?.resolvedTrustPlan === undefined) {
        const declaredTrust = loadPreLaunchTrustFromSpecPath(
            (provider as unknown as { _resolvedSpecPath?: string })._resolvedSpecPath,
        );
        const delegated = options?.settingsOverride?.launchedByCoordinator === true;
        const resolvedTrustPlan = !delegated && declaredTrust
            ? resolveLaunchTrustPlan({
                provider: normalizedType,
                workspace: resolvedDir,
                trust: declaredTrust,
                storeHome: os.homedir(),
                scope: 'user',
                origin: 'user_confirmed',
                sessionKey: key,
                lifecycle: { kind: 'persistent', expiresAt: null },
            })
            : null;
        options = { ...options, resolvedTrustPlan };
    }

    // (3) Session-anchored mesh routing: when launching a mesh COORDINATOR session
    // (settings.meshCoordinatorFor set), expose this session's OWN runtime id to its MCP
    // server via env. The MCP server is spawned by the CLI as a child and inherits this
    // env, so the MCP layer can stamp ADHDEV_COORDINATOR_SESSION_ID as the originating
    // coordinator on every dispatch (→ MeshContext.coordinatorSessionId → worker
    // meshCoordinatorSessionId → completion targetCoordinatorSessionId → strict route).
    // `key` IS the instance id findLiveCoordinators matches on, so the stamp and the live
    // session agree. Re-applied on every (re)launch, so it always reflects the current id;
    // a stale value only survives if the CLI process outlives a daemon restart, in which
    // case routing falls back to the daemon level (no wedge — see mesh-reconcile-loop).
    {
        const coordinatorMeshId = (options?.settingsOverride as Record<string, unknown> | undefined)?.meshCoordinatorFor;
        if (typeof coordinatorMeshId === 'string' && coordinatorMeshId.trim()) {
            options = { ...options, extraEnv: { ...(options?.extraEnv || {}), ADHDEV_COORDINATOR_SESSION_ID: key } };
        }
    }
    return { resolvedDir, normalizedType, provider, key, options };
}

/** CLI category: detect the binary, expand launch args, then register (or directly spawn) the PTY session. */
async function startCliPtySession(
    host: CliLaunchHost,
    plan: SessionStartPlan,
    cliType: string,
    cliArgs: string[] | undefined,
    initialModel: string | undefined,
): Promise<{ runtimeSessionId: string; providerSessionId?: string }> {
    const { resolvedDir, normalizedType, provider, key, options } = plan;
    const cliInfo = await detectCLI(cliType, host.providerLoader);
    if (!cliInfo) {
        const installHint = provider?.install || '';
        const displayName = provider?.displayName || provider?.name || cliType;
        const spawnCmd = host.providerLoader.getSpawnCommand(normalizedType, provider?.spawn?.command || cliType);
        throw new Error(
            `${displayName} is not installed.\n` +
            `Command '${spawnCmd}' is not available.\n` +
            (installHint ? `\n${installHint}\n` : '') +
            `\nRun 'adhdev doctor' for detailed diagnostics.`
        );
    }

    console.log(colorize('yellow', `  ⚡ Starting CLI ${cliType} in ${resolvedDir}...`));
    if (provider) {
        console.log(colorize('cyan', `  📦 Using provider: ${provider.name} (${provider.type})`));
    }

    const launchSettings = {
        ...host.providerLoader.getSettings(normalizedType),
        ...(options?.settingsOverride || {}),
    };
    const versionResolvedProvider = provider
        ? (host.providerLoader.resolve(cliType, { version: cliInfo.version }) || provider)
        : undefined;
    const autoApproveLaunch = applyAutoApproveModeLaunchArgs(versionResolvedProvider, cliArgs, launchSettings);
    const launchProvider = autoApproveLaunch.provider || provider;
    const cliArgsWithAutoApprove = autoApproveLaunch.cliArgs;

 // ─── Model axis: expand initialModel → launch args ───
 // For a plain CLI provider the model is selected at spawn time via the manifest's
 // modelLaunchArgs template ('{{model}}' → the requested model). ACP providers took
 // the setConfigOption path above and never reach here. A provider with no template,
 // or no requested model, is a no-op — model selection is best-effort and must never
 // fail a launch. The model args are prepended so a caller's explicit cliArgs (e.g. a
 // resume flag) still win positionally where order matters.
    const modelLaunchArgs = expandModelLaunchArgs(
        launchProvider?.modelLaunchArgs,
        initialModel,
        launchProvider?.modelLaunchValueMap,
    );
    const cliArgsWithModel = modelLaunchArgs
        ? [...modelLaunchArgs, ...(cliArgsWithAutoApprove || [])]
        : cliArgsWithAutoApprove;
    if (initialModel && !modelLaunchArgs) {
        LOG.warn('CLI', `[${normalizedType}] initialModel='${initialModel}' requested but provider declares no modelLaunchArgs template — launching without model selection.`);
    }

 // ─── Thinking axis (brain routing): expand initialThinkingLevel → launch args ───
 // Parallel to the model axis: a plain CLI provider selects reasoning effort at spawn
 // via the manifest's thinkingLaunchArgs template ('{{level}}' → the mapped level).
 // Best-effort; a provider with no template (or no requested level) is a no-op. ACP
 // providers route thinking through setConfigOption('thought_level') above.
    const initialThinkingLevel = options?.initialThinkingLevel;
    const thinkingLaunchArgs = expandThinkingLaunchArgs(launchProvider?.thinkingLaunchArgs, initialThinkingLevel, launchProvider?.thinkingLevelMap);
    const cliArgsWithBrain = thinkingLaunchArgs
        ? [...thinkingLaunchArgs, ...(cliArgsWithModel || [])]
        : cliArgsWithModel;
    if (initialThinkingLevel && !thinkingLaunchArgs) {
        LOG.warn('CLI', `[${normalizedType}] initialThinkingLevel='${initialThinkingLevel}' requested but provider declares no thinkingLaunchArgs template — launching without thinking-level selection.`);
    }

 // ─── Resolve launch options → provider session binding ───
    const sessionBinding = resolveCliSessionBinding(launchProvider, normalizedType, cliArgsWithBrain, options?.resumeSessionId);
    const resolvedCliArgs = sessionBinding.cliArgs;

    // ─── Phase E: launch record ───
    // `launchValue` is what the argv actually carries: the mapped value when
    // a template consumed the request, absent when no template did (the
    // warnings above). A runtime-control thinking level (hermes) is applied
    // after spawn, so it stays requested-only here.
    const cliLaunchRecord = buildSessionLaunchRecord({
        sessionId: key,
        providerType: normalizedType,
        providerVersion: (launchProvider as { providerVersion?: string } | undefined)?.providerVersion,
        providerChannel: host.readProviderChannel(),
        launchedBy: options?.launchProvenance?.launchedBy ?? 'api',
        launchedAt: Date.now(),
        workspace: resolvedDir,
        model: {
            requested: initialModel,
            declaredSource: options?.launchProvenance?.modelSource,
            launchValue: modelLaunchArgs
                ? resolveModelLaunchValue(initialModel, launchProvider?.modelLaunchValueMap)
                : undefined,
            providerDefault: resolveProviderDefaultModel(
                readModelCache(normalizedType),
                launchProvider?.modelOptions,
                launchProvider?.modelLaunchValueMap,
            ),
        },
        thinkingLevel: {
            requested: initialThinkingLevel,
            declaredSource: options?.launchProvenance?.thinkingLevelSource,
            launchValue: thinkingLaunchArgs
                ? resolveModelLaunchValue(initialThinkingLevel, launchProvider?.thinkingLevelMap)
                : undefined,
        },
        autoApproveModeId: typeof launchSettings?.autoApproveMode === 'string' ? launchSettings.autoApproveMode : undefined,
    });

 // If InstanceManager exists, manage as CliProviderInstance unified
    const instanceManager = host.deps.getInstanceManager();
    if (launchProvider && instanceManager) {
        const resolvedProvider = launchProvider;
        await host.registerCliInstance(
            key,
            normalizedType,
            cliType,
            resolvedDir,
            resolvedCliArgs,
            resolvedProvider,
            launchSettings,
            false,
            {
                providerSessionId: sessionBinding.providerSessionId,
                launchMode: sessionBinding.launchMode,
                extraEnv: options?.extraEnv,
                resolvedTrustPlan: options?.resolvedTrustPlan,
                // PERMISSION-MODE-DUPLICATE: the mode's launchArgs are already in
                // resolvedCliArgs; the spec's own base args still need stripping.
                ...(autoApproveLaunch.removeArgs?.length ? { removeSpawnArgs: autoApproveLaunch.removeArgs } : {}),
                // BRAIN-ROUTING: for a provider with no thinkingLaunchArgs but a
                // runtime reasoning control (hermes), apply the level post-launch.
                // The launch-arg providers (claude/codex) already consumed it at spawn.
                ...(options?.initialThinkingLevel && !provider?.thinkingLaunchArgs ? { initialThinkingLevel: options.initialThinkingLevel } : {}),
                launchRecord: cliLaunchRecord,
                onProviderSessionResolved: ({ providerSessionId, providerName, providerType, workspace }) => {
                    host.persistRecentActivity({
                        kind: 'cli',
                        providerType,
                        providerName,
                        providerSessionId,
                        workspace,
                        title: providerName,
                    });
                },
            },
        );
        console.log(colorize('green', `  ✓ CLI started: ${cliInfo.displayName} v${cliInfo.version || 'unknown'} in ${resolvedDir}`));
    } else {
 // Fallback: InstanceManager without directly adapter manage
        const adapter = host.createAdapter(
            cliType,
            resolvedDir,
            resolvedCliArgs,
            key,
            sessionBinding.providerSessionId,
            false,
            options?.extraEnv,
            autoApproveLaunch.removeArgs,
            options?.resolvedTrustPlan,
        );
        try {
            await adapter.spawn();
        } catch (spawnErr: any) {
            LOG.error('CLI', `[${cliType}] Spawn failed: ${spawnErr?.message}`);
            throw new Error(`Failed to start ${cliInfo.displayName}: ${spawnErr?.message}`);
        }

        adapter.setOnStatusChange(() => {
            const status = adapter.getStatus?.();
            if (status?.status === 'stopped' || status?.status === 'error') {
                host.scheduleAutoClean(key, adapter, status.status);
            }
        });

        if (typeof adapter.setOnPtyData === 'function') {
            adapter.setOnPtyData((data: string) => {
                host.deps.getP2p()?.broadcastSessionOutput(key, data);
            });
        }

        host.adapters.set(key, adapter);
        console.log(colorize('green', `  ✓ CLI started: ${cliInfo.displayName} v${cliInfo.version || 'unknown'} in ${resolvedDir}`));
    }

    host.persistRecentActivity({
        kind: 'cli',
        providerType: normalizedType,
        providerName: provider?.displayName || provider?.name || normalizedType,
        providerSessionId: sessionBinding.providerSessionId,
        workspace: resolvedDir,
        summaryMetadata: launchSummaryMetadata(cliLaunchRecord),
        sessionId: key,
        title: provider?.displayName || provider?.name || normalizedType,
    });

    return {
        runtimeSessionId: key,
        providerSessionId: sessionBinding.providerSessionId,
    };
}

 // ─── CLI command handling ────────────────────────────

/** `launch_cli`: resolve the launch directory and start (or reuse) a CLI session. */
export async function launchCli(host: CliLaunchHost, args: any): Promise<CommandResult> {
    const cliType = args?.cliType;
    const config = loadConfig();
    const resolved = resolveLaunchDirectory(
        {
            dir: args?.dir,
            workspaceId: args?.workspaceId,
            useDefaultWorkspace: args?.useDefaultWorkspace === true,
            useHome: args?.useHome === true,
        },
        config,
    );
    if (!resolved.ok) {
        const ws = getWorkspaceState(config);
        return {
            success: false,
            error: resolved.message,
            code: resolved.code,
            workspaces: ws.workspaces,
            defaultWorkspacePath: ws.defaultWorkspacePath,
        };
    }
    const dir = resolved.path;
    const launchSource = resolved.source;
    if (!cliType) throw new Error('cliType required');

    // ★STORE-RELOAD: check provider-map freshness here — right before
    // the map is read for a launch, never during a spawn in flight.
    // Debounced inside the loader (see refreshIfChannelActivationChanged
    // for the out-of-process activation gap this closes).
    //
    // Guarded twice: optional-called (embedders/tests inject duck-typed
    // loaders with only resolveAlias/getMeta/getResolvedSpecPath) and
    // wrapped. A stale map is a degradation; a failed spawn is an outage.
    try {
        host.providerLoader.refreshIfChannelActivationChanged?.();
    } catch (e: any) {
        LOG.warn('ProviderStore', `channel activation refresh failed: ${e?.message || e}`);
    }
    const providerType = host.providerLoader.resolveAlias(cliType);
    const provLookup = host.providerLoader.getMeta(providerType) as ProviderModule | undefined;
    const { settingsOverride, delegatedSessionKey, delegatedMeshId, delegatedLaunch, workerMcpDelivery } = prepareDelegatedLaunch(
        host, args, cliType, dir, providerType, provLookup,
    );
    // Untrusted-provider gate: an external source that ships JS
    // hooks needs explicit user confirmation before its first
    // launch. Dashboards add `confirmExternalUntrusted: true` to
    // the launch args after showing the trust modal. Without
    // that ack we refuse to spawn and tell the caller why.
    const provMeta = provLookup as any;
    const provTrust = provMeta?._sourceTrust;
    if (provTrust === 'external-untrusted' && args?.confirmExternalUntrusted !== true) {
        return {
            success: false,
            error: 'untrusted_external_provider',
            provider: {
                type: provLookup?.type ?? cliType,
                sourceName: provMeta?._sourceName ?? null,
                trust: provTrust,
            },
            hint: 'Resend launch_cli with confirmExternalUntrusted=true after the user explicitly approves running JavaScript from this 3rd-party source.',
        };
    }
    const started = await host.startSession(
        cliType,
        dir,
        delegatedLaunch ? delegatedLaunch.cliArgs : args?.cliArgs,
        args?.initialModel,
        {
            resumeSessionId: args?.resumeSessionId,
            settingsOverride,
            extraEnv: delegatedLaunch ? delegatedLaunch.env : args?.env,
            ...(delegatedLaunch && 'resolvedTrustPlan' in delegatedLaunch
                ? { resolvedTrustPlan: delegatedLaunch.resolvedTrustPlan }
                : {}),
            ...(delegatedSessionKey ? { presetSessionKey: delegatedSessionKey } : {}),
            ...(typeof args?.initialThinkingLevel === 'string' && args.initialThinkingLevel.trim() ? { initialThinkingLevel: args.initialThinkingLevel.trim() } : {}),
            launchProvenance: resolveLaunchProvenance(args, settingsOverride),
        },
    );

    const ledgerLaunchRecorded = delegatedMeshId
        ? recordDelegatedLaunch(delegatedMeshId, settingsOverride, providerType, started)
        : false;

    return {
        success: true,
        cliType,
        dir,
        id: started.runtimeSessionId,
        sessionId: started.runtimeSessionId,
        providerSessionId: started.providerSessionId,
        launchSource,
        ...(ledgerLaunchRecorded ? { ledgerLaunchRecorded: true } : {}),
        // ★See workerMcpDelivery comment above: only present for a delegated
        // (mesh-identified) launch, so an ordinary user-initiated launch_cli
        // response is unchanged.
        ...(workerMcpDelivery ? { workerMcp: workerMcpDelivery } : {}),
    };
}

export type CommandResult = { success: boolean;[key: string]: unknown };

type ChalkColorFn = (text: string) => string;
type ChalkLike = Partial<Record<'red' | 'green' | 'yellow' | 'cyan', ChalkColorFn>>;

const chalkModule = chalk as unknown as ChalkLike & { default?: ChalkLike };
const chalkApi: ChalkLike | null = typeof chalkModule.yellow === 'function'
    ? chalkModule
    : chalkModule.default || null;

export function colorize(color: 'red' | 'green' | 'yellow' | 'cyan', text: string): string {
    const fn = chalkApi?.[color];
    return typeof fn === 'function' ? fn(text) : text;
}

export type CliStartOptions = {
    resumeSessionId?: string;
    settingsOverride?: Record<string, any>;
    extraEnv?: Record<string, string>;
    /** Launch-planning result. Null explicitly suppresses unresolved array trust. */
    resolvedTrustPlan?: ResolvedTrustPlan | null;
    /**
     * WORKER-MCP: pre-generated runtime session id.
     *
     * startSession normally mints its own `key`, but a delegated worker launch
     * must write its MCP config — which carries a bind naming this session —
     * BEFORE the process spawns, and the config write happens in the caller.
     * Passing the id in is what lets both agree on one value; without it the
     * bind would name a session id that does not exist yet, and the exchange
     * would never resolve. Ignored (and a fresh uuid minted) when absent, so
     * every other caller is unaffected.
     */
    presetSessionKey?: string;
    /** BRAIN-ROUTING thinking axis: standard level ('low'|'medium'|'high') applied
     *  at launch via the provider's thinkingLaunchArgs (CLI) or setConfigOption
     *  ('thought_level', ACP). Best-effort — ignored by providers with no support. */
    initialThinkingLevel?: string;
    /**
     * Phase E launch provenance: who launched the session and where the model /
     * thinking values came from. Absent → `api` launcher, `unspecified` sources.
     */
    launchProvenance?: LaunchProvenanceArgs & { launchedBy?: SessionLaunchedBy };
};

/**
 * Phase E: `launch_cli` provenance. An explicit, validated `launchedBy` wins;
 * otherwise mesh settings mean a mesh launch and anything else is an API caller.
 */
export function resolveLaunchProvenance(
    args: unknown,
    settings: Record<string, unknown> | undefined,
): LaunchProvenanceArgs & { launchedBy: SessionLaunchedBy } {
    const declared = readLaunchProvenanceArgs(args);
    return { ...declared, launchedBy: declared.launchedBy ?? inferLaunchedBy(settings) };
}

/**
 * Recent-activity / saved-session summary, derived from the launch record
 * rather than from the raw launch argument. It carries the REQUESTED model only:
 * a resume re-requests it, and a provider default must not turn into an
 * explicit pick on resume.
 */
function launchSummaryMetadata(record: SessionLaunchRecord) {
    return buildLegacyModelModeSummaryMetadata({ model: record.model.requested });
}

/**
 * `launch_cli` stage — delegated-worker launch preparation: re-resolve the
 * worker's auto-approve MODE on this (the worker's) machine, mint the worker
 * session id, build the isolation/trust/worker-MCP launch options, and stamp
 * the worker-MCP delivery status. Every field is empty/null for an ordinary
 * (non-delegated) launch.
 */
function prepareDelegatedLaunch(
    host: CliLaunchHost,
    args: any,
    cliType: string,
    dir: string,
    providerType: string,
    provLookup: ProviderModule | undefined,
) {
    let settingsOverride: Record<string, any> | undefined = args?.settings && typeof args.settings === 'object' ? args.settings : undefined;
    // REMOTE-NODE-AUTO-APPROVE-MODE-DELIVERY: the coordinator picks the
    // delegated-worker auto-approve MODE from `.adhdev/mesh.json`, but it reads
    // `node.workspace` on ITS OWN filesystem — impossible for a remote node, so a
    // repo-requested mode was silently replaced by the provider spec default. This
    // daemon IS the worker machine and `dir` is the real checkout, so re-resolve
    // the MODE here. ENABLE and the DANGEROUS opt-in stay coordinator-owned; a
    // workspace with no readable repo config keeps the coordinator's value.
    if (settingsOverride?.launchedByCoordinator === true) {
        const envelopeMode = typeof settingsOverride.autoApproveMode === 'string'
            ? settingsOverride.autoApproveMode
            : undefined;
        const modeResolution = resolveDelegatedWorkerAutoApproveModeForLaunch({
            workspace: dir,
            providerType,
            provider: provLookup,
            settings: settingsOverride,
        });
        logDelegatedWorkerModeDelivery(modeResolution, {
            workspace: dir,
            providerType,
            meshNodeId: typeof settingsOverride.meshNodeId === 'string' ? settingsOverride.meshNodeId : undefined,
            envelopeMode,
        });
        if (modeResolution.changed && modeResolution.autoApproveMode) {
            // Mirror delegatedWorkerAutoApproveSettings' opposite-key clearing so the
            // mode cannot be bypassed by a stale global boolean.
            settingsOverride = {
                ...settingsOverride,
                autoApproveMode: modeResolution.autoApproveMode,
                autoApprove: undefined,
            };
        }
    }
    // WORKER-MCP (design §12.1a): the runtime session id is minted HERE
    // rather than inside startSession, because the worker's MCP config —
    // written just below — carries a bind that names this session, and the
    // config must exist before the CLI process reads it. Passing the id
    // down via presetSessionKey is what keeps the bind and the live session
    // agreeing on one value. Only for a delegated launch; every other path
    // keeps startSession's own uuid.
    const delegatedSessionKey = settingsOverride?.launchedByCoordinator === true
        ? crypto.randomUUID()
        : undefined;
    const delegatedMeshId = typeof settingsOverride?.meshNodeFor === 'string'
        ? settingsOverride.meshNodeFor.trim()
        : '';
    const delegatedLaunch = settingsOverride?.launchedByCoordinator === true
        ? buildCoordinatorDelegatedCliLaunchOptions({
            cliType,
            workspace: dir,
            cliArgs: args?.cliArgs,
            env: args?.env,
            isolation: provLookup?.meshCoordinator?.delegatedWorkerIsolation,
            // ★ISOLATION-OBSERVABILITY: the bundle version THIS DAEMON
            // holds in memory (provLookup is the live map entry) — the
            // value that diverges from the channel pointer after an
            // out-of-process activation.
            providerVersion: provLookup?.providerVersion,
            // WORKER-MCP: the declared config path is what lets the
            // daemon write a worker config for the 6 providers that
            // declare no isolation rules of their own.
            mcpConfig: provLookup?.meshCoordinator?.mcpConfig,
            // `provLookup` comes from getMeta(), which returns the
            // raw map entry — and `_resolvedSpecPath` is only ever
            // set on resolve()'s deep CLONE, so reading the hidden
            // field off it yielded undefined for every provider.
            // That silently disabled pre_launch_trust on the worker
            // path (no trust plan → no ledgered grant → agy stalled
            // on its folder-trust prompt in every fresh worktree).
            resolvedSpecPath: host.providerLoader.getResolvedSpecPath(providerType) ?? undefined,
            // The runtime session id is the stable launch identity:
            // two workers on one workspace therefore receive distinct
            // private HOMEs and distinct provenance usage records.
            sessionKey: delegatedSessionKey || dir,
            trustContext: {
                ...(delegatedMeshId ? { meshId: delegatedMeshId } : {}),
                ...(typeof settingsOverride?.meshNodeId === 'string' && settingsOverride.meshNodeId.trim()
                    ? { nodeId: settingsOverride.meshNodeId.trim() } : {}),
                ...(typeof settingsOverride?.autoLaunchedForQueueTaskId === 'string'
                    && settingsOverride.autoLaunchedForQueueTaskId.trim()
                    ? { taskId: settingsOverride.autoLaunchedForQueueTaskId.trim() } : {}),
            },
            // Present ⇒ the worker gets a reporting surface (Phase B).
            // Absent (a delegated launch with no mesh context) ⇒ the
            // Phase A shape: isolation only, no worker server.
            ...(delegatedMeshId && delegatedSessionKey
                ? {
                    bindContext: {
                        meshId: delegatedMeshId,
                        sessionId: delegatedSessionKey,
                        ...(typeof settingsOverride?.meshNodeId === 'string' && settingsOverride.meshNodeId.trim()
                            ? { nodeId: settingsOverride.meshNodeId.trim() }
                            : {}),
                        ...(typeof settingsOverride?.autoLaunchedForQueueTaskId === 'string'
                            && settingsOverride.autoLaunchedForQueueTaskId.trim()
                            ? { spawnedForTaskId: settingsOverride.autoLaunchedForQueueTaskId.trim() }
                            : {}),
                    },
                }
                : {}),
        })
        : null;
    // ★WORKER-MCP DELIVERY VISIBILITY: classify what the isolation gate above
    // actually produced into the coordinator-visible {delivered, reason?} shape
    // (see worker-mcp-isolation.ts doc). `hadBindContext` mirrors the exact
    // condition used to build `bindContext` above — a delegated launch with no
    // mesh identity was never going to deliver a worker server, so that reads
    // as `not_applicable`, not a failure. Stamped into `settingsOverride` so it
    // rides into session meta the same way every other launch-settings field
    // does (`launchSettings` below), which is what `summarizeMeshSessionRecord`
    // reads for mesh_status / mesh_list_nodes; also returned from this call so
    // the dispatch/claim response that triggered this launch sees it immediately.
    const workerMcpDelivery: WorkerMcpDeliveryStatus | undefined = delegatedMeshId
        ? deriveWorkerMcpDeliveryStatus(delegatedLaunch?.workerIsolation ?? null, Boolean(delegatedMeshId && delegatedSessionKey))
        : undefined;
    if (workerMcpDelivery && settingsOverride) {
        settingsOverride = {
            ...settingsOverride,
            workerMcpDelivered: workerMcpDelivery.delivered,
            ...(workerMcpDelivery.reason ? { workerMcpDeliveryReason: workerMcpDelivery.reason } : {}),
        };
    }
    if (workerMcpDelivery && !workerMcpDelivery.delivered && workerMcpDelivery.reason !== 'not_applicable') {
        LOG.warn('WorkerMcp', `[${cliType}] worker MCP not delivered for this launch (${workerMcpDelivery.reason}) — see WorkerMcp notes above for detail`);
    }
    // ★ISOLATION-OBSERVABILITY: stamp the resolved bundle version on
    // every delegated-launch diagnostic, so a stale in-memory provider
    // is legible from the log line itself.
    const delegatedProviderLabel = provLookup?.providerVersion
        ? `${cliType}@${provLookup.providerVersion}`
        : `${cliType}@unknown-version`;
    // Logged independently of the worker-MCP gate: this note describes
    // the provider's DECLARATION, which exists (or not) regardless of
    // the gate. Routing it through workerIsolation.notes would drop it
    // whenever the gate is off — the very case it explains.
    if (delegatedLaunch?.isolationNotes?.length) {
        LOG.info('WorkerIsolation', `[${delegatedProviderLabel}] ${delegatedLaunch.isolationNotes.join('; ')}`);
    }
    if (delegatedLaunch?.workerIsolation?.notes.length) {
        LOG.info('WorkerMcp', `[${delegatedProviderLabel}] ${delegatedLaunch.workerIsolation.notes.join('; ')}`);
    }
    // Trust-axis notes only appear separately when the worker-MCP
    // gate is off; with it on they are already inside the notes
    // logged just above, so this never double-reports.
    if (delegatedLaunch?.trustNotes?.length) {
        LOG.info('WorkerTrust', `[${cliType}] ${delegatedLaunch.trustNotes.join('; ')}`);
    }
    return { settingsOverride, delegatedSessionKey, delegatedMeshId, delegatedLaunch, workerMcpDelivery };
}

/**
 * LAUNCH-ACCOUNTING funnel: every mesh WORKER spawn — mesh_launch_session,
 * queue auto-launch (local AND remote: the remote leg forwards launch_cli to
 * this daemon), and the recovery relaunch — passes through this case with
 * `meshNodeFor` stamped, so the audit `session_launched` entry is written
 * HERE, on the daemon that actually spawned the session. Before this, only
 * the mesh_launch_session MCP tool recorded one (the 2026-09-08 runaway
 * spawned 60 sessions that were invisible to the ledger). Coordinator
 * sessions stamp `meshCoordinatorFor`, not `meshNodeFor`, and stay excluded.
 * `ledgerLaunchRecorded` in the result tells a caller that also records
 * launches (mcp-server mesh_launch_session) to skip its own append.
 */
function recordDelegatedLaunch(
    delegatedMeshId: string,
    settingsOverride: Record<string, any> | undefined,
    providerType: string,
    started: { runtimeSessionId: string; providerSessionId?: string },
): boolean {
    try {
        const autoLaunchTaskId = typeof settingsOverride?.autoLaunchedForQueueTaskId === 'string'
            ? settingsOverride.autoLaunchedForQueueTaskId.trim() : '';
        // NB: distinct from this case's `launchSource` local (workspace-resolution
        // origin) — `meshLaunchSource` is the mesh-envelope path discriminator.
        const declaredSource = typeof settingsOverride?.meshLaunchSource === 'string'
            ? settingsOverride.meshLaunchSource.trim() : '';
        const meshNodeId = typeof settingsOverride?.meshNodeId === 'string'
            ? settingsOverride.meshNodeId.trim() : '';
        meshRecord(delegatedMeshId, 'session_launched', {
            ...(meshNodeId ? { nodeId: meshNodeId } : {}),
            sessionId: started.runtimeSessionId,
            providerType,
            ...(autoLaunchTaskId ? { taskId: autoLaunchTaskId } : {}),
            payload: {
                ...(started.providerSessionId ? { providerSessionId: started.providerSessionId } : {}),
                // Path discriminator: explicit launchSource from the initiator wins;
                // the queue auto-launch is derived from its task marker (its envelope
                // predates launchSource and lives in a line-frozen file); anything
                // else (legacy caller / version skew) is labeled as such.
                source: declaredSource || (autoLaunchTaskId ? 'auto_launch' : 'unlabeled_delegated_launch'),
            },
        }, { local: true });
        return true;
    } catch { /* accounting is best-effort — never fail the launch */ }
    return false;
}
