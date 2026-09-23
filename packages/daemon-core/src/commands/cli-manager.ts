/**
 * DaemonCliManager — CLI session creation, management, and command handling
 *
 * Separated from adhdev-daemon.ts.
 * CLI cases of createAdapter, startCliSession, stopCliSession, executeDaemonCommand extracted to independent module extract.
 */

import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { createCliAdapter } from '../providers/spec/route.js';
import type { LaunchableProviderCategory } from '../providers/contracts.js';
import type { CliProviderModule } from '../cli-adapters/provider-cli-shared.js';
import { stripRemovedSpawnArgs } from '../cli-adapters/provider-cli-runtime.js';
import { detectCLI } from '../detection/cli-detector.js';
import { loadConfig } from '../config/config.js';
import { loadState, saveState } from '../config/state-store.js';
import { getWorkspaceState, resolveLaunchDirectory } from '../config/workspaces.js';
import { appendRecentActivity } from '../config/recent-activity.js';
import { shortHash } from '../system/hash.js';
import { getCoordinatorForSession, listCoordinatorsForWorkspace, pruneDeadMeshCoordinators } from '../mesh/coordinator-registry.js';
import { DuplicateMeshDispatchError } from '../mesh/mesh-duplicate-dispatch.js';
import { appendLedgerEntry } from '../mesh/mesh-ledger.js';
import { resolveDelegatedWorkerAutoApproveModeForLaunch, logDelegatedWorkerModeDelivery } from '../mesh/delegated-worker-mode-delivery.js';
import { upsertSavedProviderSession } from '../config/saved-sessions.js';
import { buildLegacyModelModeSummaryMetadata, normalizeProviderSummaryMetadata } from '../providers/summary-metadata.js';
import { CliProviderInstance } from '../providers/cli-provider-instance.js';
import { AcpProviderInstance } from '../providers/acp-provider-instance.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import { normalizeInputEnvelope, type ProviderModule, type ProviderResumeCapability } from '../providers/contracts.js';
import { assertProviderSupportsDeclaredInput, assertTextOnlyInput } from '../providers/provider-input-support.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import { drainInFlightSubmits, type SubmitDrainResult } from './cli-manager-submit-drain.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import type { SessionRegistry } from '../sessions/registry.js';
import type { ProviderInstance, ProviderSendMessageResult } from '../providers/provider-instance.js';
import { LOG } from '../logging/logger.js';
import { shouldRestoreHostedRuntime } from './hosted-runtime-restore.js';
import { evaluateMeshStopTaskScope } from './mesh-stop-task-scope.js';
import { interruptAndDeliver, type InterruptibleAdapter } from './interrupt-and-deliver.js';
// MESH-IMAGE-DISPATCH: shared with the dashboard send path so a multipart dispatch is
// deduplicated by the SAME signature on both routes rather than by two divergent rules.
import { buildSendInputSignature } from './chat-commands-shared.js';
import { findProviderAutoApproveMode, resolveProviderAutoApproveMode } from '../providers/auto-approve-modes.js';
import { expandModelLaunchArgs, resolveModelLaunchValue } from './model-launch-args.js';
import { readModelCache } from '../models/registry.js';
import {
    buildRestoredLaunchRecord,
    buildSessionLaunchRecord,
    inferLaunchedBy,
    readLaunchProvenanceArgs,
    resolveProviderDefaultModel,
    type LaunchProvenanceArgs,
    type SessionLaunchRecord,
    type SessionLaunchedBy,
} from '../sessions/launch-record.js';
import {
    loadPreLaunchTrustFromSpecPath,
    resolveLaunchTrustPlan,
    type ResolvedTrustPlan,
} from '../providers/trust-provenance-ledger.js';
import {
    type CoordinatorDelegatedCliLaunchOptionsInput,
    type CoordinatorDelegatedCliLaunchOptions,
    buildCoordinatorDelegatedCliLaunchOptions,
    resolveHostedSpawnedAtMs,
} from './cli-delegated-launch.js';
export {
    type CoordinatorDelegatedCliLaunchOptionsInput,
    type CoordinatorDelegatedCliLaunchOptions,
    buildCoordinatorDelegatedCliLaunchOptions,
    resolveHostedSpawnedAtMs,
};

export { expandModelLaunchArgs } from './model-launch-args.js';

import {
    BUSY_AGENT_STATUSES,
    commandExists,
    getEffectiveAgentSendStatus,
    normalizeDirForCompare,
    waitForZeroMessageStartingLaunch,
} from './cli-manager-agent-status.js';
import {
    type CliLaunchMode,
    type CliSessionBinding,
    applyAutoApproveModeLaunchArgs,
    expandThinkingLaunchArgs,
    resolveCliSessionBinding,
    supportsExplicitSessionResume,
} from './cli-session-binding.js';
export {
    type CliLaunchMode,
    type CliSessionBinding,
    applyAutoApproveModeLaunchArgs,
    expandThinkingLaunchArgs,
    resolveCliSessionBinding,
    supportsExplicitSessionResume,
};


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

type CommandResult = { success: boolean;[key: string]: unknown };


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
     * dispatchNonce) are deliberately NOT carried here — those are re-derived with
     * terminal/stale/session/nonce guards by restampReboundMeshWorkerAssignment.
     */
    meshNodeFor?: string;
    meshNodeId?: string;
    launchedByCoordinator?: boolean;
    /**
     * Launch provenance persisted in the session-host record meta at spawn
     * (`meta.launchRecord`, Phase E). Raw — validated by
     * `buildRestoredLaunchRecord` when the runtime is re-attached.
     */
    launchRecord?: unknown;
}

type CliPresentationInstance = ProviderInstance & {
    getPresentationMode?(): 'terminal' | 'chat';
};

type ChalkColorFn = (text: string) => string;
type ChalkLike = Partial<Record<'red' | 'green' | 'yellow' | 'cyan', ChalkColorFn>>;

const chalkModule = chalk as unknown as ChalkLike & { default?: ChalkLike };
const chalkApi: ChalkLike | null = typeof chalkModule.yellow === 'function'
    ? chalkModule
    : chalkModule.default || null;

function colorize(color: 'red' | 'green' | 'yellow' | 'cyan', text: string): string {
    const fn = chalkApi?.[color];
    return typeof fn === 'function' ? fn(text) : text;
}

type CliAdapterWithExtraArgs = CliAdapter & {
    extraArgs?: string[];
};

/** CANCEL-STOP-TASK-SCOPE: per-turn task binding, set when the turn was submitted. */
type CliAdapterWithTurnTaskId = CliAdapter & {
    currentTurnTaskId?: string;
};

