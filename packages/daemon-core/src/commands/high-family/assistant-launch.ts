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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { LOG } from '../../logging/logger.js';
import { getConfigDir } from '../../config/config.js';
import { defineCommandSpecs } from '../command-registry.js';
import { componentsNotReadyResult, isDaemonComponentsNotReady } from '../daemon-components-port.js';
import type { CommandRouterResult } from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
import { ASSISTANT_TOOL_SOURCES, readAssistantSessionId } from './assistant-store.js';
import { ASSISTANT_PROJECTS_SOURCES } from './assistant.js';
import { resolveMeshCoordinatorSetup } from '../mesh-coordinator.js';
import {
    buildMeshCoordinatorMcpServerEntry, getMcpServersKey, isSupportedMeshCoordinatorConfigFormat,
    parseMeshCoordinatorMcpConfig, serializeMeshCoordinatorMcpConfig,
} from '../../mesh/mesh-coordinator-config.js';
import { materializePrivateHome } from '../../mesh/worker-private-home.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import { buildAssistantSystemPrompt, type AssistantPromptProject } from '../../assistant/assistant-prompt.js';
import { getAssistantProjectPorts } from '../../assistant/assistant-project-ports.js';
import { projectSlugs } from '../../assistant/assistant-projects.js';
import { isUnmanagedRepoIdentity, meshHostLabel } from '../../assistant/project-views.js';
import {
    DEFAULT_ASSISTANT_CLI_TYPE, assistantSessionSettings, assistantWorkspaceDir, planAssistantMcp,
    resolveAssistantApprovalSettings, type AssistantMcpConfigWrite,
} from '../../assistant/assistant-launch-plan.js';

/** `launch_assistant` is also the dashboard's assistant tab entry (§4.4). */
export const LAUNCH_ASSISTANT_SOURCES = ASSISTANT_PROJECTS_SOURCES;

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function fail(code: string, error: string = code, extra: Record<string, unknown> = {}): CommandRouterResult {
    return { success: false, code, error, ...extra };
}

/** Merge the assistant server into the (daemon-owned) MCP config file. */
function writeAssistantMcpConfig(w: AssistantMcpConfigWrite): void {
    if (!isSupportedMeshCoordinatorConfigFormat(w.format)) throw new Error(`unsupported MCP config format: ${w.format}`);
    mkdirSync(dirname(w.path), { recursive: true });
    const before = existsSync(w.path) ? readFileSync(w.path, 'utf-8') : '';
    const parsed = before ? parseMeshCoordinatorMcpConfig(before, w.format) : {};
    const key = getMcpServersKey(w.format);
    const servers = parsed[key] && typeof parsed[key] === 'object' && !Array.isArray(parsed[key]) ? parsed[key] : {};
    const next = serializeMeshCoordinatorMcpConfig({
        ...parsed,
        [key]: { ...servers, [w.serverName]: buildMeshCoordinatorMcpServerEntry(w.format, w.server) },
    }, w.format);
    if (next !== before) writeFileSync(w.path, next, { encoding: 'utf-8', mode: 0o600 });
}

/** The launch-time project table (hosted here / elsewhere / unmanaged). */
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
            hosting: unmanaged ? 'unmanaged' : here ? 'here' : 'elsewhere',
            ...(!unmanaged && !here ? { hostLabel: meshHostLabel(mesh, selfDaemonId) } : {}),
        };
    });
}

/** Strip / delete the files a file-based injection wrote, once the CLI has read them (same timing as the coordinator). */
function scheduleInjectionCleanup(effect: { contextFilePath?: string; contextFileOwned?: boolean; agentFilePath?: string }): void {
    if (!effect.contextFilePath && !effect.agentFilePath) return;
    const t = setTimeout(() => {
        void import('../mesh-coordinator.js').then(({ stripCoordinatorWrapperFile, cleanupCoordinatorAgentFile }) => {
            if (effect.contextFilePath) stripCoordinatorWrapperFile(effect.contextFilePath, effect.contextFileOwned === true);
            if (effect.agentFilePath) cleanupCoordinatorAgentFile(effect.agentFilePath);
        }).catch(() => { /* best-effort */ });
    }, 5000);
    (t as { unref?: () => void }).unref?.();
}

