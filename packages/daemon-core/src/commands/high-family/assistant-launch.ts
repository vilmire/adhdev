import { AssistantLaunchFence, registerAssistantLaunchFence, retireAssistantLaunchFence } from '../../assistant/assistant-launch-fence.js';
import { acquireOwnedLock } from '../../launch-defaults/owned-lock.js';
import { admitAssistantLaunch } from '../../assistant/assistant-launch-admission.js';
import { resolveRoleLaunch, roleLaunchFailure, roleLaunchProvenance } from '../../launch-defaults/consumer.js';
import { assistantExecution } from '../../assistant/assistant-execution.js';
/**
 * Assistant session verbs (design docs/design/2026-10-07-assistant-layer.md
 * §4.4 "데몬 verb", §4.5): `launch_assistant` and `assistant_pending_relays`.
 *
 * `launch_assistant {cliType?, model?, thinkingLevel?, autoApproveMode?}` is
 * idempotent: a live bound assistant session is returned as is. Otherwise, in
 * order: provider + MCP setup with the `{kind:'assistant'}` toolset
 * (assistant/assistant-launch-plan.ts) → the frozen system prompt
 * (`buildAssistantSystemPrompt`: rules, project table, memory snapshot, skill
 * index, safety tail) injected through the coordinator's prompt-agnostic
 * `applyMeshCoordinatorSystemPromptInjection` (oversize fallbacks included) →
 * (a home-rooted CLI first gets its private HOME materialized, see
 * `AssistantPrivateHome`) → `launch_cli` in `<configDir>/assistant/` with `settings {assistant:true,
 * <approval>}` (`launch_cli` stamps `ADHDEV_ASSISTANT_SESSION_ID`) →
 * `AssistantRegistry.bindSession` → `relay.armRestartNote(previous)`. The
 * session id is minted HERE, before planning, and handed to `launch_cli` as
 * `assistantSessionKey`: the MCP server entry (config file `env` / codex
 * `-c mcp_servers.*.env.*`) must carry it, and the config is written before
 * the spawn. Binding (and the restart note, which the relay holds until the
 * new session is ready) still follows a successful launch.
 *
 * `assistant_pending_relays` is the MCP-only pull (§4.5): it claims queued
 * relay rows / signals and returns `{success:true, assistantEvents}`. While a
 * PTY assistant is live it serves only that session's own MCP server
 * (`assistantSessionId` must match — the NOTICE-THEFT rule).
 *
 * Sources (pinned by test/commands/assistant-store-sources.test.ts):
 * `launch_assistant` ipc/standalone/p2p/ws (dashboard), `assistant_pending_relays`
 * ipc/standalone. Neither accepts `mesh`.
 */

import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { LOG } from '../../logging/logger.js';
import { getConfigDir } from '../../config/config.js';
import { defineCommandSpecs } from '../command-registry.js';
import { isTrustedOwnerIngress } from '../command-args.js';
import { componentsNotReadyResult, isDaemonComponentsNotReady } from '../daemon-components-port.js';
import type { CommandRouterResult } from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
import { ASSISTANT_TOOL_SOURCES, readAssistantSessionId } from './assistant-store.js';
import { ASSISTANT_PROJECTS_SOURCES } from './assistant.js';
import { resolveMeshCoordinatorSetup } from '../mesh-coordinator.js';
import { materializePrivateHome } from '../../mesh/worker-private-home.js';
import {
    ensurePrivateAssistantDirectoryChain,
    ensurePrivateAssistantWorkspace,
    writeAssistantMcpConfig,
} from '../../assistant/assistant-config-io.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import { buildAssistantSystemPrompt, type AssistantPromptProject } from '../../assistant/assistant-prompt.js';
import { getAssistantProjectPorts } from '../../assistant/assistant-project-ports.js';
import { projectSlugs } from '../../assistant/assistant-projects.js';
import { isUnmanagedRepoIdentity, meshHostLabel } from '../../assistant/project-views.js';
import {
    assistantSessionSettings, assistantWorkspaceDir, planAssistantMcp,
    resolveAssistantApprovalSettings,
} from '../../assistant/assistant-launch-plan.js';

