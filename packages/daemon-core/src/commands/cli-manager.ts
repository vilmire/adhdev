/**
 * DaemonCliManager — CLI session creation, management, and command handling
 *
 * Separated from adhdev-daemon.ts. Launch (startSession / launch_cli) lives in
 * cli-manager-launch.ts, hosted-runtime restore in cli-manager-restore.ts and
 * the agent_command command in cli-manager-agent-command.ts; each takes the
 * manager through a compiler-checked Pick<DaemonCliManager, …> host view.
 */

import { createCliAdapter } from '../providers/spec/route.js';
import type { LaunchableProviderCategory } from '../providers/contracts.js';
import type { CliProviderModule } from '../cli-adapters/provider-cli-shared.js';
import { loadConfig } from '../config/config.js';
import { loadState, saveState } from '../config/state-store.js';
import { getWorkspaceState, resolveLaunchDirectory } from '../config/workspaces.js';
import { appendRecentActivity } from '../config/recent-activity.js';
import { upsertSavedProviderSession } from '../config/saved-sessions.js';
import { normalizeProviderSummaryMetadata } from '../providers/summary-metadata.js';
import { CliProviderInstance } from '../providers/cli-provider-instance.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import { drainInFlightSubmits, type SubmitDrainResult } from './cli-manager-submit-drain.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import type { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';
import { type AgentCommandArgs } from './command-args.js';
import { createSessionInputService, type SessionInputService, type SessionInputTarget } from '../sessions/session-input-service.js';
import { buildSessionInputTarget, type SessionInputAdapterLike, type SessionInputInstanceLike } from '../sessions/session-input-target.js';
import {
    type SessionLaunchRecord,
} from '../sessions/launch-record.js';
import {
    type ResolvedTrustPlan,
} from '../providers/trust-provenance-ledger.js';
import { resolveHostedSpawnedAtMs } from './cli-delegated-launch.js';

import {
    normalizeDirForCompare,
} from './cli-manager-agent-status.js';
import {
    type CliLaunchMode,
} from './cli-session-binding.js';
import { startSession, launchCli } from './cli-manager-launch.js';
import { restoreHostedSessions } from './cli-manager-restore.js';
import { agentCommand } from './cli-manager-agent-command.js';
import { colorize, resolveLaunchProvenance, type CommandResult, type CliStartOptions } from './cli-manager-launch.js';

export interface CliManagerDeps {
 /** P2P — PTY output transmit */
    getP2p(): { broadcastSessionOutput(key: string, data: string): void } | null;
 /** InstanceManager — register in CLI unified status */
    getInstanceManager(): ProviderInstanceManager | null;
    getSessionRegistry?(): SessionRegistry | null;
    createPtyTransportFactory?: (params: CliTransportFactoryParams) => PtyTransportFactory | null;
    listHostedCliRuntimes?: () => Promise<HostedCliRuntimeDescriptor[]>;
    hostedRuntimeManagerTag?: string;
}

export interface CliTransportFactoryParams {
    runtimeId: string;
    providerType: string;
    workspace: string;
    cliArgs?: string[];
    providerSessionId?: string;
    attachExisting?: boolean;
    /**
     * Launch-time record meta (meshNodeId / meshNodeFor / launchedByCoordinator /
     * autoLaunchedForQueueTaskId). Defense-in-depth for SESSION-ACCUMULATION-LEAK:
     * a session-host factory impl SHOULD seed the create_session record with this
     * so the node binding is present the instant the record exists, rather than
     * relying solely on the post-spawn updateRuntimeMeta round-trip. Optional and
     * additive — factory impls that ignore it keep the prior behavior; the
     * post-spawn WTDISPATCH stamp in register() still runs as the primary path.
     */
    initialMeta?: Record<string, unknown>;
}

export interface HostedCliRuntimeDescriptor {
    runtimeId: string;
    runtimeKey?: string;
    displayName?: string;
    workspaceLabel?: string;
    lifecycle?: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'interrupted';
    recoveryState?: string | null;
    cliType: string;
    workspace: string;
    cliArgs?: string[];
    providerSessionId?: string;
    managedBy?: string;
    /**
     * Real spawn time (ms epoch) of the underlying session-host runtime — a PAST
     * timestamp recorded when the runtime first started. Threaded through so an
     * attach can restore the native-history session-floor to the runtime's actual
     * birth instead of collapsing spawnedAtMs to 0. Undefined when unrecoverable
     * (genuine post-restart-unknown), in which case the caller keeps the 0 fallback.
     */
    startedAtMs?: number;
    /**
     * Session-level MESH MEMBERSHIP persisted in the session-host record meta at
     * launch/dispatch time (meshNodeFor / meshNodeId / launchedByCoordinator).
     * restoreHostedSessions re-applies these to the rebuilt instance settings so a
     * rebound LOCAL mesh worker keeps its relay/routing envelope across a daemon
     * restart (rc.20): without them the worker's completion/choice events fail
     * resolveWorkerDelegateRouting (no_worker_envelope), detach does a full clear
     * (launchedByCoordinator falsy), and mesh_read_terminal / mesh_send_keys refuse
     * the session as non-worker. TASK-level markers (meshActiveTaskId / attemptId /
     * dispatchNonce) are deliberately NOT carried here — the owner re-resolves
     * the session's task from its own queue row and ledger.
     */
    meshNodeFor?: string;
    meshNodeId?: string;
    /**
     * The daemon that owns this worker's mesh work (`settings.meshCoordinatorDaemonId`),
     * persisted at launch and at every dispatch. Restored with the membership so a
     * worker whose task another daemon owns can still forward `report_completion`
     * after a restart of ITS daemon (live 2026-10-08, rc.1: refused "the bind is
     * live, but its session holds no assigned task here"). An identifier, not a
     * task marker — the owner re-resolves the task and checks the relaying daemon.
     */
    meshCoordinatorDaemonId?: string;
    /**
     * The attempt ref this session's turn evidence was carrying
     * (`cli-provider-mesh-assignment.ts` PERSISTED_ATTEMPT_REF_META_KEY), restored
     * with the membership + owner so a turn that spans a restart of THIS daemon
     * still reaches the owner's ledger. A pointer only — the owner checks it.
     */
    meshActiveAttemptRef?: { attemptId: string; generation: number };
    launchedByCoordinator?: boolean;
    /** The session's launch-time auto-approve mode id, re-applied on restore. */
    autoApproveMode?: string;
    /**
     * Launch provenance persisted in the session-host record meta at spawn
     * (`meta.launchRecord`, Phase E). Raw — validated by
     * `buildRestoredLaunchRecord` when the runtime is re-attached.
     */
    launchRecord?: unknown;
}

type CliAdapterWithExtraArgs = CliAdapter & {
    extraArgs?: string[];
};

/** Grace between a session reporting stopped/error and its reclamation — long
 *  enough for the final status/mesh events to flush, see scheduleAutoClean. */
const AUTO_CLEAN_DELAY_MS = 5_000;

// ─── DaemonCliManager ────────────────────────────

export class DaemonCliManager {
    readonly adapters = new Map<string, CliAdapter>();
    deps: CliManagerDeps;
    providerLoader: ProviderLoader;
    /**
     * The ONE send funnel (wiring-unification D2): every input into a session
     * this manager hosts — mesh `agent_command`, dashboard `send_chat` (via the
     * command context), turn-ledger notices — is `input.submit(OutboundMessage)`,
     * sharing one `messageId` dedupe.
     */
    readonly input: SessionInputService;

    constructor(deps: CliManagerDeps, providerLoader: ProviderLoader) {
        this.deps = deps;
        this.providerLoader = providerLoader;
        this.input = createSessionInputService({
            resolveSession: (sessionId) => this.resolveSessionInputTarget(sessionId),
            log: (level, msg) => {
                if (level === 'debug') LOG.debug('SessionInput', msg);
                else if (level === 'info') LOG.info('SessionInput', msg);
                else if (level === 'warn') LOG.warn('SessionInput', msg);
                else LOG.error('SessionInput', msg);
            },
        });
    }

    /** `SessionInputService` resolver: the adapter/instance pair under one session key. */
    resolveSessionInputTarget(sessionId: string): SessionInputTarget | null {
        const adapter = this.adapters.get(sessionId) ?? null;
        const instance = this.deps.getInstanceManager()?.getInstance(sessionId) ?? null;
        if (!adapter && !instance) return null;
        const providerType = adapter?.cliType || (instance as { type?: string } | null)?.type;
        const provider = providerType ? (this.providerLoader.resolve(providerType) || this.providerLoader.getMeta(providerType)) : null;
        return buildSessionInputTarget({
            adapter: adapter as unknown as SessionInputAdapterLike | null,
            instance: instance as unknown as SessionInputInstanceLike | null,
            provider,
        });
    }

    /** The provider loader's resolved channel, when it exposes one (test doubles may not). */
    readProviderChannel(): string | undefined {
        const channel = (this.providerLoader as { channel?: unknown }).channel;
        return typeof channel === 'string' ? channel : undefined;
    }

    persistRecentActivity(entry: {
        kind: LaunchableProviderCategory;
        providerType: string;
        providerName: string;
        providerSessionId?: string;
        workspace?: string;
        summaryMetadata?: unknown;
        sessionId?: string;
        title?: string;
    }): void {
        try {
            const summaryMetadata = normalizeProviderSummaryMetadata(entry.summaryMetadata as any);
            let nextState = appendRecentActivity(loadState(), {
                ...entry,
                summaryMetadata,
            });
            if (entry.providerSessionId && (entry.kind === 'cli')) {
                nextState = upsertSavedProviderSession(nextState, {
                    kind: entry.kind,
                    providerType: entry.providerType,
                    providerName: entry.providerName,
                    providerSessionId: entry.providerSessionId,
                    workspace: entry.workspace,
                    summaryMetadata,
                    title: entry.title,
                });
            }
            saveState(nextState);
        } catch (e) {
            console.error(colorize('red', `  ✗ Failed to save recent activity: ${e}`));
        }
    }

    private getTransportFactory(
        runtimeId: string,
        providerType: string,
        workspace: string,
        cliArgs?: string[],
        providerSessionId?: string,
        attachExisting = false,
        initialMeta?: Record<string, unknown>,
    ): PtyTransportFactory | undefined {
        return this.deps.createPtyTransportFactory?.({
            runtimeId,
            providerType,
            workspace,
            cliArgs,
            providerSessionId,
            attachExisting,
            ...(initialMeta && Object.keys(initialMeta).length ? { initialMeta } : {}),
        }) || undefined;
    }

    createAdapter(
        cliType: string,
        workingDir: string,
        cliArgs: string[] | undefined,
        runtimeId: string,
        providerSessionId?: string,
        attachExisting = false,
        extraEnv?: Record<string, string>,
        /** PERMISSION-MODE-DUPLICATE: see registerCliInstance's option of the same name. */
        removeSpawnArgs?: string[],
        resolvedTrustPlan?: ResolvedTrustPlan | null,
    ): CliAdapter {
 // cliType normalize (Resolve alias)
        const normalizedType = this.providerLoader.resolveAlias(cliType);

 // Load CLI config from provider.js
        const provider = this.providerLoader.getMeta(normalizedType);
        if (provider && provider.category === 'cli' && provider.patterns && provider.spawn) {
            console.log(colorize('cyan', `  📦 Using provider: ${provider.name} (${provider.type})`));
            const resolvedProvider = this.providerLoader.resolve(normalizedType) || provider;
            const transportFactory = this.getTransportFactory(
                runtimeId,
                normalizedType,
                workingDir,
                cliArgs,
                providerSessionId,
                attachExisting,
            );
            const adapter = createCliAdapter(resolvedProvider as CliProviderModule, workingDir, cliArgs || [], extraEnv || {}, transportFactory, undefined, removeSpawnArgs, resolvedTrustPlan);
            if (providerSessionId) adapter.updateRuntimeMeta?.({ providerSessionId });
            return adapter;
        }

        throw new Error(`No CLI provider found for '${cliType}'. Create a provider.js in providers/cli/${cliType}/`);
    }

    /**
     * AUTO-CLEAN — the ONE place a session that reports `stopped` or `error` is
     * reclaimed. It used to exist twice (exit monitor: 5s, full teardown,
     * `adapters.has(key)`; InstanceManager-less fallback: 3s, partial teardown,
     * identity check), which is how the two drifted.
     *
     * SEMANTICS, stated once because a wrong belief about them caused the
     * 2026-09-21 coordinator kill loop: for the daemon, `error` IS TERMINAL.
     * A session reporting it is reclaimed here within AUTO_CLEAN_DELAY_MS — it
     * does not linger and "become idle again". An adapter must therefore only
     * report `error` for a session it is prepared to lose (a dead process, or a
     * provider failure that makes the session useless), never as a soft health
     * hint about a live, working session. Soft hints go through the
     * provider-signal seam (see providers/spec/live-auth-advisory.ts).
     *
     * The IDENTITY check is load-bearing: a session relaunched under the same key
     * inside the delay window must not be reclaimed by its predecessor's timer
     * (the old `has(key)` form would have removed the new session).
     */
    scheduleAutoClean(key: string, adapter: CliAdapter, terminalStatus: string): void {
        setTimeout(() => {
            if (this.adapters.get(key) !== adapter) return;
            const instanceManager = this.deps.getInstanceManager();
            this.adapters.delete(key);
            this.deps.getSessionRegistry?.()?.terminateByInstanceKey(key, 'auto_clean');
            instanceManager?.removeInstance(key);
            LOG.info('CLI', `🧹 Auto-cleaned ${terminalStatus} CLI: ${adapter.cliType} (session=${key})`);
        }, AUTO_CLEAN_DELAY_MS);
    }

    private startCliExitMonitor(key: string): void {
        const checkStopped = setInterval(() => {
            try {
                const adapter = this.adapters.get(key);
                if (!adapter) { clearInterval(checkStopped); return; }
                const status = adapter.getStatus?.();
                if (status?.status === 'stopped' || status?.status === 'error') {
                    clearInterval(checkStopped);
                    this.scheduleAutoClean(key, adapter, status.status);
                }
            } catch { /* ignore */ }
        }, 3000);
    }

    async registerCliInstance(
        key: string,
        normalizedType: string,
        cliType: string,
        resolvedDir: string,
        cliArgs: string[] | undefined,
        provider: any,
        settings: Record<string, any>,
        attachExisting = false,
        options?: {
            providerSessionId?: string;
            launchMode?: CliLaunchMode;
            extraEnv?: Record<string, string>;
            resolvedTrustPlan?: ResolvedTrustPlan | null;
            /** BRAIN-ROUTING: post-launch thinking level for runtime-control providers
             *  (e.g. hermes reasoning). Passed through to the instance. */
            initialThinkingLevel?: string;
            /** PERMISSION-MODE-DUPLICATE: the selected auto-approve mode's removeArgs,
             *  threaded to the instance so the SPEC's spawn_args are filtered too — the
             *  manifest filtering in applyAutoApproveModeLaunchArgs does not reach them. */
            removeSpawnArgs?: string[];
            /**
             * On an attach (attachExisting=true), the real spawn time (ms epoch) of the
             * session-host runtime being restored — a PAST timestamp. Used to restore the
             * native-history session-floor to the runtime's actual birth instead of 0.
             * See the spawnedAtMs computation below. Ignored for fresh launches.
             */
            attachStartedAtMs?: number;
            /**
             * Phase E: the session's launch record. A fresh launch also seeds it
             * into the session-host record meta (`meta.launchRecord`) so a later
             * restore can recover the provenance; an attach passes the restored
             * record (`launchedBy: 'restore'`) and leaves the stored meta alone.
             */
            launchRecord?: SessionLaunchRecord;
            onProviderSessionResolved?: (info: {
                instanceId: string;
                providerType: string;
                providerName: string;
                workspace: string;
                providerSessionId: string;
                previousProviderSessionId?: string;
            }) => void;
        },
    ): Promise<void> {
        const instanceManager = this.deps.getInstanceManager();
        const sessionRegistry = this.deps.getSessionRegistry?.() || null;
        if (!instanceManager) throw new Error('InstanceManager not available');

        // Launch-time record meta (mesh node binding) — computed BEFORE the
        // transport factory so the session-host record can be seeded with the
        // binding at create_session time (Fix ②, defense-in-depth for
        // SESSION-ACCUMULATION-LEAK), not only via the post-spawn WTDISPATCH
        // updateRuntimeMeta round-trip below. See CliTransportFactoryParams.initialMeta.
        const launchMeshNodeId = typeof settings?.meshNodeId === 'string' ? settings.meshNodeId.trim() : '';
        const launchMeshNodeFor = typeof settings?.meshNodeFor === 'string' ? settings.meshNodeFor.trim() : '';
        const launchMeshCoordinatorDaemonId = typeof settings?.meshCoordinatorDaemonId === 'string' ? settings.meshCoordinatorDaemonId.trim() : '';
        const launchAutoLaunchedForQueueTaskId = typeof settings?.autoLaunchedForQueueTaskId === 'string'
            ? settings.autoLaunchedForQueueTaskId.trim()
            : '';
        const launchRecordMeta: Record<string, unknown> = {
            ...(launchMeshNodeId ? { meshNodeId: launchMeshNodeId } : {}),
            ...(launchMeshNodeFor ? { meshNodeFor: launchMeshNodeFor } : {}),
            // The daemon that owns this worker's mesh work (see the descriptor field).
            ...(launchMeshNodeFor && launchMeshCoordinatorDaemonId ? { meshCoordinatorDaemonId: launchMeshCoordinatorDaemonId } : {}),
            ...(settings?.launchedByCoordinator === true ? { launchedByCoordinator: true } : {}),
            ...(launchAutoLaunchedForQueueTaskId ? { autoLaunchedForQueueTaskId: launchAutoLaunchedForQueueTaskId } : {}),
            // The session's own approval mode (launch dialog / mesh policy). Restore
            // rebuilt settings from provider defaults only, so a restarted
            // coordinator came back with auto-approve off and asked for every
            // command (2026-10-02).
            ...(typeof settings?.autoApproveMode === 'string' && settings.autoApproveMode.trim()
                ? { autoApproveMode: settings.autoApproveMode.trim() } : {}),
            // Phase E: persisted so a hosted runtime re-attached after a daemon
            // restart keeps its model provenance (read back by listHostedCliRuntimes).
            ...(!attachExisting && options?.launchRecord ? { launchRecord: options.launchRecord } : {}),
        };

        const transportFactory = this.getTransportFactory(
            key,
            normalizedType,
            resolvedDir,
            cliArgs,
            options?.providerSessionId,
            attachExisting,
            // Only seed at create time for fresh launches — an attach restores an
            // existing record whose meta is already stamped; re-seeding could clobber.
            attachExisting ? undefined : launchRecordMeta,
        );
        const cliInstance = new CliProviderInstance(provider, resolvedDir, cliArgs, key, transportFactory, options);
        try {
            await instanceManager.addInstance(key, cliInstance, {
                settings,
                onPtyData: (data: string) => {
                    this.deps.getP2p()?.broadcastSessionOutput(cliInstance.instanceId, data);
                },
            });
            sessionRegistry?.register({
                sessionId: cliInstance.instanceId,
                parentSessionId: null,
                providerType: normalizedType,
                transport: 'pty',
                adapterKey: key,
                instanceKey: key,
                workspace: resolvedDir,
                // attachExisting === true means we're restoring an already-spawned
                // hosted runtime after a daemon restart, not starting a fresh PTY.
                //
                // NEVER use Date.now() for the attach case: the real spawn time is in
                // the PAST, and pinning the floor to now would push the native-history
                // session-floor cutoff past every existing transcript file, so the
                // agy/hermes/claude reader would return null even though the transcript
                // on disk is fresh (the ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP regression).
                //
                // But collapsing to 0 for EVERY attach is also wrong: with the mesh
                // coordinator + workers all running as hosted runtimes sharing one
                // workspace and attached with attachExisting=true, spawnedAtMs=0 disables
                // the per-session native-history birth-floor for all of them. Without a
                // floor, resolveAntigravityPath takes the floor-less newest-by-mtime
                // branch (ownerConfirmed:false) and a replica's read can claim the
                // coordinator's OWN conversation, which then reads as claimedByOther —
                // regressing the coordinator chat to the pty-parser (user-only) path.
                //
                // So when the session-host record's REAL startedAt (a PAST timestamp) is
                // recoverable, use it: the floor lands at the runtime's actual birth, the
                // transcript is still found, AND each session's floor isolates its own
                // conversation. Fall back to 0 ONLY when startedAt is unrecoverable (the
                // genuine post-restart-unknown case) — that preserves the tail-gap
                // protection. Fresh launches still get Date.now() so prior-session leak
                // protection holds.
                spawnedAtMs: resolveHostedSpawnedAtMs(attachExisting, options?.attachStartedAtMs, Date.now()),
            }, attachExisting ? 'restore' : 'launch');
        } catch (spawnErr: any) {
            LOG.error('CLI', `[${cliType}] Spawn failed: ${spawnErr?.message}`);
            instanceManager.removeInstance(key);
            throw new Error(`Failed to start ${provider.displayName || provider.name || cliType}: ${spawnErr?.message}`);
        }

        this.adapters.set(key, cliInstance.getAdapter());

        // Phase E: the launch record, right after register(). Outside the spawn
        // try on purpose — provenance bookkeeping must never turn a successful
        // spawn into a reported failure.
        if (options?.launchRecord) {
            sessionRegistry?.setLaunchRecord?.(
                cliInstance.instanceId,
                { ...options.launchRecord, sessionId: cliInstance.instanceId },
                attachExisting ? 'restore' : 'launch',
            );
        }

        // WTDISPATCH (no_node_binding): a coordinator-launched worker carries its mesh node
        // binding on the CLI-instance settings, but the session-host RECORD meta was never
        // stamped with it — `updateRuntimeSettings` only mutates in-memory runtime settings and
        // `updateRuntimeMeta` was only ever called with providerSessionId. So mesh_cleanup_sessions
        // matched these worker sessions to a node by workspace ALONE
        // (`live_session_matched_by_workspace_only_no_node_binding`), which on a daemon hosting
        // sibling worktree nodes cannot tell two co-located clones apart. Push the launch-time node
        // binding to the record meta so the record is 1:1 bound to its node (the spawned pty exists
        // by now, so updateMeta reaches the session-host store). Best-effort; guarded.
        //
        // With the spec-CLI updateRuntimeMeta fix (SpecCliAdapter now forwards the FULL
        // meta down to the transport, not just providerSessionId), this stamp finally
        // reaches the session-host record for spec-backed providers too — previously it
        // was silently dropped, which is what let orphans accumulate. launchRecordMeta
        // is hoisted above and also seeds the create_session record via initialMeta.
        if (Object.keys(launchRecordMeta).length) {
            try {
                cliInstance.getAdapter().updateRuntimeMeta?.({ ...launchRecordMeta });
            } catch { /* best-effort — record-meta stamp is cleanup hygiene, not on the dispatch path */ }
        }

        this.startCliExitMonitor(key);
    }
    startSession(cliType: string, workingDir: string, cliArgs?: string[], initialModel?: string, options?: CliStartOptions): Promise<{ runtimeSessionId: string; providerSessionId?: string }> { return startSession(this, cliType, workingDir, cliArgs, initialModel, options); }

    async stopSession(key: string): Promise<void> {
        return this.stopSessionWithMode(key, 'hard');
    }

    async stopSessionWithMode(key: string, mode: 'hard' | 'save'): Promise<void> {
        const adapter = this.adapters.get(key);
        if (adapter) {
            try {
                if (mode === 'save' && typeof adapter.saveAndStop === 'function') {
                    await adapter.saveAndStop();
                } else {
                    adapter.shutdown();
                }
            } catch (e: any) {
                LOG.warn('CLI', `Shutdown error for ${adapter.cliType}: ${e?.message} (force-cleaning)`);
            }
            // Always cleanup regardless of shutdown success
            this.adapters.delete(key);
            this.deps.getSessionRegistry?.()?.terminateByInstanceKey(key, 'stop_requested');
            this.deps.getInstanceManager()?.removeInstance(key);
            LOG.info('CLI', `🛑 Agent stopped: ${adapter.cliType} in ${adapter.workingDir}`);
        } else {
            // Adapter not found — try InstanceManager direct removal
            const im = this.deps.getInstanceManager();
            if (im) {
                this.deps.getSessionRegistry?.()?.terminateByInstanceKey(key, 'stop_requested');
                im.removeInstance(key);
                LOG.warn('CLI', `🧹 Force-removed orphan entry: ${key}`);
            }
        }
    }

    /** ENTER-LOSS layer ① — shutdown drain gate for in-flight submits (the
     *  2026-09-10 stranded-composer incident). Awaited by
     *  shutdownDaemonComponents BEFORE detachAll(); immediate no-op when nothing
     *  is in flight. Rationale + limitation: ./cli-manager-submit-drain.ts. */
    drainInFlightSubmits(timeoutMs: number): Promise<SubmitDrainResult> {
        return drainInFlightSubmits(this.adapters, timeoutMs);
    }

    detachAll(): void {
        for (const adapter of this.adapters.values()) {
            if (typeof adapter.detach === 'function') adapter.detach();
            else adapter.shutdown();
        }
        this.adapters.clear();
    }
    restoreHostedSessions(records?: HostedCliRuntimeDescriptor[]): Promise<number> { return restoreHostedSessions(this, records); }

 // ─── Adapter search ─────────────────────────────

 /**
 * Search for CLI adapter. Priority order:
 * 0. sessionId (UUID direct match)
 * 1. agentType + dir (iteration match)
 * 2. agentType fuzzy match (⚠ returns first match when multiple sessions exist)
 */
    findAdapter(agentType: string, opts?: { dir?: string; instanceKey?: string }): { adapter: CliAdapter; key: string } | null {
 // 0. UUID direct match (most accurate)
        const direct = this.findAdapterBySessionId(opts?.instanceKey);
        if (direct) return direct;
 // 1. agentType + dir match.
 //    FAIL-CLOSED when an explicit instanceKey/targetSessionId was named (step 0) but
 //    did not resolve: the caller pinned a SPECIFIC session, so healing by workspace must
 //    not silently redirect the command into a co-located SIBLING worktree session. The
 //    remote mesh relay (ipcDispatchToRemoteAgent) carries `dir: node.workspace` alongside
 //    targetSessionId for the sessionless-scope case; when a session WAS named, that dir
 //    fallback is the WTDISPATCH-FANOUT (a) leak — a stale/relaunched session_id would
 //    dir-match whatever session lives in that workspace instead of failing. The sessionless
 //    node-scoped path uses findMeshNodeAdapter, not this fallback, so gating dir on
 //    !instanceKey loses no legitimate routing. Mirror step 2's fail-closed rule.
        if (opts?.dir && !opts?.instanceKey) {
            for (const [k, a] of this.adapters) {
                if (a.cliType === agentType && a.workingDir === opts.dir) {
                    return { adapter: a, key: k };
                }
            }
        }
 // 2. Fuzzy match (returns first of multiple sessions — may be inaccurate).
 //    FAIL-CLOSED: only when NO explicit instanceKey/targetSessionId was requested.
 //    When a specific session WAS named (step 0) but is not hosted on this daemon,
 //    falling back to the first same-cliType adapter silently redirects the command
 //    into an UNRELATED session — e.g. a relayed/misrouted mesh send_chat lands in the
 //    coordinator's own CLI session, echoing the dispatched task body back to the
 //    coordinator (TASKECHO self-inject). Returning null instead makes the caller
 //    surface an explicit "not running" error rather than mis-delivering the message.
        if (!opts?.instanceKey) {
            for (const [k, a] of this.adapters) {
                if (a.cliType === agentType) {
                    return { adapter: a, key: k };
                }
            }
        }
        return null;
    }

    /** Exact session lookup. Strips a composite prefix: 'doId:cli:uuid' → 'uuid' or 'doId:uuid' → 'uuid'. */
    private findAdapterBySessionId(instanceKey?: string): { adapter: CliAdapter; key: string } | null {
        if (!instanceKey) return null;
        let ik = instanceKey;
        const colonIdx = ik.lastIndexOf(':');
        if (colonIdx >= 0) ik = ik.substring(colonIdx + 1);
        const adapter = this.adapters.get(ik);
        return adapter ? { adapter, key: ik } : null;
    }

    /**
     * WTCLAIM (B): resolve the adapter for a mesh dispatch that named a node
     * (meshContext.nodeId) but carried no explicit session. Matches by the
     * instance's bound mesh node id (settings.meshNodeId, falling back to the
     * sticky meshLastNodeId) first, then by the node workspace (workingDir).
     *
     * Unlike findAdapter's step-2 fuzzy fallback, this NEVER degrades to a
     * provider-only first-match: on a daemon hosting BOTH a base node and a
     * cloned worktree node (same daemonId), that fuzzy match could land a
     * worktree-targeted task on the base session. Returns null when no session
     * is bound to this node so the caller fails closed.
     */
    findMeshNodeAdapter(agentType: string, nodeId: string, dir?: string): { adapter: CliAdapter; key: string } | null {
        const instanceManager = this.deps.getInstanceManager();
        const targetDir = normalizeDirForCompare(dir);
        let workspaceMatch: { adapter: CliAdapter; key: string } | null = null;
        for (const [k, a] of this.adapters) {
            if (a.cliType !== agentType) continue;
            const settings = (instanceManager?.getInstance(k) as any)?.getState?.()?.settings as Record<string, unknown> | undefined;
            const boundNodeId = (typeof settings?.meshNodeId === 'string' && settings.meshNodeId.trim())
                ? settings.meshNodeId.trim()
                : (typeof settings?.meshLastNodeId === 'string' ? settings.meshLastNodeId.trim() : '');
            // Exact node binding wins immediately (most precise).
            if (boundNodeId && boundNodeId === nodeId) return { adapter: a, key: k };
            // Workspace identity is the secondary signal for a session not (yet)
            // stamped with a node id — a base node and a worktree clone always have
            // distinct workspaces, so this still separates them.
            if (!workspaceMatch && targetDir && normalizeDirForCompare(a.workingDir) === targetDir) {
                workspaceMatch = { adapter: a, key: k };
            }
        }
        return workspaceMatch;
    }
    launchCli(args: any): Promise<CommandResult> { return launchCli(this, args); }

    /** `stop_cli`: stop the addressed CLI session (hard or save mode). */
    async stopCli(args: any): Promise<CommandResult> {
        const cliType = args?.cliType;
        const dir = args?.dir || '';
        const mode = args?.mode === 'save' ? 'save' : 'hard';
        if (!cliType) throw new Error('cliType required');
 // UUID session target based search priority
        const found = this.findAdapter(cliType, { instanceKey: args?.targetSessionId, dir });
        if (found) {
 // If we got here via fuzzy match (no targetSessionId, no dir), check for ambiguity.
 // If multiple sessions of the same type exist, refuse to stop without a targetSessionId.
            if (!args?.targetSessionId && !dir) {
                const matchCount = [...this.adapters.values()].filter((a) => a.cliType === cliType).length;
                if (matchCount > 1) {
                    return {
                        success: false,
                        error: `Multiple ${cliType} sessions running — provide targetSessionId to stop a specific session`,
                        code: 'AMBIGUOUS_SESSION',
                    };
                }
            }
            await this.stopSessionWithMode(found.key, mode);
        } else {
            console.log(colorize('yellow', `  ⚠ No adapter found for ${cliType}`));
        }
        return { success: true, cliType, dir, stopped: true, mode };
    }

    /** `set_cli_view_mode`: switch a CLI session between terminal and chat presentation. */
    async setCliViewMode(args: any): Promise<CommandResult> {
        const mode = args?.mode === 'chat' ? 'chat' : 'terminal';
        const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId : '';
        const cliType = args?.cliType || args?.agentType || '';
        const dir = args?.dir || '';
        const found = this.findAdapterBySessionId(targetSessionId)
            || (cliType ? this.findAdapter(cliType, { instanceKey: targetSessionId, dir }) : null);
        if (!found) {
            return { success: false, error: 'CLI session not found', code: 'CLI_SESSION_NOT_FOUND' };
        }
        const instance = this.deps.getInstanceManager()?.getInstance(found.key);
        if (!(instance instanceof CliProviderInstance)) {
            return { success: false, error: 'CLI instance not found', code: 'CLI_INSTANCE_NOT_FOUND' };
        }
        instance.setPresentationMode(mode);
        // No onStatusChange poke here any more: the router emits
        // command_executed{command:'set_cli_view_mode'} and session-core's
        // cli-view-mode-facts subscriber turns that into a daemon_facts
        // (wiring-unification B4/B5) — see bootSessionCore.
        return { success: true, id: found.key, mode };
    }

    /** `record_provider_pty`: return the accumulated raw PTY buffer of a running CLI session. */
    async recordProviderPty(args: any): Promise<CommandResult> {
        const cliType = args?.type || args?.cliType;
        if (!cliType) {
            return { success: false, error: '`type` (provider type) is required', code: 'MISSING_TYPE' };
        }
        const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId : '';
        const dir = args?.dir || '';
        const found = (targetSessionId ? this.findAdapterBySessionId(targetSessionId) : null)
            || this.findAdapter(cliType, { instanceKey: targetSessionId, dir });
        if (!found) {
            return {
                success: false,
                error: `No running ${cliType} session. Launch one first (adhdev launch ${cliType}) or pass --target-session-id.`,
                code: 'NO_RUNNING_SESSION',
            };
        }
        const instance = this.deps.getInstanceManager()?.getInstance(found.key);
        if (!(instance instanceof CliProviderInstance)) {
            return { success: false, error: 'CLI instance not available', code: 'CLI_INSTANCE_NOT_FOUND' };
        }
        const adapter = instance.getAdapter();
        if (!adapter || typeof (adapter as any).getAccumulatedRawBuffer !== 'function') {
            return { success: false, error: 'Adapter does not expose PTY buffer', code: 'ADAPTER_NOT_RECORDABLE' };
        }
        const buffer = (adapter as any).getAccumulatedRawBuffer() as { text: string; droppedChars: number };
        const maxBytes = Number(args?.maxBytes) > 0 ? Number(args.maxBytes) : 262144;
        const truncated = buffer.text.length > maxBytes;
        const ptyBytes = truncated ? buffer.text.slice(-maxBytes) : buffer.text;
        return {
            success: true,
            cliType,
            sessionId: found.key,
            ptyBytes,
            bytes: ptyBytes.length,
            truncated,
            droppedChars: buffer.droppedChars,
            capturedAt: Date.now(),
        };
    }

    /** `restart_session`: stop the addressed CLI session (if any) and start a fresh one. */
    async restartSession(args: any): Promise<CommandResult> {
        const cliType = args?.cliType || args?.agentType || args?.ideType;
        const cfg = loadConfig();
        const rdir = resolveLaunchDirectory(
            {
                dir: args?.dir,
                workspaceId: args?.workspaceId,
                useDefaultWorkspace: args?.useDefaultWorkspace === true,
                useHome: args?.useHome === true,
            },
            cfg,
        );
        if (!rdir.ok) {
            const ws = getWorkspaceState(cfg);
            return {
                success: false,
                error: rdir.message,
                code: rdir.code,
                workspaces: ws.workspaces,
                defaultWorkspacePath: ws.defaultWorkspacePath,
            };
        }
        const dir = rdir.path;
        if (!cliType) throw new Error('cliType required');
        const found = this.findAdapter(cliType, { instanceKey: args?.targetSessionId, dir });
        const prevCliArgs = found ? (found.adapter as CliAdapterWithExtraArgs).extraArgs : undefined;
        if (found) await this.stopSession(found.key);
        await this.startSession(cliType, dir, args?.cliArgs || prevCliArgs, args?.initialModel, {
            launchProvenance: resolveLaunchProvenance(args, undefined),
        });
        return { success: true, restarted: true };
    }
    agentCommand(args: AgentCommandArgs): Promise<CommandResult> { return agentCommand(this, args); }
}