const launchAssistant: HighFamilyHandler = async (ctx, args) => {
    const registry = getAssistantRegistry();
    const entry = registry.read();
    const { getAssistantRuntime } = await import('../../assistant/assistant-runtime.js');
    const runtime = getAssistantRuntime();
    if (entry?.sessionId && ctx.deps.instanceManager.getInstance(entry.sessionId)) {
        runtime?.activate('launch');
        return { success: true, launched: false, sessionId: entry.sessionId, cliType: entry.cliType, workspace: entry.workspace };
    }

    let cliType = str(args?.cliType) || entry?.cliType || DEFAULT_ASSISTANT_CLI_TYPE;
    cliType = ctx.deps.providerLoader.resolveAlias?.(cliType, ['cli']) || cliType;
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
    const svc = getAssistantServices();
    const prompt = buildAssistantSystemPrompt({ projects, memory: svc.memory.read(), skills: svc.skills.list(), frozenAt: new Date() });
    if (!prompt.withinLimit) return fail('assistant_prompt_too_long', `assistant prompt is ${prompt.length} chars`, { cliType });

    try {
        mkdirSync(workspace, { recursive: true, mode: 0o700 });
    } catch (e) {
        return fail('assistant_config_write_failed', `could not prepare the assistant workspace: ${(e as Error)?.message ?? e}`, { cliType, workspace });
    }
    if (mcp.privateHome) {
        // Home-rooted CLI (antigravity): the worker private-HOME mechanism at a
        // stable per-assistant dir, re-prepared every launch. Fail closed — a
        // launch without it would read (and need a write to) the person's
        // global MCP config.
        try {
            mkdirSync(dirname(mcp.privateHome.dir), { recursive: true, mode: 0o700 });
            const prepared = materializePrivateHome(mcp.privateHome.spec, { home: mcp.privateHome.dir, workspace });
            if (prepared.failed.length) LOG.warn('Assistant', `[${cliType}] private HOME imports failed: ${prepared.failed.join(', ')}`);
        } catch (e) {
            return fail('assistant_private_home_failed', `could not prepare the assistant's private HOME: ${(e as Error)?.message ?? e}`, { cliType, workspace });
        }
    }
    try {
        if (mcp.configWrite) writeAssistantMcpConfig(mcp.configWrite);
    } catch (e) {
        return fail('assistant_config_write_failed', `could not prepare the assistant MCP config: ${(e as Error)?.message ?? e}`, { cliType, workspace });
    }

    const cliArgs: string[] = [];
    // The private HOME env first; the prompt injection may add its own keys.
    const launchEnv: Record<string, string> = { ...(mcp.privateHome?.env ?? {}) };
    const { applyMeshCoordinatorSystemPromptInjection } = await import('../mesh-coordinator.js');
    const injection = applyMeshCoordinatorSystemPromptInjection(prompt.text, provider?.meshCoordinator?.systemPromptInjection, { cliArgs, launchEnv, workspace, cliType });
    if (injection.error) return fail(injection.errorCode ?? 'assistant_prompt_failed', injection.error, { cliType, workspace });
    // Provider-declared MCP launch args (e.g. cursor --approve-mcps), then the assistant's own.
    const providerLaunchArgs = provider?.meshCoordinator?.launchArgs;
    if (Array.isArray(providerLaunchArgs)) cliArgs.push(...providerLaunchArgs.filter((a: unknown): a is string => typeof a === 'string' && !!a.trim()));
    cliArgs.push(...mcp.cliArgs);

    const model = str(args?.model);
    const thinkingLevel = str(args?.thinkingLevel);
    const launched: any = await ctx.execute('launch_cli', {
        cliType,
        dir: workspace,
        cliArgs: cliArgs.length ? cliArgs : undefined,
        env: Object.keys(launchEnv).length ? launchEnv : undefined,
        settings: assistantSessionSettings(approval.settings),
        assistantSessionKey,
        ...(model ? { initialModel: model, modelSource: 'user' } : {}),
        ...(thinkingLevel ? { initialThinkingLevel: thinkingLevel, thinkingLevelSource: 'user' } : {}),
        launchedBy: 'assistant',
    }, 'ipc', { inProcess: true });
    if (launched?.success) scheduleInjectionCleanup(injection);
    const sessionId = str(launched?.sessionId) || str(launched?.id);
    if (!launched?.success || !sessionId) {
        return fail(str(launched?.code) || 'assistant_launch_failed', str(launched?.error) || 'Failed to launch the assistant session', { cliType, workspace });
    }

    const { previous } = registry.bindSession({
        sessionId, cliType, workspace, ...(mcp.configWrite ? { mcpConfigPath: mcp.configWrite.path } : {}), at: Date.now(),
    });
    runtime?.activate('launch');
    const restartNote = runtime ? runtime.relay.armRestartNote({ previous }, sessionId) : false;
    LOG.info('Assistant', `Launched ${cliType} assistant ${sessionId} in ${workspace} (prompt ${prompt.length} chars${restartNote ? ', restart note queued' : ''})`);
    return { success: true, launched: true, sessionId, cliType, workspace, promptLength: prompt.length, restartNote };
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