/** `launch_assistant` is also the dashboard's assistant tab entry (§4.4). */
export const LAUNCH_ASSISTANT_SOURCES = ASSISTANT_PROJECTS_SOURCES;

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function fail(code: string, error: string = code, extra: Record<string, unknown> = {}): CommandRouterResult {
    return { success: false, code, error, ...extra };
}

/** The launch-time project table (hosted here / on another machine, relayed / unmanaged). */
async function promptProjects(ctx: HighFamilyContext): Promise<AssistantPromptProject[]> {
    const selfDaemonId = str(ctx.deps?.statusInstanceId);
    const ports = await getAssistantProjectPorts({
        components: ctx.components,
        execute: (cmd, a) => ctx.execute(cmd, a, 'ipc', { inProcess: true }),
        selfDaemonId,
    });
    const meshes = ports.listMeshes();
    const slugs = projectSlugs(meshes);
    return meshes.map((mesh) => {
        const unmanaged = isUnmanagedRepoIdentity(mesh.repoIdentity);
        const here = !unmanaged && ports.isHostedHere(mesh);
        return {
            slug: slugs.get(mesh.id) ?? mesh.id,
            meshId: mesh.id,
            ...(mesh.name ? { name: mesh.name } : {}),
            ...(mesh.repoIdentity ? { repoIdentity: mesh.repoIdentity } : {}),
            hosting: unmanaged ? 'unmanaged' : here ? 'here' : 'remote',
            ...(!unmanaged && !here ? { hostLabel: meshHostLabel(mesh, selfDaemonId) } : {}),
        };
    });
}

async function queuePreviousSessionNote(
    ctx: Parameters<HighFamilyHandler>[0],
    runtime: { relay: { enqueueInput(input: { source: 'previous_session'; text: string; messageId: string; forSessionId?: string }): void } },
    prevSid: string,
    sessionId: string,
): Promise<void> {
    try {
        // Saved while the previous session was alive (runtime 'assistant.context').
        const saved = getAssistantRegistry().read()?.lastContext;
        if (saved && saved.sessionId === prevSid) {
            LOG.info('Assistant', `previous-session context: saved snapshot from ${prevSid}; note queued`);
            runtime.relay.enqueueInput({ source: 'previous_session', text: saved.text, messageId: `prevctx:${sessionId}`, forSessionId: sessionId });
            return;
        }
        const chat = await ctx.execute('read_chat', { targetSessionId: prevSid, limit: 40 }, 'ipc', { inProcess: true });
        const { compactTranscriptTail } = await import('../../assistant/project-views.js');
        const { buildPreviousSessionNote } = await import('../../assistant/assistant-relay-format.js');
        const tail = compactTranscriptTail((chat ?? {}) as Record<string, unknown>, 20, 2000);
        const messages = (Array.isArray(tail.messages) ? tail.messages : []) as Array<{ role: 'user' | 'assistant'; text: string }>;
        const text = buildPreviousSessionNote(messages);
        LOG.info('Assistant', `previous-session context: ${messages.length} message(s) read from ${prevSid}; ${text ? 'note queued' : 'nothing from the owner to carry over'}`);
        if (!text) return;
        runtime.relay.enqueueInput({ source: 'previous_session', text, messageId: `prevctx:${sessionId}`, forSessionId: sessionId });
    } catch (e) {
        LOG.warn('Assistant', `previous-session context unavailable for ${prevSid}: ${(e as Error)?.message ?? e}`);
    }
}

const ASSISTANT_LAUNCH_TIMEOUT_MS = 30_000;

