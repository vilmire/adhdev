/**
 * RF-ROUTER HIGH family — mesh coordinator launch.
 *
 * launch_mesh_coordinator: resolve the coordinator node + workspace, gate on Mesh
 * Host ownership, resolve the provider's MCP coordinator setup (cli_command vs
 * auto-import config), register the ADHDev mesh MCP server, build + inject the
 * coordinator system prompt, launch the CLI session and record it in the
 * coordinator registry + task ledger. Extracted verbatim from
 * executeDaemonCommand — only `this.deps`/`this.inlineMeshCache` became
 * `ctx.deps`/`ctx.inlineMeshCache`.
 */
import { join as pathJoin } from 'path';
import * as fs from 'fs';
import { LOG } from '../../logging/logger.js';
import { resolveMeshHostStatus, buildMeshHostRequiredFailure } from '../../mesh/mesh-host-ownership.js';
import { registerMeshCoordinator } from '../../mesh/coordinator-registry.js';
import { partitionSessionHostRecords } from '../../session-host/runtime-surface.js';
import { createHermesManualMeshCoordinatorSetup, resolveMeshCoordinatorSetup } from '../mesh-coordinator.js';
import { normalizeMeshNodeId } from '@adhdev/mesh-shared';
import {
    readProviderPriorityFromPolicy,
    resolveProviderTypeFromPriority,
    readLiveMeshNodeWorkspace,
    getMcpServersKey,
    parseMeshCoordinatorMcpConfig,
    serializeMeshCoordinatorMcpConfig,
    loadHermesCoordinatorBaseConfig,
    stripHermesCoordinatorTempModelProviderOverrides,
    copyHermesCoordinatorCredentialFiles,
    type MeshCoordinatorConfigFormat,
} from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';

