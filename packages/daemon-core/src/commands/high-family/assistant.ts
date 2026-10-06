/**
 * Assistant project verbs (design docs/design/2026-10-07-assistant-layer.md
 * §4.2–§4.4, §4.6, §4.8): `assistant_projects`, `assistant_project_status`,
 * `assistant_project_send`, `assistant_project_read`, `assistant_project_add`,
 * `assistant_discover_repos`.
 *
 * Sources (pinned by test/commands/assistant-store-sources.test.ts): every
 * verb accepts `ipc` (the assistant's MCP server) and `standalone`;
 * `assistant_projects` also `p2p`/`ws` for the dashboard. None accepts
 * `mesh`. Every verb passes `assistantToolGate` (the review-turn whitelist).
 *
 * Project-scoped answers are `{project: <slug>, meshId, result}` so the
 * assistant's transcript always shows which project answered.
 *
 * All mesh effects go through the daemon's existing commands, in-process
 * (`launch_mesh_coordinator`, `set_conversation_prefs`, `send_chat`,
 * `read_chat`, `mesh_status_view`, `plan_mesh_onboarding`, `create_mesh`,
 * `add_mesh_node`) — the assistant never writes queue/mission/policy state.
 */

import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { componentsNotReadyResult, isDaemonComponentsNotReady } from '../daemon-components-port.js';
import type { CommandRouterResult } from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
import type { LocalMeshEntry } from '../../repo-mesh-types.js';
import { ASSISTANT_TOOL_SOURCES, assistantToolGate } from './assistant-store.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import { projectSlugBase, projectSlugs, resolveAssistantProject } from '../../assistant/assistant-projects.js';
import { getAssistantProjectPorts, type AssistantProjectPorts } from '../../assistant/assistant-project-ports.js';
import { ensureCoordinator, pickCoordinator, type EnsureCoordinatorPorts } from '../../assistant/coordinator-lifecycle.js';
import { composeProjectMessage } from '../../assistant/project-message.js';
import {
    PROJECT_READ_DEFAULT_TAIL, PROJECT_READ_MAX_TAIL,
    compactProjectStatus, compactTranscriptTail, coordinatorState, isUnmanagedRepoIdentity, machinesSummary, meshHostLabel,
    type ProjectRow,
} from '../../assistant/project-views.js';
import { defaultDiscoverRoots, discoverRepos, explicitDiscoverRoots } from '../../assistant/discover-repos.js';
import { normalizeRepoIdentity } from '../../config/mesh-config-store.js';

/** `assistant_projects` is also the dashboard's project list. */
export const ASSISTANT_PROJECTS_SOURCES = ['ipc', 'standalone', 'p2p', 'ws'] as const;

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function fail(code: string, error: string = code, extra: Record<string, unknown> = {}): CommandRouterResult {
    return { success: false, code, error, ...extra };
}

function wrap(project: string, meshId: string, result: Record<string, unknown>): CommandRouterResult {
    return { success: true, project, meshId, result };
}

async function portsFor(ctx: HighFamilyContext): Promise<AssistantProjectPorts> {
    return getAssistantProjectPorts({
        components: ctx.components,
        execute: (cmd, args) => ctx.execute(cmd, args, 'ipc', { inProcess: true }),
        selfDaemonId: str(ctx.deps?.statusInstanceId),
    });
}

/** Gate + ports + boot-window handling shared by every verb. */
function assistantVerb(verb: string, run: (ports: AssistantProjectPorts, args: any, ctx: HighFamilyContext) => Promise<CommandRouterResult>): HighFamilyHandler {
    return async (ctx, args) => {
        const gate = assistantToolGate(verb, args, getAssistantServices());
        if (gate) return gate;
        try {
            return await run(await portsFor(ctx), args ?? {}, ctx);
        } catch (e) {
            if (isDaemonComponentsNotReady(e)) return componentsNotReadyResult(e);
            throw e;
        }
    };
}

type Resolved = { ok: true; mesh: LocalMeshEntry; slug: string } | { ok: false; result: CommandRouterResult };