const launchAssistantOnce = async (
    ctx: HighFamilyContext,
    args: any,
    fence: AssistantLaunchFence,
): Promise<CommandRouterResult> => {
    const registry = getAssistantRegistry();
    const admission = await admitAssistantLaunch(ctx, args, () => fence.aborted);
    if (fence.aborted) return fail('assistant_launch_timeout');
    if (admission) {
        if (admission.success) {
            const { getAssistantRuntime } = await import('../../assistant/assistant-runtime.js');
            getAssistantRuntime()?.activate('launch');
        }
        return admission;
    }
    const entry = registry.read();
    const { getAssistantRuntime } = await import('../../assistant/assistant-runtime.js');
    const runtime = getAssistantRuntime();

    const resolved = resolveRoleLaunch(ctx, 'assistant', {
        ...(args?.cliType !== undefined ? { provider: args.cliType } : {}),
        ...(args?.model !== undefined ? { model: args.model } : {}),
        ...(args?.thinkingLevel !== undefined ? { thinkingLevel: args.thinkingLevel } : {}),
    });
    if (!resolved.ok) return roleLaunchFailure(resolved);
    const { provider: cliType, model, thinkingLevel } = resolved.selection;
    const provenance = roleLaunchProvenance('assistant', resolved);
    const provider = ctx.deps.providerLoader.resolve?.(cliType) || ctx.deps.providerLoader.getMeta(cliType);
    const configDir = getConfigDir();
    const workspace = assistantWorkspaceDir(configDir);
    const setup = resolveMeshCoordinatorSetup({ provider, cliType, meshId: '', workspace, toolset: { kind: 'assistant' } });
    const assistantSessionKey = randomUUID();
    const mcp = planAssistantMcp({
        cliType, setup, workspace, configDir, sessionId: assistantSessionKey,
        declaredMcpConfigPath: provider?.meshCoordinator?.mcpConfig?.path,
    });
    if (!mcp.ok) return fail(mcp.code, mcp.error, { cliType });
    const approval = resolveAssistantApprovalSettings(provider, args?.autoApproveMode);
    if (!approval.ok) return fail(approval.code, approval.error, { cliType });

    let projects: AssistantPromptProject[];
    try {
        projects = await promptProjects(ctx);
    } catch (e) {
        if (isDaemonComponentsNotReady(e)) return componentsNotReadyResult(e);
        throw e;
    }
    if (fence.aborted) return fail('assistant_launch_timeout');
    if (ctx.deps.cliManager.hostedRestoreState !== 'ready') return fail('assistant_restore_pending');
    const svc = getAssistantServices();
    const prompt = buildAssistantSystemPrompt({ projects, memory: svc.memory.read(), skills: svc.skills.list(), frozenAt: new Date() });
    if (!prompt.withinLimit) return fail('assistant_prompt_too_long', `assistant prompt is ${prompt.length} chars`, { cliType });

    try {
        ensurePrivateAssistantWorkspace(configDir, workspace);
    } catch (e) {
        return fail('assistant_config_write_failed', `could not prepare the assistant workspace: ${(e as Error)?.message ?? e}`, { cliType, workspace });
    }
    if (mcp.privateHome) {
        // Home-rooted CLI (antigravity): the worker private-HOME mechanism at a
        // stable per-assistant dir, re-prepared every launch. Fail closed — a
        // launch without it would read (and need a write to) the person's
        // global MCP config.
        try {
            ensurePrivateAssistantDirectoryChain(configDir, dirname(mcp.privateHome.dir));
            const prepared = materializePrivateHome(mcp.privateHome.spec, { home: mcp.privateHome.dir, workspace });
            if (prepared.failed.length) LOG.warn('Assistant', `[${cliType}] private HOME imports failed: ${prepared.failed.join(', ')}`);
        } catch (e) {
            return fail('assistant_private_home_failed', `could not prepare the assistant's private HOME: ${(e as Error)?.message ?? e}`, { cliType, workspace });
        }
    }
    try {
        if (mcp.configWrite) {
            writeAssistantMcpConfig(mcp.configWrite, {
                configDir,
                workspace,
                privateHomeDir: mcp.privateHome?.dir,
            });
        }
    } catch (e) {
        return fail('assistant_config_write_failed', `could not prepare the assistant MCP config: ${(e as Error)?.message ?? e}`, { cliType, workspace });
    }

    const cliArgs: string[] = [];
    // The private HOME env and the plan's own env (claude-cli: auto memory off) first;
    // the prompt injection may add its own keys.
    const { ensureMcpSessionCredential } = await import('../mcp-command-ingress.js');
    const { ADHDEV_MCP_SESSION_CREDENTIAL_ENV } = await import('../../standalone-mcp-auth.js');
    const assistantMcpCredential = ensureMcpSessionCredential({
        sessionId: assistantSessionKey,
        isCoordinator: false,
    });
    const launchEnv: Record<string, string> = {
        ...(mcp.privateHome?.env ?? {}),
        ...(mcp.launchEnv ?? {}),
        [ADHDEV_MCP_SESSION_CREDENTIAL_ENV]: assistantMcpCredential,
    };
    const { applyMeshCoordinatorSystemPromptInjection } = await import('../mesh-coordinator.js');
    const injection = applyMeshCoordinatorSystemPromptInjection(prompt.text, provider?.meshCoordinator?.systemPromptInjection, { cliArgs, launchEnv, workspace, cliType });
    if (injection.error) return fail(injection.errorCode ?? 'assistant_prompt_failed', injection.error, { cliType, workspace });
    // Provider-declared MCP launch args (e.g. cursor --approve-mcps), then the assistant's own.
    const providerLaunchArgs = provider?.meshCoordinator?.launchArgs;
    if (Array.isArray(providerLaunchArgs)) cliArgs.push(...providerLaunchArgs.filter((a: unknown): a is string => typeof a === 'string' && !!a.trim()));
    cliArgs.push(...mcp.cliArgs);

    // Same inject-then-remove as the coordinator (coordinator-injection-cleanup.ts):
    // after the session is ready, or at once when the launch fails or throws.
    const { scheduleInjectionCleanup, localSessionReadyProbe } = await import('../coordinator-injection-cleanup.js');
    let launched: any;
    try {
        if (fence.aborted) {
            void scheduleInjectionCleanup(injection, { launched: false, label: 'assistant' });
            return fail('assistant_launch_timeout');
        }
        if (ctx.deps.cliManager.hostedRestoreState !== 'ready') {
            void scheduleInjectionCleanup(injection, { launched: false, label: 'assistant' });
            return fail('assistant_restore_pending');
        }
        registerAssistantLaunchFence(assistantSessionKey, fence);
        fence.dispatched = true;
        launched = await ctx.execute('launch_cli', {
            cliType,
            dir: workspace,
            cliArgs: cliArgs.length ? cliArgs : undefined,
            env: Object.keys(launchEnv).length ? launchEnv : undefined,
            settings: assistantSessionSettings(approval.settings),
            assistantSessionKey,
            ...(model ? { initialModel: model } : {}),
            ...(thinkingLevel ? { initialThinkingLevel: thinkingLevel } : {}),
            ...provenance,
            launchedBy: 'assistant',
        }, 'ipc', { inProcess: true });
    } catch (e) {
        void scheduleInjectionCleanup(injection, { launched: false, label: 'assistant' });
        if (!fence.spawnStarted) throw e;
        // Registration may have created a host runtime before failing. Its UUID
        // is already known; retain exclusion until cleanup confirms absence.
        fence.aborted = true;
        launched = { success: true, sessionId: assistantSessionKey };
    }
    if (fence.spawnStarted && launched?.success !== true) {
        fence.aborted = true;
        launched = { success: true, sessionId: assistantSessionKey };
    }
    const sessionId = str(launched?.sessionId) || str(launched?.id);
    void scheduleInjectionCleanup(injection, {
        launched: launched?.success === true && !!sessionId && !fence.aborted,
        isReady: localSessionReadyProbe(ctx.deps.cliManager?.adapters, sessionId),
        label: 'assistant',
    });
    const isCurrent = () => assistantGenerations.get(registry) === fence;
    // Reload before every binding mutation: an older generation (or another
    // host) must never replace or clear the session a newer launch owns.
    const mayBind = () => isCurrent() && (!registry.reload()?.sessionId || registry.read()?.sessionId === sessionId);
    if (fence.aborted || !mayBind()) {
        if (launched?.success && sessionId) {
            const retainBinding = () => {
                if (mayBind()) registry.bindSession({ sessionId, cliType, workspace,
                    hostOwner: ctx.deps.cliManager.deps.getHostedBindingOwner?.(),
                    ...(mcp.configWrite ? { mcpConfigPath: mcp.configWrite.path } : {}), at: Date.now() });
            };
            const cleanup = async (): Promise<boolean> => {
                retainBinding();
                try {
                    await ctx.deps.sessionHostControl?.stopSession(sessionId);
                    await ctx.deps.cliManager.stopSessionWithMode(sessionId, 'hard');
                    const remaining = await ctx.deps.cliManager.deps.listHostedCliRuntimes!();
                    if (remaining.some(r => r.runtimeId === sessionId)) { retainBinding(); return false; }
                    if (isCurrent() && registry.reload()?.sessionId === sessionId) registry.releaseSession(sessionId, 'assistant_launch_timeout');
                    return true;
                } catch (error) {
                    retainBinding();
                    LOG.warn('Assistant', `Timed-out assistant ${sessionId} cleanup remains pending: ${String(error)}`);
                    return false;
                }
            };
            fence.cleanupPending = !await cleanup();
            if (fence.cleanupPending) {
                let failures = assistantCleanupFailures.get(registry);
                if (!failures) { failures = new Map(); assistantCleanupFailures.set(registry, failures); }
                failures.set(sessionId, { fence, cleanup });
            }
        }
        return fail(fence.cleanupPending ? 'assistant_launch_cleanup_pending' : 'assistant_launch_timeout');
    }
    if (!launched?.success || !sessionId) {
        return fail(str(launched?.code) || 'assistant_launch_failed', str(launched?.error) || 'Failed to launch the assistant session', { cliType, workspace });
    }

    if (!mayBind()) return fail('assistant_identity_conflict');
    const instance = ctx.components().instanceManager?.getInstance?.(sessionId);
    const adapter = ctx.components().cliManager?.adapters?.get(sessionId);
    assistantExecution.attest(sessionId, instance ?? null, adapter ?? null, cliType, cliArgs, mcp.toolRestriction);
    const { previous } = registry.bindSession({
        hostOwner: ctx.deps.cliManager.deps.getHostedBindingOwner?.(),
        sessionId, cliType, workspace, ...(mcp.configWrite ? { mcpConfigPath: mcp.configWrite.path } : {}), at: Date.now(),
    });
    // A fresh process: its input log covers the whole session (review windows, §4.10.2).
    svc.inputLog.begin(sessionId);
    runtime?.activate('launch');
    const restartNote = runtime ? runtime.relay.armRestartNote({ previous }, sessionId) : false;
    // Context from the previous assistant session (its last owner requests and
    // replies). Background: a slow history read never delays the launch.
    const prevSid = previous?.sessionId ?? entry?.sessionId ?? null;
    if (runtime && prevSid && prevSid !== sessionId) void queuePreviousSessionNote(ctx, runtime, prevSid, sessionId);
    LOG.info('Assistant', `Launched ${cliType} assistant ${sessionId} in ${workspace} (prompt ${prompt.length} chars${restartNote ? ', restart note queued' : ''})`);
    return { success: true, launched: true, sessionId, cliType, workspace, promptLength: prompt.length, restartNote, ...provenance };
};