type CliStartOptions = {
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

// PTY-SUBMIT-IDEMPOTENCY: window for the mesh-dispatch duplicate-submission guard
// (see DaemonCliManager.beginMeshDispatchSubmission). Observed machine-driven
// redeliveries of one dispatch landed 8.5s / 18s / 96s after the first inject —
// the 96s case already outruns the 60s chat-bubble ack dedup window
// (USER_INPUT_ACK_DEDUP_WINDOW_MS). The window must outlast the slowest automatic
// re-dispatch source: a dispatch-confirm timeout (120s,
// mesh-queue-assignment DISPATCH_CONFIRM_TIMEOUT_MS) plus a reconcile tick (~4s)
// before the re-claimed dispatch arrives, so 300s gives >2x headroom over that
// ~124s worst case. It stays finite so a genuinely re-issued turn of the same
// task text much later is never permanently blocked — and because the guard key
// includes the taskId, a deliberate resend (a handoff/retry mints a NEW task row,
// hence a new taskId) is unaffected by the window at any length.
const MESH_DISPATCH_SUBMIT_DEDUP_WINDOW_MS = 300_000;
/** Grace between a session reporting stopped/error and its reclamation — long
 *  enough for the final status/mesh events to flush, see scheduleAutoClean. */
const AUTO_CLEAN_DELAY_MS = 5_000;

/**
 * Phase E: `launch_cli` provenance. An explicit, validated `launchedBy` wins;
 * otherwise mesh settings mean a mesh launch and anything else is an API caller.
 */
function resolveLaunchProvenance(
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

// ─── DaemonCliManager ────────────────────────────

export class DaemonCliManager {
    readonly adapters = new Map<string, CliAdapter>();
    private deps: CliManagerDeps;
    private providerLoader: ProviderLoader;
    // PTY-SUBMIT-IDEMPOTENCY: (sessionKey:taskId:contentHash) → first-submission
    // timestamp for mesh task dispatches already handed to the adapter. Entries
    // older than MESH_DISPATCH_SUBMIT_DEDUP_WINDOW_MS are pruned lazily on check.
    private meshDispatchSubmissions = new Map<string, number>();

    constructor(deps: CliManagerDeps, providerLoader: ProviderLoader) {
        this.deps = deps;
        this.providerLoader = providerLoader;
    }

    /**
     * PTY-SUBMIT-IDEMPOTENCY guard. recordAcknowledgedUserInput runs AFTER
     * adapter.sendMessage, so it only collapses the duplicate chat bubble — the
     * second PTY write has already happened. And the attachMeshAssignment stamp
     * guard (findLiveWorkingTaskHolder) deliberately excludes the TARGET instance,
     * so a redelivery onto the SAME session (dispatch-confirm-timeout requeue,
     * reconcile re-dispatch, delivered-not-consumed redrive) was never caught.
     * This guard runs BEFORE the submit and keys on session + taskId + content:
     *   - same task, same text, inside the window → a machine redelivery → suppress;
     *   - same task, DIFFERENT text → a legitimate follow-up delta → allowed;
     *   - different taskId (a deliberate resend/handoff mints a fresh task row) → allowed;
     *   - same task+text AFTER the window → a genuinely re-issued turn → allowed;
     *   - a prior attempt whose submit FAILED releases its key (see the catch in
     *     the send_chat branch), so failure retries are never blocked;
     *   - forceSend bypasses the guard entirely (explicit operator intent).
     * Returns the guard key on admission, or null when the submission is a
     * duplicate and must be suppressed.
     */
    private beginMeshDispatchSubmission(sessionKey: string, taskId: string, content: string): string | null {
        const now = Date.now();
        for (const [k, at] of this.meshDispatchSubmissions) {
            if (now - at > MESH_DISPATCH_SUBMIT_DEDUP_WINDOW_MS) this.meshDispatchSubmissions.delete(k);
        }
        const guardKey = `${sessionKey}:${taskId}:${shortHash(content, 24)}`;
        if (this.meshDispatchSubmissions.has(guardKey)) return null;
        this.meshDispatchSubmissions.set(guardKey, now);
        return guardKey;
    }

 // ─── Key create ─────────────────────────────────

    getCliKey(cliType: string, dir: string): string {
        const hash = require('crypto').createHash('md5').update(require('path').resolve(dir)).digest('hex').slice(0, 8);
        return `${cliType}_${hash}`;
    }

    getSessionPresentationMode(sessionId: string): 'terminal' | 'chat' | null {
        if (!sessionId) return null;
        const instance = this.deps.getInstanceManager()?.getInstance(sessionId) as CliPresentationInstance | undefined;
        const mode = instance?.category === 'cli'
            ? instance.getPresentationMode?.()
            : null;
        return mode === 'chat' || mode === 'terminal' ? mode : null;
    }

    isTerminalSession(sessionId: string): boolean {
        return this.getSessionPresentationMode(sessionId) === 'terminal';
    }

    /** The provider loader's resolved channel, when it exposes one (test doubles may not). */
    private readProviderChannel(): string | undefined {
        const channel = (this.providerLoader as { channel?: unknown }).channel;
        return typeof channel === 'string' ? channel : undefined;
    }

    private persistRecentActivity(entry: {
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
            if (entry.providerSessionId && (entry.kind === 'cli' || entry.kind === 'acp')) {
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

    private createAdapter(
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
    private scheduleAutoClean(key: string, adapter: CliAdapter, terminalStatus: string): void {
        setTimeout(() => {
            if (this.adapters.get(key) !== adapter) return;
            const instanceManager = this.deps.getInstanceManager();
            // KIMI-MESH-COMPLETION-EMIT (axis 2): before removeInstance closes the
            // event-emit window, give a mesh DELEGATED worker one last chance to emit
            // its completion. A native-source worker (e.g. kimi) can have its PTY
            // killed by a false stall AFTER it finished the task (transcript written)
            // but BEFORE the FSM's idle→completed event fired — the instance is the
            // only thing that can emit that event, and it is about to be removed. The
            // instance-side method is a no-op for a non-mesh session or when the
            // turn's completion already fired (double-emit guard) or when there is no
            // transcript evidence of a finished turn. Best-effort — never blocks cleanup.
            try {
                const inst = instanceManager?.getInstance(key) as (ProviderInstance & { flushMeshCompletionBeforeCleanup?: () => boolean }) | undefined;
                if (typeof inst?.flushMeshCompletionBeforeCleanup === 'function') {
                    const emitted = inst.flushMeshCompletionBeforeCleanup();
                    if (emitted) LOG.info('CLI', `Emitted pre-cleanup mesh completion for ${adapter.cliType} session ${key} before auto-clean`);
                }
            } catch (e) {
                LOG.warn('CLI', `pre-cleanup mesh completion flush failed for ${key}: ${(e as Error)?.message || e}`);
            }
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

    private async registerCliInstance(
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
        const launchAutoLaunchedForQueueTaskId = typeof settings?.autoLaunchedForQueueTaskId === 'string'
            ? settings.autoLaunchedForQueueTaskId.trim()
            : '';
        const launchRecordMeta: Record<string, unknown> = {
            ...(launchMeshNodeId ? { meshNodeId: launchMeshNodeId } : {}),
            ...(launchMeshNodeFor ? { meshNodeFor: launchMeshNodeFor } : {}),
            ...(settings?.launchedByCoordinator === true ? { launchedByCoordinator: true } : {}),
            ...(launchAutoLaunchedForQueueTaskId ? { autoLaunchedForQueueTaskId: launchAutoLaunchedForQueueTaskId } : {}),
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
                // coordinator + MAGI replicas all running as hosted runtimes sharing one
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

 // ─── Session start/management ──────────────────────────────

    async startSession(
        cliType: string,
        workingDir: string,
        cliArgs?: string[],
        initialModel?: string,
        options?: CliStartOptions,
    ): Promise<{ runtimeSessionId: string; providerSessionId?: string }> {
        const trimmed = (workingDir || '').trim();
        if (!trimmed) throw new Error('working directory required');
        const resolvedDir = trimmed.startsWith('~')
            ? trimmed.replace(/^~/, os.homedir())
            : path.resolve(trimmed);

 // cliType normalize (Resolve alias)
        const normalizedType = this.providerLoader.resolveAlias(cliType);
        const rawProvider = this.providerLoader.getByAlias(cliType);
        const provider = rawProvider ? (this.providerLoader.resolve(normalizedType) || rawProvider) : undefined;
        if (provider && (provider.category === 'cli' || provider.category === 'acp') && !this.providerLoader.isMachineProviderEnabled(normalizedType)) {
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

        const sessionRegistry = this.deps.getSessionRegistry?.() || null;

 // ─── ACP category handle ───
        if (provider && provider.category === 'acp') {
            const instanceManager = this.deps.getInstanceManager();
            if (!instanceManager) throw new Error('InstanceManager not available');
            const resolvedProvider = this.providerLoader.resolve(normalizedType) || provider;

 // Check if command is installed
            const spawnCmd = resolvedProvider.spawn?.command;
            if (spawnCmd && !commandExists(spawnCmd)) {
                const installInfo = provider.install || `Install: check ${provider.displayName || provider.name} documentation`;
                throw new Error(
                    `${provider.displayName || provider.name} is not installed.\n` +
                    `Command '${spawnCmd}' not found.\n\n` +
                    `${installInfo}`
                );
            }

            console.log(colorize('cyan', `  🔌 Starting ACP agent: ${provider.name} (${provider.type}) in ${resolvedDir}`));

            const acpInstance = new AcpProviderInstance(resolvedProvider, resolvedDir, cliArgs);
            await instanceManager.addInstance(key, acpInstance, {
                settings: this.providerLoader.getSettings(normalizedType),
            });
            const sessionId = acpInstance.getInstanceId();
            sessionRegistry?.register({
                sessionId,
                parentSessionId: null,
                providerType: normalizedType,
                transport: 'acp',
                adapterKey: key,
                instanceKey: key,
                workspace: resolvedDir,
            }, 'launch');

 // Register ACP entry in adapter map (getStatus queries from acpInstance in real-time)
            this.adapters.set(key, {
                cliType: normalizedType,
                cliName: provider.name,
                workingDir: resolvedDir,
                _acpInstance: acpInstance,
                spawn: async () => {},
                shutdown: () => { instanceManager.removeInstance(key); },
                sendMessage: async (text: string) => {
                    const input = normalizeInputEnvelope(text);
                    // SEND-RECORD-SYMMETRY: this shim is how the mesh funnel reaches an
                    // ACP provider (it is awaited as an adapter). Swallowing the
                    // acknowledgement here would reintroduce the false success the
                    // instance-level contract now reports — a refused send (no live
                    // session, or a prompt already in flight) must reach the caller.
                    const outcome = await acpInstance.onEvent('send_message', { input });
                    if (outcome && !outcome.success) {
                        throw new Error(outcome.error || 'ACP send was not acknowledged');
                    }
                },
                getStatus: () => {
                    const state = acpInstance.getState();
                    return {
                        status: state.status,
                        messages: state.activeChat?.messages || [],
                        activeModal: state.activeChat?.activeModal || null,
                    };
                },
                cancel: () => { instanceManager.removeInstance(key); },
                isProcessing: () => false,
                isReady: () => true,
                setOnStatusChange: () => {},
                setOnPtyData: () => {},
            });

            console.log(colorize('green', `  ✓ ACP agent started: ${provider.name} in ${resolvedDir}`));

 // If initialModel exists, change model after session start
            let acpModelApplied = false;
            if (initialModel) {
                try {
                    await acpInstance.setConfigOption('model', initialModel);
                    acpModelApplied = true;
                    console.log(colorize('green', `  🤖 Initial model set: ${initialModel}`));
                } catch (e: any) {
                    LOG.warn('CLI', `[ACP] Initial model set failed: ${e?.message}`);
                }
            }

 // Brain routing thinking axis for ACP: route the standard level through the
 // agent's thought_level config option. Best-effort — throws if the agent declares
 // no thought_level category (see setConfigOption), so we swallow and warn.
            let acpThinkingApplied = false;
            if (options?.initialThinkingLevel) {
                const lvl = options.initialThinkingLevel;
                try {
                    await acpInstance.setConfigOption('thought_level', lvl);
                    acpThinkingApplied = true;
                    console.log(colorize('green', `  🧠 Initial thinking level set: ${lvl}`));
                } catch (e: any) {
                    LOG.warn('CLI', `[ACP] Initial thinking level set failed (provider may not support thought_level): ${e?.message}`);
                }
            }

            // Phase E: the launch record. ACP applies values through
            // setConfigOption, so `launchValue` is the requested value when the
            // call succeeded and absent when it failed.
            const acpLaunchRecord = buildSessionLaunchRecord({
                sessionId,
                providerType: normalizedType,
                providerVersion: (resolvedProvider as { providerVersion?: string }).providerVersion,
                providerChannel: this.readProviderChannel(),
                launchedBy: options?.launchProvenance?.launchedBy ?? 'api',
                launchedAt: Date.now(),
                workspace: resolvedDir,
                model: {
                    requested: initialModel,
                    declaredSource: options?.launchProvenance?.modelSource,
                    launchValue: acpModelApplied ? initialModel : undefined,
                    providerDefault: resolveProviderDefaultModel(
                        readModelCache(normalizedType),
                        resolvedProvider.modelOptions,
                        resolvedProvider.modelLaunchValueMap,
                    ),
                },
                thinkingLevel: {
                    requested: options?.initialThinkingLevel,
                    declaredSource: options?.launchProvenance?.thinkingLevelSource,
                    launchValue: acpThinkingApplied ? options?.initialThinkingLevel : undefined,
                },
            });
            sessionRegistry?.setLaunchRecord?.(sessionId, acpLaunchRecord, 'launch');
            acpInstance.setModelObserver((model, observedAt) => {
                sessionRegistry?.observeLaunchAxis?.(sessionId, 'model', model, observedAt);
            });

            this.persistRecentActivity({
                kind: 'acp',
                providerType: normalizedType,
                providerName: provider.displayName || provider.name || normalizedType,
                workspace: resolvedDir,
                summaryMetadata: launchSummaryMetadata(acpLaunchRecord),
                sessionId,
                title: provider.displayName || provider.name || normalizedType,
            });
            return { runtimeSessionId: sessionId };
        }

 // ─── CLI category handling (existing) ───
        const cliInfo = await detectCLI(cliType, this.providerLoader);
        if (!cliInfo) {
            const installHint = provider?.install || '';
            const displayName = provider?.displayName || provider?.name || cliType;
            const spawnCmd = this.providerLoader.getSpawnCommand(normalizedType, provider?.spawn?.command || cliType);
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
            ...this.providerLoader.getSettings(normalizedType),
            ...(options?.settingsOverride || {}),
        };
        const versionResolvedProvider = provider
            ? (this.providerLoader.resolve(cliType, { version: cliInfo.version }) || provider)
            : undefined;
        const autoApproveLaunch = applyAutoApproveModeLaunchArgs(versionResolvedProvider, cliArgs, launchSettings);
        const launchProvider = autoApproveLaunch.provider || provider;
        const cliArgsWithAutoApprove = autoApproveLaunch.cliArgs;

 // ─── Model axis (MAGI kind-panel): expand initialModel → launch args ───
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
            providerChannel: this.readProviderChannel(),
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
        const instanceManager = this.deps.getInstanceManager();
        if (launchProvider && instanceManager) {
            const resolvedProvider = launchProvider;
            await this.registerCliInstance(
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
                        this.persistRecentActivity({
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
            const adapter = this.createAdapter(
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
                    this.scheduleAutoClean(key, adapter, status.status);
                }
            });

            if (typeof adapter.setOnPtyData === 'function') {
                adapter.setOnPtyData((data: string) => {
                    this.deps.getP2p()?.broadcastSessionOutput(key, data);
                });
            }

            this.adapters.set(key, adapter);
            console.log(colorize('green', `  ✓ CLI started: ${cliInfo.displayName} v${cliInfo.version || 'unknown'} in ${resolvedDir}`));
        }

        this.persistRecentActivity({
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

    shutdownAll(): void {
        for (const adapter of this.adapters.values()) adapter.shutdown();
        this.adapters.clear();
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

    async restoreHostedSessions(records?: HostedCliRuntimeDescriptor[]): Promise<number> {
        const instanceManager = this.deps.getInstanceManager();
        if (!instanceManager) return 0;
        const sessions = records || await this.deps.listHostedCliRuntimes?.() || [];
        let restored = 0;
        const restoredBindings = new Set<string>();
        const managerTag = this.deps.hostedRuntimeManagerTag;

        // CORDBADGE worker-overbind guard pre-pass: the workspace-scoped coordinator
        // rebind fallback (below) recovers a coordinator's mark when its runtimeId
        // changed across restart. But a delegated WORKER session that shares the
        // coordinator's workspace+cliType ALSO misses the exact by-id lookup, so the
        // fallback would wrongly stamp it with the lone registered coordinator's mesh
        // mark (the reported bug: a worker shown with role:coordinator after restart).
        // Two batch-level signals let the fallback refuse to mark a worker:
        //   - restoredRuntimeIds: every runtimeId in this restore batch. If a
        //     registered coordinator's own sessionId appears here, that coordinator is
        //     being restored under its known id (the exact match binds it), so ANY
        //     other same-workspace session is a worker — not the renamed coordinator.
        //   - workspaceTypeCounts: how many sessions in the batch share a
        //     workspace+cliType. >1 means we cannot tell the coordinator from a worker
        //     even if the coordinator's id changed, so we stay unbound (ambiguous).
        const restoredRuntimeIds = new Set<string>();
        const workspaceTypeCounts = new Map<string, number>();
        for (const r of sessions) {
            if (!r?.runtimeId || !r?.cliType || !r?.workspace) continue;
            restoredRuntimeIds.add(r.runtimeId);
            const key = `${r.workspace}::${r.cliType}`;
            workspaceTypeCounts.set(key, (workspaceTypeCounts.get(key) || 0) + 1);
        }
        // STALE-COORDINATOR-PRUNE: registry entries adopted through the workspace
        // rebind fallback below. Such an entry belongs to a LIVE coordinator whose
        // runtimeId changed across restart, so its registered sessionId is (by
        // definition) absent from the live-runtime list — the post-loop prune must
        // exempt it, or the fix would delete the very entry the fallback just used
        // and reintroduce the badge loss on the NEXT restart.
        const rebindAdoptedSessionIds = new Set<string>();

        for (const record of sessions) {
            if (!record?.runtimeId || !record?.cliType || !record?.workspace) continue;
            if (!shouldRestoreHostedRuntime(record, managerTag)) {
                LOG.info(
                    'CLI',
                    `↷ Skipping hosted runtime restore owned by ${record.managedBy}: ${record.runtimeKey || record.runtimeId}`
                );
                continue;
            }
            if (this.adapters.has(record.runtimeId) || instanceManager.getInstance(record.runtimeId)) continue;
            const normalizedType = this.providerLoader.resolveAlias(record.cliType);
            const providerMeta = this.providerLoader.getMeta(normalizedType);
            if (!providerMeta || providerMeta.category !== 'cli') continue;

            const resolvedProvider = this.providerLoader.resolve(normalizedType) || providerMeta;
            const sessionBinding = resolveCliSessionBinding(
                resolvedProvider,
                normalizedType,
                record.cliArgs,
                record.providerSessionId,
            );
            const bindingKey = [
                normalizedType,
                record.workspace,
                sessionBinding.providerSessionId || record.runtimeId,
            ].join('::');
            if (restoredBindings.has(bindingKey)) {
                LOG.info(
                    'CLI',
                    `↷ Skipping duplicate hosted runtime restore: ${record.runtimeKey || record.runtimeId} (${normalizedType} @ ${record.workspace}) binding=${sessionBinding.providerSessionId || 'runtime'}`
                );
                continue;
            }
            // Re-establish the launch-time settings a fresh launch applies. startSession
            // seeds every new instance with { ...providerLoader.getSettings(type), ...override };
            // passing a bare {} here on restart silently dropped TWO launch settings, so a
            // restored session diverged from a freshly-launched one:
            //   - autoApprove (a provider/machine setting from getSettings) → a restored
            //     coordinator self-session lost auto-approve and re-prompted on every tool call.
            //   - meshCoordinatorFor (the coordinator launch's settingsOverride) → the restored
            //     session was no longer recognized as this daemon's live CLI coordinator by
            //     findLiveCoordinators (so pending mesh events stopped draining into its PTY) nor
            //     surfaced with the coordinator badge via settings. The persisted coordinator
            //     registry (loaded on boot) is the source of truth to rebuild that mark.
            // Both restores are provider-agnostic — getSettings is keyed by provider type and the
            // registry mark is type-independent.
            const restoredSettings: Record<string, any> = { ...this.providerLoader.getSettings(normalizedType) };
            // Primary rebind: exact persisted-registry match by runtimeId (stable across
            // restart, see session-host runtimeId = runtimeRecord.sessionId).
            let coordinatorEntry = getCoordinatorForSession(record.runtimeId);
            // CORDBADGE fallback: the by-id match misses when a coordinator's runtime
            // re-attaches under a different runtimeId than the one it was registered with
            // (the registry survived, but its key no longer lines up). Without a rebind the
            // restored session silently loses meshCoordinatorFor → the coordinator badge and
            // selfIdentification block vanish and pending mesh events stop draining into its
            // PTY, and the only recovery is a manual coordinator restart. Recover the mark
            // from the persisted registry scoped to this exact workspace, but ONLY when it is
            // UNAMBIGUOUS: exactly one registered coordinator for this workspace AND its
            // cliType matches the restored session's type.
            //
            // WORKER-OVERBIND guard: "exactly one registered coordinator" is NOT enough —
            // a delegated worker session sharing the coordinator's workspace+cliType also
            // misses the by-id lookup, and the registry holding only the (single) real
            // coordinator does NOT stop the fallback from projecting that coordinator's
            // mark onto the worker record. So before adopting the mark we positively rule
            // the worker out:
            //   (a) coordinatorPresentById — the registered coordinator's own sessionId is
            //       in this restore batch, i.e. it is being restored under its known id and
            //       the exact match already binds it. Then THIS record (which missed) is a
            //       worker, not the renamed coordinator → do not rebind.
            //   (b) siblingCount > 1 — more than one session shares this workspace+cliType,
            //       so even if the coordinator's id changed we cannot tell it from a worker
            //       → stay unbound (ambiguous).
            // Anything ambiguous stays unbound (we would rather miss a badge than
            // mis-attribute one).
            if (!coordinatorEntry?.meshId && record.workspace) {
                const workspaceCoordinators = listCoordinatorsForWorkspace(record.workspace)
                    .filter(e => e.meshId && (!e.cliType || e.cliType === record.cliType));
                if (workspaceCoordinators.length === 1) {
                    const candidate = workspaceCoordinators[0];
                    const coordinatorPresentById = !!candidate.sessionId && restoredRuntimeIds.has(candidate.sessionId);
                    const siblingCount = workspaceTypeCounts.get(`${record.workspace}::${record.cliType}`) || 1;
                    if (!coordinatorPresentById && siblingCount === 1) {
                        coordinatorEntry = candidate;
                        if (candidate.sessionId) rebindAdoptedSessionIds.add(candidate.sessionId);
                        LOG.info(
                            'CLI',
                            `↻ Rebound coordinator mark by workspace for ${record.runtimeKey || record.runtimeId} (mesh ${candidate.meshId} @ ${record.workspace}); registry key did not match runtimeId`
                        );
                    } else {
                        LOG.info(
                            'CLI',
                            `↷ Skipping workspace coordinator rebind for ${record.runtimeKey || record.runtimeId} (${record.cliType} @ ${record.workspace}): ${coordinatorPresentById
                                ? 'registered coordinator is restoring under its own id — this is a delegated worker'
                                : `ambiguous (${siblingCount} sessions share this workspace+cliType)`}`
                        );
                    }
                } else if (workspaceCoordinators.length === 0) {
                    // CORDBADGE-DIAG: the by-id lookup missed AND the workspace fallback has
                    // NOTHING to rebind to — the registry holds no coordinator for this
                    // workspace at all (evicted registry, or the coordinator registered under
                    // a different workspace). Both other branches log; this one was silent,
                    // which sent the 2026-08-21 badge-loss investigation down the wrong path
                    // (no 'Rebound' and no 'Skipping' line at all).
                    LOG.debug(
                        'CLI',
                        `No registered coordinator for workspace ${record.workspace} — workspace rebind fallback empty for ${record.runtimeKey || record.runtimeId} (${record.cliType}); the session stays unmarked`
                    );
                }
            }
            if (coordinatorEntry?.meshId) {
                restoredSettings.meshCoordinatorFor = coordinatorEntry.meshId;
            }
            // RESTART-REBOUND RELAY ENVELOPE (rc.20): re-apply the session-level mesh
            // membership the launch/dispatch path persisted into the session-host
            // record meta. A rebuilt instance otherwise carries NONE of it (settings
            // are in-memory), so a rebound LOCAL mesh worker failed
            // resolveWorkerDelegateRouting (no_worker_envelope) on its very first
            // post-restart event, mesh_read_terminal / mesh_send_keys refused it as
            // non-worker, and the post-completion detach did a FULL clear
            // (launchedByCoordinator falsy) — stripping the membership a launched
            // member is supposed to KEEP. This restores membership ONLY; the
            // task-level envelope (meshActiveTaskId / attemptId / dispatchNonce /
            // coordinator ids) is re-derived separately with causal guards by
            // restampReboundMeshWorkerAssignment, so no terminal/stale/
            // session-mismatched attempt is ever resurrected here.
            const recordMeshNodeFor = typeof record.meshNodeFor === 'string' && record.meshNodeFor.trim()
                ? record.meshNodeFor.trim() : '';
            const recordMeshNodeId = typeof record.meshNodeId === 'string' && record.meshNodeId.trim()
                ? record.meshNodeId.trim() : '';
            if (recordMeshNodeFor) restoredSettings.meshNodeFor = recordMeshNodeFor;
            if (recordMeshNodeId) {
                restoredSettings.meshNodeId = recordMeshNodeId;
                // Keep the sticky last-node marker consistent with the active binding
                // (attachMeshAssignment maintains the same pair at dispatch time).
                restoredSettings.meshLastNodeId = recordMeshNodeId;
            }
            if (record.launchedByCoordinator === true) restoredSettings.launchedByCoordinator = true;
            try {
                await this.registerCliInstance(
                    record.runtimeId,
                    normalizedType,
                    record.cliType,
                    record.workspace,
                    record.cliArgs,
                    resolvedProvider,
                    restoredSettings,
                    true,
                    {
                        providerSessionId: sessionBinding.providerSessionId,
                        launchMode: 'manual',
                        // Thread the runtime's REAL past spawn time so the attach restores
                        // the per-session native-history birth-floor instead of collapsing
                        // to spawnedAtMs:0 (which disabled the antigravity per-session floor
                        // and let MAGI replicas claim the coordinator's own conversation).
                        // Undefined → registerCliInstance keeps the 0 fallback.
                        attachStartedAtMs: record.startedAtMs,
                        // Phase E: the provenance stored at spawn, launchedBy → 'restore'
                        // with the axis sources preserved (see buildRestoredLaunchRecord).
                        launchRecord: buildRestoredLaunchRecord(record.launchRecord, {
                            sessionId: record.runtimeId,
                            providerType: normalizedType,
                            workspace: record.workspace,
                            launchedAt: record.startedAtMs ?? Date.now(),
                        }),
                    },
                );
                restoredBindings.add(bindingKey);
                restored += 1;
                LOG.info('CLI', `♻ Restored hosted runtime: ${record.runtimeKey || record.runtimeId} (${record.displayName || record.workspace})`);
            } catch (error: any) {
                LOG.warn('CLI', `Failed to restore hosted runtime ${record.runtimeId}: ${error?.message || error}`);
            }
        }

        // STALE-COORDINATOR-PRUNE (boot path only): when this is the full boot-time
        // restore (no explicit records — an ad-hoc single-record restore must NEVER
        // prune), the fetched list IS the set of live hosted runtimes, so any
        // persisted coordinator entry whose sessionId is absent is a leftover from
        // a previous daemon generation: unregisterMeshCoordinator only runs on
        // explicit stop/exit paths, and an upgrade/restart takes none of them.
        // Those stale entries accumulate in mesh-coordinators.json and permanently
        // break the workspace rebind fallback's "exactly one registered
        // coordinator" unambiguity condition above (the lost-coordinator-badge
        // bug). Runs AFTER the restore loop so a live coordinator whose runtimeId
        // changed (adopted via the rebind fallback) is exempted through
        // rebindAdoptedSessionIds. The live-id set deliberately includes runtimes
        // owned by OTHER manager tags (shouldRestoreHostedRuntime skips them, but
        // they are live sessions whose entries must survive).
        if (!records && typeof this.deps.listHostedCliRuntimes === 'function') {
            const liveSessionIds = new Set<string>(restoredRuntimeIds);
            for (const r of sessions) {
                if (r?.runtimeId) liveSessionIds.add(r.runtimeId);
            }
            for (const sessionId of rebindAdoptedSessionIds) liveSessionIds.add(sessionId);
            for (const entry of pruneDeadMeshCoordinators(liveSessionIds)) {
                LOG.info(
                    'CLI',
                    `🧹 Pruned stale mesh coordinator entry ${entry.sessionId} (mesh ${entry.meshId}${entry.workspace ? ` @ ${entry.workspace}` : ''}, started ${new Date(entry.startedAt || 0).toISOString()}): session is not among the ${liveSessionIds.size} live hosted runtime(s) after daemon restart`
                );
            }
        }

        return restored;
    }

 // ─── Adapter search ─────────────────────────────

 /**
 * Search for CLI adapter. Priority order:
 * 0. sessionId (UUID direct match)
 * 1. agentType + dir (iteration match)
 * 2. agentType fuzzy match (⚠ returns first match when multiple sessions exist)
 */
    findAdapter(agentType: string, opts?: { dir?: string; instanceKey?: string }): { adapter: CliAdapter; key: string } | null {
 // 0. UUID direct match (most accurate)
        if (opts?.instanceKey) {
            let ik = opts.instanceKey;
 // Strip composite prefix: 'doId:cli:uuid' → 'uuid' or 'doId:uuid' → 'uuid'
            const colonIdx = ik.lastIndexOf(':');
            if (colonIdx >= 0) ik = ik.substring(colonIdx + 1);
            const adapter = this.adapters.get(ik);
            if (adapter) return { adapter, key: ik };
        }
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
    private findMeshNodeAdapter(agentType: string, nodeId: string, dir?: string): { adapter: CliAdapter; key: string } | null {
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

 // ─── CLI command handling ────────────────────────────

    /** `launch_cli`: resolve the launch directory and start (or reuse) a CLI/ACP session. */
    async launchCli(args: any): Promise<CommandResult> {
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
            this.providerLoader.refreshIfChannelActivationChanged?.();
        } catch (e: any) {
            LOG.warn('ProviderStore', `channel activation refresh failed: ${e?.message || e}`);
        }
        const providerType = this.providerLoader.resolveAlias(cliType);
        const provLookup = this.providerLoader.getMeta(providerType) as ProviderModule | undefined;
        let settingsOverride = args?.settings && typeof args.settings === 'object' ? args.settings : undefined;
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
                resolvedSpecPath: this.providerLoader.getResolvedSpecPath(providerType) ?? undefined,
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
        const started = await this.startSession(
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

        // LAUNCH-ACCOUNTING funnel: every mesh WORKER spawn — mesh_launch_session,
        // queue auto-launch (local AND remote: the remote leg forwards launch_cli to
        // this daemon), and the recovery relaunch — passes through this case with
        // `meshNodeFor` stamped, so the audit `session_launched` entry is written
        // HERE, on the daemon that actually spawned the session. Before this, only
        // the mesh_launch_session MCP tool recorded one (the 2026-09-08 runaway
        // spawned 60 sessions that were invisible to the ledger). Coordinator
        // sessions stamp `meshCoordinatorFor`, not `meshNodeFor`, and stay excluded.
        // `ledgerLaunchRecorded` in the result tells a caller that also records
        // launches (mcp-server mesh_launch_session) to skip its own append.
        let ledgerLaunchRecorded = false;
        if (delegatedMeshId) {
            try {
                const autoLaunchTaskId = typeof settingsOverride?.autoLaunchedForQueueTaskId === 'string'
                    ? settingsOverride.autoLaunchedForQueueTaskId.trim() : '';
                // NB: distinct from this case's `launchSource` local (workspace-resolution
                // origin) — `meshLaunchSource` is the mesh-envelope path discriminator.
                const declaredSource = typeof settingsOverride?.meshLaunchSource === 'string'
                    ? settingsOverride.meshLaunchSource.trim() : '';
                const meshNodeId = typeof settingsOverride?.meshNodeId === 'string'
                    ? settingsOverride.meshNodeId.trim() : '';
                appendLedgerEntry(delegatedMeshId, {
                    kind: 'session_launched',
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
                });
                ledgerLaunchRecorded = true;
            } catch { /* accounting is best-effort — never fail the launch */ }
        }

        return {
            success: true,
            cliType,
            dir,
            id: started.runtimeSessionId,
            sessionId: started.runtimeSessionId,
            providerSessionId: started.providerSessionId,
            launchSource,
            ...(ledgerLaunchRecorded ? { ledgerLaunchRecorded: true } : {}),
        };
    }

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

    /** `agent_command`: send_chat / clear_history / stop against a CLI session. */
    async agentCommand(args: any): Promise<CommandResult> {
        const agentType = args?.agentType || args?.cliType;
        const action = args?.action;
        if (!agentType || !action) throw new Error('agentType and action required');

        // WTCLAIM (B): a mesh dispatch that named a node (meshContext.nodeId)
        // but resolved no explicit session must be scoped to THAT node's
        // session — never routed by findAdapter's provider-only fuzzy fallback,
        // which on a daemon hosting both a base node and a cloned worktree node
        // (same daemonId) could land a worktree task on the base session. Fail
        // closed when no session is bound to the node so the coordinator
        // launches/retries instead of mis-landing the work.
        const meshScopeNodeId = (() => {
            const mc = (args as any)?.meshContext;
            return mc && typeof mc === 'object' && typeof mc.nodeId === 'string' ? mc.nodeId.trim() : '';
        })();
        let found: { adapter: CliAdapter; key: string } | null;
        if (meshScopeNodeId && !args?.targetSessionId) {
            found = this.findMeshNodeAdapter(agentType, meshScopeNodeId, args?.dir);
            if (!found) {
                throw new Error(`No mesh worker session bound to node '${meshScopeNodeId}' for agent '${agentType}' on this daemon; refusing provider-only fuzzy match to avoid cross-node dispatch`);
            }
        } else {
            found = this.findAdapter(agentType, {
                dir: args?.dir,
                instanceKey: args?.targetSessionId,
            });
        }
        if (!found) throw new Error(`CLI agent not running: ${agentType}`);
        const { adapter, key } = found;

        if (action === 'send_chat') {
            let currentStatus = getEffectiveAgentSendStatus(adapter);
            if (currentStatus === 'starting' && await waitForZeroMessageStartingLaunch(adapter)) {
                currentStatus = 'idle';
            } else if (currentStatus === 'starting') {
                currentStatus = getEffectiveAgentSendStatus(adapter);
            }
            // Stamp mesh direct-dispatch assignment on the target
            // instance BEFORE sending the prompt so the completion
            // event has a routing marker by the time it fires.
            // mesh_send_task --direct ships meshContext for plain CLI
            // sessions that were never launched as mesh delegates.
            const meshContext = (args as any)?.meshContext;
            if (meshContext && typeof meshContext === 'object' && typeof meshContext.meshId === 'string' && meshContext.meshId) {
                const targetInstanceId = key;
                let stampResult: { stamped: boolean; reason?: string; holderSessionId?: string } | undefined;
                try {
                    stampResult = this.deps.getInstanceManager()?.attachMeshAssignmentToInstance(targetInstanceId, {
                        meshId: meshContext.meshId,
                        ...(typeof meshContext.nodeId === 'string' && meshContext.nodeId ? { nodeId: meshContext.nodeId } : {}),
                        ...(typeof meshContext.taskId === 'string' && meshContext.taskId ? { taskId: meshContext.taskId } : {}),
                        // REDRIVE-DUP: carry the dispatch nonce onto the worker session so
                        // its generating_started event echoes it back for the coordinator's
                        // stale-nonce guard.
                        ...(typeof meshContext.dispatchNonce === 'number' ? { dispatchNonce: meshContext.dispatchNonce } : {}),
                        // TURN-LEDGER (Stage 5): carry the attempt identity onto the
                        // worker session so its lifecycle events echo it back for the
                        // coordinator's reducer.
                        ...(typeof meshContext.attemptId === 'string' && meshContext.attemptId ? { attemptId: meshContext.attemptId } : {}),
                        ...(typeof meshContext.coordinatorDaemonId === 'string' && meshContext.coordinatorDaemonId ? { coordinatorDaemonId: meshContext.coordinatorDaemonId } : {}),
                        // SESSION-ISOLATION: the originating coordinator SESSION, so this
                        // worker's completion routes back to the exact dispatching session
                        // rather than being consumed first-come by any coordinator idle on
                        // this daemon (see attachMeshAssignment's coordinatorSessionId).
                        ...(typeof meshContext.coordinatorSessionId === 'string' && meshContext.coordinatorSessionId ? { coordinatorSessionId: meshContext.coordinatorSessionId } : {}),
                    });
                } catch { /* best-effort — stamping is a routing aid, not a hard requirement */ }
                // DOUBLE-DISPATCH stamp guard: the instance manager refused this stamp because
                // the SAME task is already running on another live session on this daemon.
                // Sending the prompt anyway would double-execute the task — fail closed so the
                // coordinator does not duplicate the work onto a second session.
                if (stampResult && stampResult.stamped === false && stampResult.reason === 'task_already_stamped_on_live_instance') {
                    // DUP-CLAIM-REBIND: this refusal is an APPLICATION-LEVEL answer, not a
                    // transport failure — the work IS running here, on the session named
                    // below. Throw the typed error so the coordinator can rebind its turn
                    // ledger onto the real holder instead of cancelling the attempt (which
                    // made the holder's genuine completion get rejected as session_mismatch
                    // and lost a finished task). The guard already resolved the holder, so
                    // it rides along as a field — never something the caller has to parse
                    // back out of this message.
                    throw new DuplicateMeshDispatchError(
                        `Refusing duplicate mesh dispatch: task ${meshContext.taskId} is already being worked by a live session on this daemon`,
                        { holderSessionId: stampResult.holderSessionId },
                    );
                }
                // COORDINATOR-SILENT-IDLE (opt-in): the coordinator's mesh policy is
                // 'auto_silent_on_dispatch', so arm a ONE-SHOT transient mute on THIS
                // worker session for the single completion that follows this dispatch.
                // resolveMuted honors it only for an idle snapshot within
                // SILENT_IDLE_PUSH_TTL_MS, so the routine completion push is suppressed
                // while approval/failure/long-running notifications (non-idle status) and
                // a worker that never completes (TTL expiry) are unaffected. Re-armed on
                // every dispatch (fresh armedAt) and one-shot-cleared at the completion
                // emission (emitGeneratingCompleted) so subsequent turns notify normally.
                if ((meshContext as any).silentIdlePush === true) {
                    try {
                        const workerInst = this.deps.getInstanceManager()?.getInstance(targetInstanceId);
                        if (workerInst && typeof workerInst.updateSettings === 'function') {
                            workerInst.updateSettings({
                                silentNextIdlePush: true,
                                silentNextIdlePushArmedAt: Date.now(),
                            });
                        }
                    } catch { /* best-effort — silent-idle is a notification nicety, never fail the dispatch */ }
                }
            }
            const input = normalizeInputEnvelope(args?.input ? { input: args.input } : args);
            const provider = this.providerLoader.resolve(agentType) || this.providerLoader.getMeta(agentType);
            // MESH-IMAGE-DISPATCH: a mesh dispatch carrying non-text parts (an image
            // from the coordinator or dashboard) must reach the provider instance as
            // STRUCTURED input, exactly as the dashboard path already does — see
            // chat-commands-write.ts, whose PTY branch routes structured parts through
            // `instance.onEvent('send_message', { input })` so provider-specific
            // attachment strategies apply.
            //
            // Before this change every non-ACP send took `assertTextOnlyInput` (a hard
            // throw on any image part) and then collapsed to `input.textFallback`, so a
            // mesh image was rejected outright while the SAME provider on the SAME
            // daemon accepted it from the dashboard. That asymmetry — not a missing
            // capability — was the whole defect. Capability is still enforced, but by
            // the provider's own declaration rather than a blanket text-only rule.
            const hasStructuredParts = input.parts.some((part) => part.type !== 'text');
            if (hasStructuredParts) {
                // Refuses with a clear provider-named error when the provider does not
                // declare the media type (opencode and every ACP provider are text-only),
                // so an unsupported dispatch fails loudly instead of silently dropping
                // the image and sending a prompt that references a picture nobody got.
                assertProviderSupportsDeclaredInput(provider, input);
            } else if (provider?.category === 'acp') {
                assertProviderSupportsDeclaredInput(provider, input);
            } else {
                assertTextOnlyInput(provider, input);
            }
            const message = input.textFallback;
            // A multipart send is legitimately allowed to carry no text (an image on its
            // own); only the text-only path still requires a non-empty message.
            if (!message && !hasStructuredParts) throw new Error('message required for send_chat');
            // ARCH-REFACTOR R1: thread the dispatched task's id into the turn so the
            // worker's completion event is bound to THIS task (per-turn identity),
            // not the last-write-wins session scalar. Carried for both local and
            // remote (P2P-echoed meshContext) dispatch; absent for plain ad-hoc chat.
            const meshTaskId = (meshContext && typeof meshContext === 'object'
                && typeof (meshContext as any).taskId === 'string' && (meshContext as any).taskId.trim())
                ? (meshContext as any).taskId as string
                : undefined;
            const forceSend = args?.force === true || args?.forceSend === true;
            // DISPATCH-SOURCE-TRACE: every agent_command send_chat issuer tags its
            // call site (args.dispatchSource) so a duplicate/unexpected inject can
            // be attributed from the daemon log WITHOUT timing inference. Logged
            // before the idempotency guard so suppressed duplicates are traced too.
            // 'untagged' itself is a signal: an issuer this change did not cover.
            const dispatchSource = typeof (args as any)?.dispatchSource === 'string' && (args as any).dispatchSource.trim()
                ? (args as any).dispatchSource.trim() : 'untagged';
            LOG.info('MeshDispatch', `agent_command send_chat on session ${key}${meshTaskId ? ` task=${meshTaskId}` : ''} dispatchSource=${dispatchSource}`);
            // PTY-SUBMIT-IDEMPOTENCY: run the duplicate-submission guard BEFORE the
            // adapter write — this is the last funnel before the PTY. forceSend is an
            // explicit operator/coordinator override and bypasses the guard.
            let submissionGuardKey: string | null = null;
            if (meshTaskId && !forceSend) {
                // MESH-IMAGE-DISPATCH: hash the FULL input envelope for a multipart
                // send. `message` is the text fallback, which is empty for an
                // image-only dispatch — hashing it alone would make two different
                // images within one task collide and silently suppress the second as
                // a duplicate. buildSendInputSignature covers text + every part, and
                // is the same signature the dashboard dedup path uses.
                const guardContent = hasStructuredParts ? buildSendInputSignature(input) : message;
                submissionGuardKey = this.beginMeshDispatchSubmission(key, meshTaskId, guardContent);
                if (submissionGuardKey === null) {
                    LOG.warn('MeshDispatch', `Suppressed duplicate PTY submission on session ${key}: task ${meshTaskId} with identical content was already submitted within the last ${Math.round(MESH_DISPATCH_SUBMIT_DEDUP_WINDOW_MS / 1000)}s — the prompt is already sent/buffered on this session, not re-injecting`);
                    return {
                        success: true,
                        status: BUSY_AGENT_STATUSES.has(currentStatus) ? currentStatus : 'generating',
                        duplicateSuppressed: true,
                    };
                }
            }
            // Preserve the exact prior call shape when there is no taskId (plain
            // ad-hoc chat / non-mesh dispatch); only thread the per-turn taskId when
            // present, so existing non-mesh callers and their contracts are unchanged.
            let interruptRequeued = false;
            // MESH-SEND-ACK-ASYMMETRY: a multipart dispatch that is merely ACCEPTED
            // into the driver FIFO must not be reported with the same shape as a
            // real PTY submit — same distinction handleSendChat draws for the
            // dashboard path.
            let structuredQueued = false;
            try {
                if (hasStructuredParts) {
                    // MESH-IMAGE-DISPATCH: multipart input goes to the provider INSTANCE
                    // rather than the adapter, so provider-specific attachment strategies
                    // (e.g. Hermes' file-path image prompt) run instead of the envelope
                    // being flattened to text. Same call the dashboard PTY path makes.
                    //
                    // Deliberately placed HERE, after DISPATCH-SOURCE-TRACE and the
                    // PTY-SUBMIT-IDEMPOTENCY guard: an image dispatch must be
                    // duplicate-suppressed on redelivery exactly like a text one, and
                    // returning earlier would have bypassed both.
                    const structuredTarget = this.deps.getInstanceManager()?.getInstance(key) as
                        | { onEvent?: (event: string, payload: unknown) => void | Promise<ProviderSendMessageResult> }
                        | undefined;
                    if (!structuredTarget || typeof structuredTarget.onEvent !== 'function') {
                        throw new Error(`No provider instance for session '${key}' — cannot deliver multipart input for agent '${agentType}'`);
                    }
                    // MESH-SEND-ACK-ASYMMETRY: AWAIT the send and check its outcome.
                    // This call was previously fire-and-forget, so an asynchronous
                    // delivery failure (dead PTY, modal hold, adapter reject) still
                    // fell through to the ack bubble below and returned
                    // `success: true` — the exact inverse of the defect b6c2444da
                    // fixed on the dashboard funnel, where the body was delivered
                    // but never recorded. Throwing here routes into the catch that
                    // releases the idempotency guard key, so a redrive is not
                    // suppressed as a duplicate.
                    const outcome = await structuredTarget.onEvent('send_message', { input });
                    if (!outcome?.success) {
                        throw new Error(outcome?.error || 'CLI send was not acknowledged');
                    }
                    structuredQueued = outcome.status === 'queued';
                } else if (forceSend) {
                    // SEND-NOW: `force` no longer means "write into the
                    // generating PTY" — that path was retired in oss
                    // 6cca365b after measured data loss. It now routes
                    // through the supported sequence: press the
                    // provider's own stop key, wait for busy→idle, then
                    // deliver as a genuine new turn.
                    const outcome = await interruptAndDeliver(
                        adapter as unknown as InterruptibleAdapter,
                        message,
                        meshTaskId ? { meshTaskId } : undefined,
                    );
                    if (!outcome.ok) throw new Error(outcome.message);
                    // An interrupt can still end with the body parked in
                    // the driver FIFO (the session re-entered busy between
                    // the idle observation and the write). Report that
                    // instead of the blanket `queued: false` the retired
                    // force path used to claim.
                    interruptRequeued = outcome.queued;
                } else if (meshTaskId) {
                    await adapter.sendMessage(message, { meshTaskId });
                } else {
                    await adapter.sendMessage(message);
                }
            } catch (e) {
                // PTY-SUBMIT-IDEMPOTENCY: the submit never landed — release the guard
                // key so the requeue/redrive retry of this dispatch is NOT suppressed
                // as a duplicate (a legitimate resend after a failure must go through).
                if (submissionGuardKey) this.meshDispatchSubmissions.delete(submissionGuardKey);
                throw e;
            }
            const targetInstance = this.deps.getInstanceManager()?.getInstance(key) as
                | { recordAcknowledgedUserInput?: (input: unknown) => void }
                | undefined;
            targetInstance?.recordAcknowledgedUserInput?.(input);
            return {
                success: true,
                status: BUSY_AGENT_STATUSES.has(currentStatus) ? currentStatus : 'generating',
                ...(BUSY_AGENT_STATUSES.has(currentStatus) ? { queued: true, queuedReason: 'agent_runtime_busy' } : {}),
                // MESH-SEND-ACK-ASYMMETRY: the driver parked the body in its
                // in-memory FIFO rather than writing it to the PTY. That is an
                // authoritative post-send signal and outranks the pre-send status
                // guess above — it can be true even when `currentStatus` read idle,
                // in which case the branch above contributed nothing. A parked body
                // does not survive a driver shutdown or daemon restart, so it must
                // never be advertised as submitted.
                ...(structuredQueued
                    ? { queued: true, queuedReason: 'driver_fifo_parked', sent: false, submitted: false }
                    : {}),
                ...(forceSend ? { forceSent: true, interrupted: true, queued: interruptRequeued } : {}),
            };
        } else if (action === 'clear_history') {
            if (typeof adapter.clearHistory === 'function') adapter.clearHistory();
            return { success: true, cleared: true };
        } else if (action === 'stop') {
            // CANCEL-STOP-TASK-SCOPE: a stop carrying meshContext.taskId is scoped to
            // THAT task (mesh_queue_cancel's in-flight halt). stopSession is a HARD
            // stop that removes the whole instance, and sessions are reused — so
            // before killing, confirm this session is actually running the cancelled
            // task. A stale 'assigned' queue row previously let a cancel of task1 kill
            // a session that had since moved on to task2, destroying unrelated work.
            // Unscoped stops (no taskId) and sessions with no resolvable task identity
            // are unaffected; see mesh-stop-task-scope.ts for why those fail open.
            const stopScopeTaskId = (() => {
                const mc = (args as any)?.meshContext;
                return mc && typeof mc === 'object' && typeof mc.taskId === 'string' ? mc.taskId.trim() : '';
            })();
            const stopScope = evaluateMeshStopTaskScope({
                requestedTaskId: stopScopeTaskId || undefined,
                currentTurnTaskId: (adapter as CliAdapterWithTurnTaskId).currentTurnTaskId,
                meshActiveTaskId: (this.deps.getInstanceManager()?.getInstance(key) as
                    { getState?: () => { settings?: Record<string, unknown> } } | undefined)
                    ?.getState?.()?.settings?.meshActiveTaskId,
            });
            if (!stopScope.allowed) {
                LOG.warn('MeshDispatch', `Refusing task-scoped stop on session ${key}: cancel targets task ${stopScopeTaskId} but the session is running task ${stopScope.sessionTaskId} — not killing unrelated work`);
                return {
                    success: false,
                    stopped: false,
                    reason: 'stop_task_mismatch',
                    requestedTaskId: stopScopeTaskId,
                    sessionTaskId: stopScope.sessionTaskId,
                    error: `Session '${key}' is running task ${stopScope.sessionTaskId}, not the cancelled task ${stopScopeTaskId} — stop refused to avoid killing unrelated work`,
                };
            }
            await this.stopSession(key);
            return { success: true, stopped: true, ...(stopScopeTaskId ? { stoppedTaskId: stopScopeTaskId, stopScope: stopScope.reason } : {}) };
        } else if (action === 'interrupt_capability') {
            // Read-only probe: can this session's turn be interrupted? Resolved
            // from the provider's OWN loaded spec, so the answer tracks whichever
            // spec version this session actually booted with. Writes nothing.
            const probe = adapter as unknown as {
                getInterruptCapability?: () => { supported: boolean; keyName?: string; confidence?: string; message?: string; reason?: string };
            };
            if (typeof probe.getInterruptCapability !== 'function') {
                return {
                    success: true,
                    supported: false,
                    reason: 'interrupt_not_implemented',
                    message: `Provider '${agentType}' runs on an adapter with no interrupt support.`,
                };
            }
            const cap = probe.getInterruptCapability();
            return { success: true, ...cap };
        } else if (action === 'interrupt_turn') {
            // Abort the TURN in flight — deliberately distinct from action 'stop'
            // above, which terminates the whole session. Delivery mode 'interrupt'
            // uses this to clear the way for a re-dispatch: the running turn is
            // cancelled and lost, the session survives and returns to idle, and the
            // ordinary queued-send drain then delivers the new prompt as a real turn.
            //
            // Capability is validated inside interruptTurn() against the provider's
            // OWN resolved spec before any byte is written, so a provider with no
            // stop key (or an empty one, e.g. hermes-cli specs/4.0.json) returns
            // ok:false instead of writing nothing and reporting success.
            const interruptible = adapter as unknown as {
                interruptTurn?: () => Promise<
                    | { ok: true; keyName: string; bytes: number; confidence: string }
                    | { ok: false; reason: string; message: string }
                >;
            };
            if (typeof interruptible.interruptTurn !== 'function') {
                return {
                    success: false,
                    interrupted: false,
                    reason: 'interrupt_not_implemented',
                    error: `Provider '${agentType}' runs on an adapter that cannot interrupt a turn.`,
                };
            }
            const outcome = await interruptible.interruptTurn();
            if (!outcome.ok) {
                return { success: false, interrupted: false, reason: outcome.reason, error: outcome.message };
            }
            return {
                success: true,
                interrupted: true,
                keyName: outcome.keyName,
                bytes: outcome.bytes,
                confidence: outcome.confidence,
            };
        }
        throw new Error(`Unknown action: ${action}`);
    }
}