function resolveProject(ports: AssistantProjectPorts, ref: unknown, opts: { requireHosted: boolean }): Resolved {
    const r = resolveAssistantProject(ref, ports.listMeshes(), ports.aliases());
    if (!r.ok) {
        const detail = r.code === 'project_not_found' ? { projects: r.projects } : { candidates: r.candidates };
        return { ok: false, result: fail(r.code, r.code, detail) };
    }
    if (opts.requireHosted && !ports.isHostedHere(r.mesh)) {
        return {
            ok: false,
            result: fail('project_hosted_elsewhere', 'project_hosted_elsewhere', {
                project: r.slug, meshId: r.mesh.id, hostLabel: meshHostLabel(r.mesh, ports.selfDaemonId()),
            }),
        };
    }
    return { ok: true, mesh: r.mesh, slug: r.slug };
}

function coordinatorPorts(ports: AssistantProjectPorts): EnsureCoordinatorPorts {
    return {
        coordinators: (meshId) => ports.coordinators(meshId),
        cliTypeFor: (meshId) => ports.cliTypeFor(meshId),
        launch: (input) => ports.execute('launch_mesh_coordinator', {
            meshId: input.meshId,
            ...(input.cliType ? { cliType: input.cliType } : {}),
            extraSystemPrompt: input.extraSystemPrompt,
            managedByAssistant: input.managedByAssistant,
        }),
        hide: async (sessionId) => { await ports.execute('set_conversation_prefs', { sessionId, hidden: true }); },
    };
}

// ── projects / project_status ──────────────────────────────────────────────

function projectRow(ports: AssistantProjectPorts, mesh: LocalMeshEntry, slug: string): ProjectRow {
    const base = { slug, meshId: mesh.id, name: mesh.name, repo: mesh.repoIdentity };
    if (!ports.isHostedHere(mesh)) return { ...base, hosting: 'elsewhere', hostLabel: meshHostLabel(mesh, ports.selfDaemonId()) };
    return {
        ...base,
        hosting: 'here',
        coordinator: coordinatorState(ports.coordinators(mesh.id)),
        threadOpen: ports.relay.isThreadOpen ? ports.relay.isThreadOpen(mesh.id) : null,
        queue: ports.queueCounts(mesh.id),
        activeMissions: ports.activeMissionCount(mesh.id),
        pendingApprovals: ports.pendingApprovals(mesh.id),
    };
}

const projects = assistantVerb(ASSISTANT_VERB.projects, async (ports) => {
    const meshes = ports.listMeshes();
    const slugs = projectSlugs(meshes);
    const managed: ProjectRow[] = [];
    const unmanaged: ProjectRow[] = [];
    for (const mesh of meshes) {
        const row = projectRow(ports, mesh, slugs.get(mesh.id) ?? mesh.id);
        (isUnmanagedRepoIdentity(mesh.repoIdentity) ? unmanaged : managed).push(row);
    }
    return { success: true, projects: managed, unmanaged, machines: machinesSummary(meshes, ports.selfDaemonId()) };
});

const projectStatus = assistantVerb(ASSISTANT_VERB.projectStatus, async (ports, args) => {
    const p = resolveProject(ports, args.project, { requireHosted: true });
    if (!p.ok) return p.result;
    const meshId = p.mesh.id;
    const view = await ports.execute('mesh_status_view', { meshId, compact: true });
    const status = compactProjectStatus(view.success ? view : {}, {
        queue: ports.queueCounts(meshId),
        pendingApprovals: ports.pendingApprovals(meshId),
        coordinator: coordinatorState(ports.coordinators(meshId)),
        threadOpen: ports.relay.isThreadOpen ? ports.relay.isThreadOpen(meshId) : null,
        lastRelayAt: ports.relay.lastRelayAt ? ports.relay.lastRelayAt(meshId) : null,
    });
    return wrap(p.slug, meshId, { name: p.mesh.name, repo: p.mesh.repoIdentity, ...status, ...(view.success ? {} : { statusError: str(view.error) || 'mesh_status_view failed' }) });
});

// ── project_send ────────────────────────────────────────────────────────────