export const meshCoordinatorLaunchHandlers: Record<string, HighFamilyHandler> = {
    launch_mesh_coordinator: async (ctx: HighFamilyContext, args: any) => {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                let cliType = typeof args?.cliType === 'string' ? args.cliType.trim() : '';
                // Optional per-launch system-prompt addition. Dashboard or API
                // callers (e.g. when spawning a mesh-node-specific coordinator)
                // can pass extra context that gets appended to the rendered
                // default prompt under the "## Additional Context" section.
                // Going through buildCoordinatorSystemPrompt's userInstruction
                // means user-level override files (~/.adhdev/coordinator-prompts)
                // and this per-launch addition compose cleanly: an override
                // wins outright, but if there's no override, the default
                // prompt + the optional append.md file + this extra context
                // all stack in declared order.
                const extraSystemPrompt = typeof args?.extraSystemPrompt === 'string'
                    ? args.extraSystemPrompt.trim()
                    : '';
                if (!meshId) return { success: false, error: 'meshId required' };

                try {
                    const { buildCoordinatorSystemPrompt } = await import('../../mesh/coordinator-prompt.js');
                    const { buildMissionPromptSection } = await import('../../mesh/mesh-missions.js');
                    // M3-3: inject the active mission summary into the coordinator prompt.
                    // Best-effort — a store failure must not block coordinator launch.
                    const buildMissionSectionBestEffort = (id: string): string => {
                        try { return buildMissionPromptSection(id); } catch { return ''; }
                    };

                    // Gap1: surface recent ledger/queue activity (recent failures +
                    // queue depth) so a freshly-launched coordinator sees them
                    // without first calling mesh_task_history. All cheap local reads
                    // — no remote peer probe. Best-effort: a read failure just omits
                    // the section, never blocks launch.
                    const buildRecentActivityBestEffort = async (id: string) => {
                        try {
                            const { getLedgerSummary, readLedgerEntries } = await import('../../mesh/mesh-ledger.js');
                            const { getMeshQueueStats } = await import('../../mesh/mesh-work-queue.js');
                            const summary = getLedgerSummary(id);
                            const queue = getMeshQueueStats(id);
                            const failureEntries = readLedgerEntries(id, { kind: ['task_failed'], tail: 5 });
                            const recentFailures = failureEntries.map((e) => {
                                const p = (e.payload || {}) as Record<string, unknown>;
                                const raw = typeof p.taskSummary === 'string' ? p.taskSummary
                                    : typeof p.message === 'string' ? p.message
                                    : typeof p.error === 'string' ? p.error
                                    : '';
                                const summaryText = raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
                                return {
                                    timestamp: e.timestamp,
                                    nodeId: e.nodeId,
                                    summary: summaryText,
                                };
                            });
                            return {
                                recentFailures,
                                recentFailureCount: summary.recentFailures,
                                pendingTasks: queue.pending,
                                assignedTasks: queue.assigned,
                                stalledTasks: summary.taskStalled,
                                lastActivityAt: summary.lastActivityAt,
                            };
                        } catch { return undefined; }
                    };

                    // Gap2-A: load accumulated operating notes (provider-neutral
                    // lessons) from the ledger so they ride into the prompt. Newest
                    // last; cap to the most recent 20 so the section stays lean.
                    // Best-effort: a read failure just omits the section.
                    const buildOperatingNotesBestEffort = async (id: string) => {
                        try {
                            const { readLedgerEntries } = await import('../../mesh/mesh-ledger.js');
                            const noteEntries = readLedgerEntries(id, { kind: ['coordinator_operating_note'], tail: 20 });
                            const notes = noteEntries
                                .map((e) => {
                                    const p = (e.payload || {}) as Record<string, unknown>;
                                    const text = typeof p.text === 'string' ? p.text.trim() : '';
                                    if (!text) return null;
                                    const category: 'provider_quirk' | 'pattern_to_avoid' | 'recovery_lesson' | undefined =
                                        p.category === 'provider_quirk' || p.category === 'pattern_to_avoid' || p.category === 'recovery_lesson'
                                            ? p.category
                                            : undefined;
                                    return {
                                        text,
                                        category,
                                        createdAt: typeof p.createdAt === 'string' ? p.createdAt : e.timestamp,
                                        sourceCoordinator: typeof p.sourceCoordinator === 'string' ? p.sourceCoordinator : undefined,
                                    };
                                })
                                .filter((n): n is NonNullable<typeof n> => n !== null);
                            return notes.length ? notes : undefined;
                        } catch { return undefined; }
                    };

                    // Support inline mesh data from cloud (bypasses local meshes.json lookup)
                    let mesh: any;
                    if (args?.inlineMesh && typeof args.inlineMesh === 'object') {
                        mesh = args.inlineMesh;
                        // Cache cloud mesh so the MCP server can retrieve it via get_mesh
                        ctx.inlineMeshCache.set(meshId, mesh);
                    } else {
                        const { getMesh } = await import('../../config/mesh-config.js');
                        mesh = getMesh(meshId);
                    }
                    if (!mesh) return { success: false, error: 'Mesh not found' };
                    const meshHost = resolveMeshHostStatus(mesh);
                    if (!meshHost.canOwnCoordinator) {
                        return {
                            success: false,
                            ...buildMeshHostRequiredFailure(mesh, 'coordinator launch'),
                            meshId,
                            cliType,
                        };
                    }
                    if (!Array.isArray(mesh.nodes) || mesh.nodes.length === 0) return { success: false, error: 'No nodes in mesh' };

                    const requestedCoordinatorNodeId = typeof args?.coordinatorNodeId === 'string'
                        ? args.coordinatorNodeId.trim()
                        : '';
                    const preferredCoordinatorNodeId = requestedCoordinatorNodeId
                        || (typeof mesh.coordinator?.preferredNodeId === 'string' ? mesh.coordinator.preferredNodeId.trim() : '');
                    const coordinatorNode = preferredCoordinatorNodeId
                        ? mesh.nodes.find((node: any) => node?.id === preferredCoordinatorNodeId || node?.nodeId === preferredCoordinatorNodeId)
                        : mesh.nodes[0];
                    if (!coordinatorNode) {
                        return {
                            success: false,
                            code: 'mesh_coordinator_node_not_found',
                            error: `Coordinator node ${preferredCoordinatorNodeId} was not found in mesh`,
                            meshId,
                            cliType,
                        };
                    }
                    const sessionHostRecords = ctx.deps.sessionHostControl?.listSessions
                        ? await ctx.deps.sessionHostControl.listSessions().catch(() => [])
                        : [];
                    const liveMeshSessions = partitionSessionHostRecords(Array.isArray(sessionHostRecords) ? sessionHostRecords : []).liveRuntimes;
                    const workspace = readLiveMeshNodeWorkspace({
                        meshId,
                        nodeId: String(normalizeMeshNodeId(coordinatorNode) || preferredCoordinatorNodeId || ''),
                        liveSessionRecords: liveMeshSessions,
                        allowCoordinatorSession: true,
                    }) || (typeof coordinatorNode.workspace === 'string' ? coordinatorNode.workspace.trim() : '');
                    if (!workspace) return { success: false, error: 'Coordinator node workspace required', meshId, cliType };

                    // OPSRULES — layer the repo-shared declarative mesh config
                    // (.adhdev/mesh.json in the coordinator node workspace, else
                    // the calling cwd) UNDER the machine-local mesh entry. The
                    // merge is LOCAL-WINS and in-memory only: meshes.json on disk
                    // is never mutated. The effective mesh feeds prompt building;
                    // operating notes are merged with the runtime ledger below.
                    const { loadRepoMeshJsonConfig, applyRepoMeshConfig, mergeEffectiveOperatingNotes } =
                        await import('../../config/mesh-json-config.js');
                    const repoMeshConfigLoad = loadRepoMeshJsonConfig(workspace);
                    if (repoMeshConfigLoad.sourceType === 'invalid') {
                        LOG.warn('MeshCoordinator', `Ignoring invalid ${repoMeshConfigLoad.source} (${repoMeshConfigLoad.path || '?'}): ${repoMeshConfigLoad.error}`);
                    }
                    const effectiveMesh = applyRepoMeshConfig(mesh, repoMeshConfigLoad.config);
                    const buildEffectiveOperatingNotes = async (id: string) =>
                        mergeEffectiveOperatingNotes(repoMeshConfigLoad.config?.operatingNotes, await buildOperatingNotesBestEffort(id));
                    if (!cliType) {
                        const resolved = await resolveProviderTypeFromPriority({
                            nodeId: String(normalizeMeshNodeId(coordinatorNode) || preferredCoordinatorNodeId || 'coordinator'),
                            providerPriority: readProviderPriorityFromPolicy(coordinatorNode.policy),
                            providerLoader: ctx.deps.providerLoader,
                            onStatusChange: ctx.deps.onStatusChange,
                        });
                        if (!resolved.providerType) {
                            return {
                                success: false,
                                code: 'mesh_coordinator_provider_priority_unusable',
                                error: resolved.error || 'No usable provider found from node providerPriority',
                                meshId,
                                cliType,
                                workspace,
                            };
                        }
                        cliType = resolved.providerType;
                    }
                    const providerMeta = ctx.deps.providerLoader.resolve?.(cliType) || ctx.deps.providerLoader.getMeta(cliType);
                    const coordinatorSetup = resolveMeshCoordinatorSetup({
                        provider: providerMeta,
                        cliType,
                        meshId,
                        workspace,
                    });

                    if (coordinatorSetup.kind === 'unsupported') {
                        return {
                            success: false,
                            code: 'mesh_coordinator_unsupported',
                            error: coordinatorSetup.reason,
                            meshId,
                            cliType,
                            workspace,
                        };
                    }

                    if (coordinatorSetup.kind === 'manual') {
                        return {
                            success: false,
                            code: 'mesh_coordinator_manual_mcp_setup_required',
                            error: coordinatorSetup.instructions,
                            meshId,
                            cliType,
                            workspace,
                            meshCoordinatorSetup: coordinatorSetup,
                        };
                    }

                    // ─── CLI-command MCP registration (Codex, Gemini CLI) ───────────
                    if (coordinatorSetup.kind === 'cli_command') {
                        // Build coordinator prompt first — fail closed on errors.
                        let cliCmdSystemPrompt = '';
                        try {
                            cliCmdSystemPrompt = buildCoordinatorSystemPrompt({ mesh: effectiveMesh, coordinatorCliType: cliType, userInstruction: extraSystemPrompt || undefined, missionSection: buildMissionSectionBestEffort(mesh.id), recentActivity: await buildRecentActivityBestEffort(mesh.id), operatingNotes: await buildEffectiveOperatingNotes(mesh.id) });
                        } catch (error: any) {
                            const message = error?.message || String(error);
                            LOG.error('MeshCoordinator', `Failed to build coordinator prompt: ${message}`);
                            return {
                                success: false,
                                code: 'mesh_coordinator_prompt_failed',
                                error: `Failed to build Repo Mesh coordinator prompt: ${message}`,
                                meshId, cliType, workspace,
                            };
                        }

                        // Run the provider's MCP registration command under a
                        // PTY. Some providers (agy, future bubbletea CLIs)
                        // refuse to run without /dev/tty, so pipe-only
                        // execFileSync silently no-ops the registration and
                        // the coordinator ends up without any mcp tools. With
                        // a real PTY the registration goes through and the
                        // exit code tells us whether it actually persisted.
                        let mcpRegistrationOk = false;
                        let mcpRegistrationFailure: {
                            command: string;
                            output: string;
                            exitCode: number | null;
                            signal: number | null;
                            timedOut: boolean;
                        } | null = null;
                        try {
                            const { buildMeshCoordinatorRegistrationPlan, execUnderPty } = await import('../mesh-coordinator.js');
                            const registrationPlan = buildMeshCoordinatorRegistrationPlan(
                                cliType,
                                coordinatorSetup.serverName,
                                coordinatorSetup.command,
                            );
                            for (const step of registrationPlan) {
                                const renderedCommand = [step.command, ...step.args].join(' ');
                                LOG.info('MeshCoordinator', `Running MCP ${step.label} (pty): ${renderedCommand}`);
                                const ptyResult = await execUnderPty(step.command, step.args, { cwd: workspace, timeoutMs: 20_000 });
                                if (ptyResult.exitCode === 0 && !ptyResult.timedOut) {
                                    if (step.required) mcpRegistrationOk = true;
                                    continue;
                                }
                                LOG.warn('MeshCoordinator', `MCP ${step.label} failed exit=${ptyResult.exitCode} signal=${ptyResult.signal} timedOut=${ptyResult.timedOut} — output:\n${ptyResult.output.slice(-2000)}`);
                                if (step.required) {
                                    mcpRegistrationFailure = {
                                        command: renderedCommand,
                                        output: ptyResult.output.slice(-2000),
                                        exitCode: ptyResult.exitCode,
                                        signal: ptyResult.signal,
                                        timedOut: ptyResult.timedOut,
                                    };
                                    break;
                                }
                            }
                        } catch (error: any) {
                            LOG.warn('MeshCoordinator', `MCP registration command failed: ${error?.message || error}`);
                            mcpRegistrationFailure = {
                                command: coordinatorSetup.command,
                                output: error?.message || String(error),
                                exitCode: null,
                                signal: null,
                                timedOut: false,
                            };
                        }

                        if (!mcpRegistrationOk) {
                            return {
                                success: false,
                                code: 'mesh_coordinator_mcp_registration_failed',
                                error: `Could not register ${coordinatorSetup.serverName}; coordinator session was not launched`,
                                meshId,
                                cliType,
                                workspace,
                                registration: mcpRegistrationFailure,
                            };
                        }

                        // Codex gives repo-local .mcp.json precedence over its
                        // global `codex mcp add` registration. Refresh an
                        // existing ADHDev entry so a stale workspace command
                        // cannot shadow the registration we just verified.
                        if (cliType === 'codex-cli') {
                            const repoMcpConfigPath = pathJoin(workspace, '.mcp.json');
                            if (fs.existsSync(repoMcpConfigPath)) {
                                try {
                                    const repoMcpConfig = parseMeshCoordinatorMcpConfig(
                                        fs.readFileSync(repoMcpConfigPath, 'utf-8'),
                                        'claude_mcp_json',
                                    );
                                    const existingServers = repoMcpConfig.mcpServers;
                                    if (
                                        existingServers
                                        && typeof existingServers === 'object'
                                        && !Array.isArray(existingServers)
                                        && existingServers[coordinatorSetup.serverName]
                                    ) {
                                        fs.writeFileSync(repoMcpConfigPath, serializeMeshCoordinatorMcpConfig({
                                            ...repoMcpConfig,
                                            mcpServers: {
                                                ...existingServers,
                                                [coordinatorSetup.serverName]: coordinatorSetup.mcpServer,
                                            },
                                        }, 'claude_mcp_json'), 'utf-8');
                                        LOG.info('MeshCoordinator', `Refreshed repo-local ${repoMcpConfigPath} entry for ${coordinatorSetup.serverName}`);
                                    }
                                } catch (error: any) {
                                    return {
                                        success: false,
                                        code: 'mesh_coordinator_config_write_failed',
                                        error: `Could not refresh repo-local MCP config: ${error?.message || error}`,
                                        meshId,
                                        cliType,
                                        workspace,
                                    };
                                }
                            }
                        }

                        // Inject system prompt declaratively from provider.v1.json.
                        const cliCmdArgs: string[] = [];
                        const cliCmdEnv: Record<string, string> = {};
                        let cliCmdContextFilePath: string | undefined;
                        if (cliCmdSystemPrompt) {
                            const { applyMeshCoordinatorSystemPromptInjection } = await import('../mesh-coordinator.js');
                            const effect = applyMeshCoordinatorSystemPromptInjection(
                                cliCmdSystemPrompt,
                                providerMeta?.meshCoordinator?.systemPromptInjection,
                                { cliArgs: cliCmdArgs, launchEnv: cliCmdEnv, workspace, cliType },
                            );
                            cliCmdContextFilePath = effect.contextFilePath;
                        }

                        const cliCmdLaunch: any = await ctx.deps.cliManager.handleCliCommand('launch_cli', {
                            cliType,
                            dir: workspace,
                            cliArgs: cliCmdArgs.length > 0 ? cliCmdArgs : undefined,
                            env: Object.keys(cliCmdEnv).length > 0 ? cliCmdEnv : undefined,
                            settings: { meshCoordinatorFor: meshId },
                        });

                        // R48 inject-then-remove. Spawn was just kicked off above; agy and
                        // gemini-cli read AGENTS.md / GEMINI.md exactly once at startup and
                        // cache it for the rest of the session, so we can safely strip
                        // the wrapper from disk shortly after launch. That keeps any
                        // worker session launched into the same workspace later from
                        // picking up our wrapper block.
                        if (cliCmdLaunch?.success && cliCmdContextFilePath) {
                            const stripPath = cliCmdContextFilePath;
                            setTimeout(() => {
                                void import('../mesh-coordinator.js').then(({ stripCoordinatorWrapperFile }) => {
                                    stripCoordinatorWrapperFile(stripPath);
                                    LOG.info('MeshCoordinator', `Stripped wrapper from ${stripPath} after launch settle (cli_command)`);
                                }).catch(() => { /* best-effort */ });
                            }, 5000);
                        }

                        if (!cliCmdLaunch?.success) {
                            return { success: false, error: cliCmdLaunch?.error || 'Failed to launch CLI session' };
                        }

                        LOG.info('MeshCoordinator', `Launched ${cliType} coordinator (cli_command) for mesh ${meshId}`);
                        const cliCmdSessionId = cliCmdLaunch.sessionId || cliCmdLaunch.id;
                        if (cliCmdSessionId) {
                            const cliCmdInjectionDecl = providerMeta?.meshCoordinator?.systemPromptInjection;
                            registerMeshCoordinator({
                                meshId,
                                sessionId: cliCmdSessionId,
                                workspace,
                                startedAt: Date.now(),
                                cliType,
                                systemPrompt: cliCmdSystemPrompt || undefined,
                                extraSystemPrompt: extraSystemPrompt || undefined,
                                injection: cliCmdInjectionDecl ? {
                                    mode: cliCmdInjectionDecl.mode,
                                    target: 'flag' in cliCmdInjectionDecl ? cliCmdInjectionDecl.flag
                                        : 'name' in cliCmdInjectionDecl ? cliCmdInjectionDecl.name
                                        : 'path' in cliCmdInjectionDecl ? cliCmdInjectionDecl.path
                                        : undefined,
                                } : undefined,
                            });
                        }
                        try {
                            const { appendLedgerEntry } = await import('../../mesh/mesh-ledger.js');
                            appendLedgerEntry(meshId, {
                                kind: 'coordinator_started',
                                sessionId: cliCmdSessionId,
                                providerType: cliType,
                                payload: { workspace },
                            });
                        } catch { /* best-effort */ }

                        return {
                            success: true,
                            meshId,
                            cliType,
                            workspace,
                            sessionId: cliCmdSessionId,
                            mcpRegistered: mcpRegistrationOk,
                        };
                    }

                    const configFormat = coordinatorSetup.configFormat as MeshCoordinatorConfigFormat;
                    if (configFormat !== 'claude_mcp_json' && configFormat !== 'hermes_config_yaml') {
                        return {
                            success: false,
                            code: 'mesh_coordinator_unsupported',
                            error: `Unsupported auto-import MCP config format: ${String(coordinatorSetup.configFormat)}`,
                            meshId,
                            cliType,
                            workspace,
                        };
                    }

                    // Build the coordinator prompt before mutating workspace config or launching.
                    // Prompt generation failures are configuration/data-shape errors; fail closed so
                    // broken mesh state is visible instead of silently launching with weaker rules.
                    let systemPrompt = '';
                    try {
                        systemPrompt = buildCoordinatorSystemPrompt({ mesh: effectiveMesh, coordinatorCliType: cliType, userInstruction: extraSystemPrompt || undefined, missionSection: buildMissionSectionBestEffort(mesh.id), recentActivity: await buildRecentActivityBestEffort(mesh.id), operatingNotes: await buildEffectiveOperatingNotes(mesh.id) });
                    } catch (error: any) {
                        const message = error?.message || String(error);
                        LOG.error('MeshCoordinator', `Failed to build coordinator prompt: ${message}`);
                        return {
                            success: false,
                            code: 'mesh_coordinator_prompt_failed',
                            error: `Failed to build Repo Mesh coordinator prompt: ${message}`,
                            meshId,
                            cliType,
                            workspace,
                        };
                    }

                    // 1. Write provider-declared MCP config for CLIs that auto-import it.
                    const { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } = await import('fs');
                    const { dirname } = await import('path');
                    const mcpConfigPath = coordinatorSetup.configPath;
                    const hermesManualFallback = cliType === 'hermes-cli' && configFormat === 'hermes_config_yaml'
                        ? createHermesManualMeshCoordinatorSetup(meshId, workspace)
                        : null;
                    let hermesBaseConfig: { config: Record<string, any>; sourceHome: string; sourceConfigPath: string } | null = null;
                    if (hermesManualFallback) {
                        try {
                            hermesBaseConfig = loadHermesCoordinatorBaseConfig(mcpConfigPath);
                        } catch (error: any) {
                            const message = `Failed to parse Hermes base config for automatic coordinator setup: ${error?.message || error}`;
                            LOG.error('MeshCoordinator', message);
                            return { success: false, code: 'mesh_coordinator_config_parse_failed', error: message, meshId, cliType, workspace };
                        }
                    }
                    const returnManualFallback = (message: string) => ({
                        success: false,
                        code: 'mesh_coordinator_manual_mcp_setup_required',
                        error: message,
                        meshId,
                        cliType,
                        workspace,
                        meshCoordinatorSetup: hermesManualFallback,
                    });

                    // Merge ADHDev mesh server into existing config.
                    // Pass full mesh data as env var so the MCP server can bootstrap
                    // without depending on meshes.json or a running daemon.
                    const mcpServerEntry: Record<string, any> = {
                        command: coordinatorSetup.mcpServer.command,
                        args: coordinatorSetup.mcpServer.args,
                    };
                    if (args?.inlineMesh) {
                        const modeArgIndex = coordinatorSetup.mcpServer.args.findIndex((value: string) => value === '--mode');
                        const mcpTransport = modeArgIndex >= 0 ? coordinatorSetup.mcpServer.args[modeArgIndex + 1] : 'ipc';
                        mcpServerEntry.env = {
                            ADHDEV_INLINE_MESH: JSON.stringify(mesh),
                            ADHDEV_MCP_TRANSPORT: mcpTransport === 'local' ? 'local' : 'ipc',
                        };
                    }

                    try {
                        mkdirSync(dirname(mcpConfigPath), { recursive: true });
                    } catch (error: any) {
                        const message = `Could not prepare MCP config path for automatic setup: ${error?.message || error}`;
                        LOG.error('MeshCoordinator', message);
                        if (hermesManualFallback) return returnManualFallback(message);
                        return { success: false, code: 'mesh_coordinator_config_write_failed', error: message, meshId, cliType, workspace };
                    }

                    // Backup existing MCP config if present.
                    const hadExistingMcpConfig = existsSync(mcpConfigPath);
                    let existingMcpConfig: Record<string, any> = hermesBaseConfig?.config || {};
                    if (hermesBaseConfig) {
                        copyHermesCoordinatorCredentialFiles(hermesBaseConfig.sourceHome, dirname(mcpConfigPath));
                    }
                    if (hadExistingMcpConfig) {
                        try {
                            const parsedExistingMcpConfig = parseMeshCoordinatorMcpConfig(readFileSync(mcpConfigPath, 'utf-8'), configFormat);
                            const existingCoordinatorConfig = hermesManualFallback
                                ? stripHermesCoordinatorTempModelProviderOverrides(parsedExistingMcpConfig)
                                : parsedExistingMcpConfig;
                            existingMcpConfig = { ...existingMcpConfig, ...existingCoordinatorConfig };
                            copyFileSync(mcpConfigPath, mcpConfigPath + '.backup');
                        } catch (error: any) {
                            LOG.error('MeshCoordinator', `Failed to parse existing MCP config ${mcpConfigPath}: ${error?.message || error}`);
                            return {
                                success: false,
                                code: 'mesh_coordinator_config_parse_failed',
                                error: `Failed to parse existing MCP config at ${mcpConfigPath}`,
                            };
                        }
                    }

                    const mcpServersKey = getMcpServersKey(configFormat);
                    const existingServers = existingMcpConfig[mcpServersKey];
                    const mcpConfig = {
                        ...existingMcpConfig,
                        [mcpServersKey]: {
                            ...(existingServers && typeof existingServers === 'object' && !Array.isArray(existingServers) ? existingServers : {}),
                            [coordinatorSetup.serverName]: mcpServerEntry,
                        },
                    };
                    try {
                        writeFileSync(mcpConfigPath, serializeMeshCoordinatorMcpConfig(mcpConfig, configFormat), 'utf-8');
                    } catch (error: any) {
                        const message = `Could not write MCP config for automatic setup: ${error?.message || error}`;
                        LOG.error('MeshCoordinator', message);
                        if (hermesManualFallback) return returnManualFallback(message);
                        return { success: false, code: 'mesh_coordinator_config_write_failed', error: message, meshId, cliType, workspace };
                    }
                    LOG.info('MeshCoordinator', `Wrote ${mcpConfigPath} with ${coordinatorSetup.serverName} server`);

                    const cliArgs: string[] = [];
                    const launchEnv: Record<string, string> = {};
                    if (configFormat === 'hermes_config_yaml') {
                        launchEnv.HERMES_HOME = dirname(mcpConfigPath);
                        launchEnv.HERMES_IGNORE_USER_CONFIG = '';
                    }
                    let autoImportContextFilePath: string | undefined;
                    if (systemPrompt) {
                        const { applyMeshCoordinatorSystemPromptInjection } = await import('../mesh-coordinator.js');
                        const effect = applyMeshCoordinatorSystemPromptInjection(
                            systemPrompt,
                            providerMeta?.meshCoordinator?.systemPromptInjection,
                            { cliArgs, launchEnv, workspace, cliType },
                        );
                        autoImportContextFilePath = effect.contextFilePath;
                    }
                    if (cliType === 'claude-cli') {
                        cliArgs.push('--mcp-config', coordinatorSetup.configPath);
                    }

                    // 3. Launch CLI session via existing cliManager.
                    // Provider-specific prompt injection remains fail-closed: Claude gets
                    // explicit CLI args, while Hermes reads HERMES_EPHEMERAL_SYSTEM_PROMPT.
                    const launchResult: any = await ctx.deps.cliManager.handleCliCommand('launch_cli', {
                        cliType,
                        dir: workspace,
                        cliArgs: cliArgs.length > 0 ? cliArgs : undefined,
                        env: Object.keys(launchEnv).length > 0 ? launchEnv : undefined,
                        settings: {
                            meshCoordinatorFor: meshId
                        }
                    });

                    // R48 inject-then-remove. See the cli_command branch for context;
                    // same idea: strip the wrapper from disk ~5s after launch so the
                    // user's AGENTS.md / GEMINI.md is untouched the moment any
                    // worker session opens up in the same workspace.
                    if (launchResult?.success && autoImportContextFilePath) {
                        const stripPath = autoImportContextFilePath;
                        setTimeout(() => {
                            void import('../mesh-coordinator.js').then(({ stripCoordinatorWrapperFile }) => {
                                stripCoordinatorWrapperFile(stripPath);
                                LOG.info('MeshCoordinator', `Stripped wrapper from ${stripPath} after launch settle (auto_import)`);
                            }).catch(() => { /* best-effort */ });
                        }, 5000);
                    }

                    if (!launchResult?.success) {
                        return { success: false, error: launchResult?.error || 'Failed to launch CLI session' };
                    }

                    LOG.info('MeshCoordinator', `Launched ${cliType} coordinator for mesh ${meshId} in ${workspace}`);
                    const launchSessionId = launchResult.sessionId || launchResult.id;
                    if (launchSessionId) {
                        const autoImportInjectionDecl = providerMeta?.meshCoordinator?.systemPromptInjection;
                        registerMeshCoordinator({
                            meshId,
                            sessionId: launchSessionId,
                            workspace,
                            startedAt: Date.now(),
                            cliType,
                            systemPrompt: systemPrompt || undefined,
                            extraSystemPrompt: extraSystemPrompt || undefined,
                            mcpConfigPath,
                            injection: autoImportInjectionDecl ? {
                                mode: autoImportInjectionDecl.mode,
                                target: 'flag' in autoImportInjectionDecl ? autoImportInjectionDecl.flag
                                    : 'name' in autoImportInjectionDecl ? autoImportInjectionDecl.name
                                    : 'path' in autoImportInjectionDecl ? autoImportInjectionDecl.path
                                    : undefined,
                            } : undefined,
                        });
                    }

                    // Record coordinator launch in task ledger
                    try {
                        const { appendLedgerEntry } = await import('../../mesh/mesh-ledger.js');
                        appendLedgerEntry(meshId, {
                            kind: 'coordinator_started',
                            sessionId: launchSessionId,
                            providerType: cliType,
                            payload: { workspace },
                        });
                    } catch { /* ledger append is best-effort */ }

                    return {
                        success: true,
                        meshId,
                        cliType,
                        workspace,
                        sessionId: launchSessionId,
                        mcpConfigWritten: true,
                    };
                } catch (e: any) {
                    LOG.error('MeshCoordinator', `Failed: ${e.message}`);
                    return { success: false, error: e.message };
                }
    },
};