// A second start arriving during launch joins that operation. It must never
// bind over the assistant the first start is still bringing up.
const assistantStarts = new WeakMap<ReturnType<typeof getAssistantRegistry>, Promise<CommandRouterResult>>();
const assistantGenerations = new WeakMap<ReturnType<typeof getAssistantRegistry>, AssistantLaunchFence>();
const assistantStartMeta = new WeakMap<ReturnType<typeof getAssistantRegistry>, { startedAt: number; fence: AssistantLaunchFence; clear(): void }>();
const assistantCleanupFailures = new WeakMap<ReturnType<typeof getAssistantRegistry>, Map<string, { fence: AssistantLaunchFence; cleanup(): Promise<boolean> }>>();
/** An owner may request acknowledged cancellation after this ceiling. */
export const ASSISTANT_LAUNCH_LOCK_HARD_CEILING_MS = 5 * 60_000;

const launchAssistant: HighFamilyHandler = async (ctx, args) => {
    const registry = getAssistantRegistry();
    const forced = (args?.force === true || args?.replace === true) && isTrustedOwnerIngress(args);
    const failures = assistantCleanupFailures.get(registry);
    if (failures?.size) {
        if (!forced) return fail('assistant_launch_cleanup_pending');
        for (const [id, failure] of failures) {
            if (!await failure.cleanup()) return fail('assistant_launch_cleanup_pending');
            failure.fence.cleanupPending = false;
            failure.fence.onCleanupAcknowledged?.();
            failures.delete(id);
        }
    }
    let pending = assistantStarts.get(registry);
    const meta = assistantStartMeta.get(registry);
    if (pending && meta && forced && Date.now() - meta.startedAt >= ASSISTANT_LAUNCH_LOCK_HARD_CEILING_MS) {
        if (!meta.fence.cancelBeforeSpawn()) return fail('assistant_launch_cancellation_pending');
        LOG.warn('Assistant', 'owner_force cancelled a launch before spawning after the hard ceiling');
        assistantGenerations.delete(registry);
        meta.clear();
        pending = undefined;
    }
    if (pending) return pending.then(result => result.success ? { ...result, launched: false } : result);
    const lockDir = dirname(registry.path);
    try { mkdirSync(lockDir, { recursive: true, mode: 0o700 }); } catch { /* surfaced by acquireOwnedLock */ }
    const lockPath = join(lockDir, '.assistant-launch.lock');
    // Age is not proof that another daemon's dispatched launch was cancelled.
    // Reclaim only dead/reused owners; a live peer requires its own recovery.
    const lock = acquireOwnedLock(lockPath, { probePeerIdentity: true });
    if (!lock.ok) return fail(forced && lock.busy ? 'assistant_launch_cancellation_pending' : 'assistant_launch_pending', lock.reason);
    const fence = new AssistantLaunchFence();
    assistantGenerations.set(registry, fence);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
        if (timer) { clearTimeout(timer); timer = undefined; }
        lock.release();
        if (assistantStarts.get(registry) === operation) { assistantStarts.delete(registry); assistantStartMeta.delete(registry); }
    };
    fence.onCleanupAcknowledged = clear;
    assistantStartMeta.set(registry, { startedAt: Date.now(), fence, clear });
    const timeout = new Promise<CommandRouterResult>(resolve => {
        timer = setTimeout(() => {
            fence.aborted = true;
            // Before dispatch, all continuations check the fence. After dispatch,
            // neither this process nor another daemon may launch until cleanup.
            if (!fence.dispatched) clear();
            resolve(fail('assistant_launch_timeout'));
        }, ASSISTANT_LAUNCH_TIMEOUT_MS);
        timer.unref?.();
    });
    const operation = Promise.race([
        launchAssistantOnce(ctx, args, fence).finally(() => {
            retireAssistantLaunchFence(fence);
            if (!fence.cleanupPending) clear();
        }),
        timeout,
    ]);
    assistantStarts.set(registry, operation);
    void operation.catch(() => {});
    return operation;
};

const pendingRelays: HighFamilyHandler = async (ctx, args) => {
    const { getAssistantRuntime } = await import('../../assistant/assistant-runtime.js');
    const runtime = getAssistantRuntime();
    if (!runtime) return { success: true, assistantEvents: [] };
    const caller = readAssistantSessionId(args);
    const live = runtime.liveSessionId();
    if (live && caller !== live) {
        return fail('assistant_session_mismatch', 'a live assistant session owns its relays; only its own MCP server may pull them');
    }
    return { success: true, assistantEvents: await runtime.pull(caller || null) };
};

export const assistantLaunchHandlers: Record<string, HighFamilyHandler> = {
    [ASSISTANT_VERB.launch]: launchAssistant,
    [ASSISTANT_VERB.pendingRelays]: pendingRelays,
};

export const assistantLaunchSpecs = defineCommandSpecs('high', assistantLaunchHandlers, {
    [ASSISTANT_VERB.launch]: { sources: [...LAUNCH_ASSISTANT_SOURCES] },
    [ASSISTANT_VERB.pendingRelays]: { sources: [...ASSISTANT_TOOL_SOURCES] },
});