const projectSend = assistantVerb(ASSISTANT_VERB.projectSend, async (ports, args) => {
    // The user's words pass as written — never trimmed or rewritten.
    const message = typeof args.message === 'string' ? args.message : '';
    const skills = Array.isArray(args.skills) ? args.skills.filter((s: unknown): s is string => typeof s === 'string') : [];
    const composed = composeProjectMessage(
        { message, ...(typeof args.supplement === 'string' ? { supplement: args.supplement } : {}), skills },
        getAssistantServices().skills,
    );
    if (!composed.ok) {
        const { ok: _ok, code, error, ...detail } = composed;
        return fail(code, error, detail);
    }
    const p = resolveProject(ports, args.project, { requireHosted: true });
    if (!p.ok) return p.result;
    const meshId = p.mesh.id;
    const where = { project: p.slug, meshId };

    const coord = await ensureCoordinator(meshId, coordinatorPorts(ports));
    if (!coord.ok) return fail(coord.code, coord.error, { ...where, ...coord.detail });

    const clientId = str(args.messageId) || randomUUID();
    const messageId = `assistant:${meshId}:${clientId}`;
    const sent = await ports.execute('send_chat', {
        targetSessionId: coord.sessionId,
        text: composed.text,
        origin: 'assistant',
        policy: { mode: 'queue' },
        messageId,
    });
    if (!sent.success) {
        return fail(str(sent.reason) || str(sent.code) || 'send_failed', str(sent.error) || 'send_failed', {
            ...where, launched: coord.launched, coordinatorSessionId: coord.sessionId, messageId,
        });
    }
    ports.relay.openThread?.(meshId);
    if (composed.attached.length > 0) ports.relay.recordSkillAttaches?.(meshId, composed.attached.length);
    const status = sent.deduplicated === true ? 'duplicate' : sent.queued === true ? 'queued' : 'accepted';
    return wrap(p.slug, meshId, {
        status,
        launched: coord.launched,
        coordinatorSessionId: coord.sessionId,
        messageId,
        ...(composed.attached.length > 0 ? { attachedSkills: composed.attached } : {}),
    });
});

// ── project_read ────────────────────────────────────────────────────────────

const projectRead = assistantVerb(ASSISTANT_VERB.projectRead, async (ports, args) => {
    const p = resolveProject(ports, args.project, { requireHosted: true });
    if (!p.ok) return p.result;
    const meshId = p.mesh.id;
    const rawTail = Number(args.tail);
    const tail = Number.isFinite(rawTail) && rawTail >= 1 ? Math.min(Math.floor(rawTail), PROJECT_READ_MAX_TAIL) : PROJECT_READ_DEFAULT_TAIL;
    const live = pickCoordinator(ports.coordinators(meshId));
    const sessionId = live?.sessionId ?? ports.lastCoordinatorSessionId(meshId);
    if (!sessionId) return wrap(p.slug, meshId, { coordinator: 'none', messages: [] });
    const chat = await ports.execute('read_chat', { targetSessionId: sessionId, limit: Math.max(tail * 4, 40) });
    if (!chat.success) {
        return fail('project_read_failed', str(chat.error) || 'read_chat failed', { project: p.slug, meshId, coordinatorSessionId: sessionId });
    }
    return wrap(p.slug, meshId, { coordinatorSessionId: sessionId, live: !!live, ...compactTranscriptTail(chat, tail) });
});

// ── project_add ─────────────────────────────────────────────────────────────

function expandPath(raw: string): string {
    if (raw === '~') return homedir();
    return raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
}

function existingProject(meshes: readonly LocalMeshEntry[], repoIdentity: string): LocalMeshEntry | undefined {
    const want = normalizeRepoIdentity(repoIdentity);
    return want ? meshes.find((m) => normalizeRepoIdentity(m.repoIdentity ?? '') === want) : undefined;
}

const PLAN_EXISTS_CODES: ReadonlySet<string> = new Set(['ambiguous_mesh', 'duplicate_workspace', 'duplicate_node']);

const projectAdd = assistantVerb(ASSISTANT_VERB.projectAdd, async (ports, args) => {
    const raw = str(args.path);
    if (!raw) return fail('invalid_args', 'path required');
    if (!isAbsolute(expandPath(raw))) return fail('invalid_args', 'path must be absolute');
    const path = resolve(expandPath(raw));
    if (!existsSync(path) || !statSync(path).isDirectory()) return fail('path_not_found', `not a directory: ${path}`);

    const plan: any = await ports.execute('plan_mesh_onboarding', { workspace: path, operation: 'auto' });
    const identity = str(plan?.discovery?.repoIdentity);
    const meshes = ports.listMeshes();
    // (a) one project per repoIdentity — createMesh itself does not check (§4.2).
    const existing = identity ? existingProject(meshes, identity) : undefined;
    if (existing || (!plan?.success && PLAN_EXISTS_CODES.has(str(plan?.code)))) {
        const mesh = existing ?? meshes.find((m) => (m.nodes ?? []).some((n) => resolve(n.workspace) === path));
        const slug = mesh ? projectSlugs(meshes).get(mesh.id) ?? mesh.id : '';
        return fail('project_exists', 'project_exists', { ...(mesh ? { project: slug, meshId: mesh.id, name: mesh.name } : {}), repoIdentity: identity || null });
    }
    if (!plan?.success) return fail(str(plan?.code) || 'onboarding_plan_failed', str(plan?.error) || 'onboarding plan failed', { action: plan?.action });
    const steps: any[] = Array.isArray(plan.plan?.steps) ? plan.plan.steps : [];
    const createStep = steps.find((s) => s?.command === 'create_mesh');
    const addStep = steps.find((s) => s?.command === 'add_mesh_node');
    if (plan.plan?.kind !== 'create_mesh_and_onboard' || !createStep || !addStep) {
        return fail('onboarding_plan_unexpected', `unexpected onboarding plan: ${str(plan.plan?.kind) || 'none'}`);
    }

    const name = str(args.name) || projectSlugBase(identity) || str(createStep.args?.name);
    const created: any = await ports.execute('create_mesh', { ...createStep.args, name, workspace: path });
    const meshId = str(created?.mesh?.id);
    if (!created?.success || !meshId) return fail('project_create_failed', str(created?.error) || 'create_mesh failed');

    // (b) always stamp the owning daemon id on the node (§4.2).
    const selfDaemonId = ports.selfDaemonId();
    const node: any = await ports.execute('add_mesh_node', {
        ...addStep.args,
        meshId,
        workspace: str(addStep.args?.workspace) || path,
        ...(selfDaemonId ? { daemonId: selfDaemonId } : {}),
    });
    if (!node?.success) {
        await ports.execute('delete_mesh', { meshId }).catch(() => undefined);
        return fail('project_add_node_failed', str(node?.error) || 'add_mesh_node failed', { rolledBack: true });
    }
    const slug = projectSlugs(ports.listMeshes()).get(meshId) || projectSlugBase(identity) || meshId;
    return wrap(slug, meshId, {
        created: true,
        name,
        repoIdentity: identity,
        workspace: str(node.node?.workspace) || path,
        nodeId: str(node.node?.id) || null,
        ...(Array.isArray(plan.warnings) && plan.warnings.length ? { warnings: plan.warnings } : {}),
    });
});

// ── discover_repos ─────────────────────────────────────────────────────────

const discover = assistantVerb(ASSISTANT_VERB.discoverRepos, async (ports, args) => {
    const meshes = ports.listMeshes();
    const workspaces = meshes.flatMap((m) => (m.nodes ?? []).map((n) => str(n.workspace)).filter(Boolean));
    const roots = Array.isArray(args.roots) && args.roots.length > 0 ? explicitDiscoverRoots(args.roots) : defaultDiscoverRoots(workspaces);
    if (roots.length === 0) return fail('invalid_args', 'roots must be absolute paths');
    const result = discoverRepos({
        roots,
        known: {
            repoIdentities: new Set(meshes.map((m) => normalizeRepoIdentity(m.repoIdentity ?? '')).filter(Boolean)),
            workspaces: new Set(workspaces.map((w) => resolve(w))),
        },
    });
    return { success: true, ...result };
});

export const assistantProjectHandlers: Record<string, HighFamilyHandler> = {
    [ASSISTANT_VERB.projects]: projects,
    [ASSISTANT_VERB.projectStatus]: projectStatus,
    [ASSISTANT_VERB.projectSend]: projectSend,
    [ASSISTANT_VERB.projectRead]: projectRead,
    [ASSISTANT_VERB.projectAdd]: projectAdd,
    [ASSISTANT_VERB.discoverRepos]: discover,
};

export const assistantProjectSpecs = defineCommandSpecs('high', assistantProjectHandlers, {
    [ASSISTANT_VERB.projects]: { sources: [...ASSISTANT_PROJECTS_SOURCES] },
    [ASSISTANT_VERB.projectStatus]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.projectSend]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.projectRead]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.projectAdd]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.discoverRepos]: { sources: [...ASSISTANT_TOOL_SOURCES] },
});
