import { remoteProjectHandlers, remoteProjectSpecs, attachRemoteProject } from './remote-project-attach.js';
import { readTaskReportPage } from '../../assistant/task-report-continuation.js';
import { recoverAttemptReport, verifiedNativeRead } from '../../assistant/attempt-report-recovery.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { environmentInventory, observedInventoryMachine } from '../../assistant/environment-inventory.js';
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
 * Remote-hosted projects (owner decision 2026-10-08, closing design Q4): a
 * mesh another daemon hosts is driven by relaying to that host —
 * `assistant_remote_project` (assistant-remote.ts) runs the same local path
 * there. status/send/read relay; an unreachable host answers
 * `project_unreachable{reason}`. The relay result comes back through the
 * remote poller (assistant/assistant-remote-relay.ts).
 *
 * All mesh effects go through the daemon's existing commands, in-process
 * (`launch_mesh_coordinator`, `set_conversation_prefs`, `send_chat`,
 * `read_chat`, `mesh_status_view`, `plan_mesh_onboarding`, `create_mesh`,
 * `add_mesh_node`) — the assistant never writes queue/mission/policy state.
 */

import { continueReport, parseReportContinuation, pageAttemptReport, type ReportCursor } from '../../assistant/report-continuation.js';
import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { ASSISTANT_VERB, daemonIdsEquivalent, canonicalDaemonId, sanitizeRemoteRepoIdentity, type FollowedRemoteProjectEntry } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { componentsNotReadyResult, isDaemonComponentsNotReady } from '../daemon-components-port.js';
import type { CommandRouterResult } from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
import type { LocalMeshEntry } from '../../repo-mesh-types.js';
import type { RemoteCallOutcome, RemoteHostView } from '../../assistant/assistant-remote-host.js';
import { ASSISTANT_TOOL_SOURCES, assistantToolGate, projectPortsFor, readAssistantSessionId } from './assistant-store.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import { projectSlugBase, projectSlugs, resolveAssistantProject } from '../../assistant/assistant-projects.js';
import type { AssistantProjectPorts } from '../../assistant/assistant-project-ports.js';
import { ensureCoordinator, pickCoordinator, type EnsureCoordinatorPorts } from '../../assistant/coordinator-lifecycle.js';
import { composeProjectMessage } from '../../assistant/project-message.js';
import {
    PROJECT_READ_DEFAULT_TAIL, PROJECT_READ_MAX_TAIL, PROJECT_STATUS_ROUTING_DIFFICULTY,
    compactProjectStatus, compactTranscriptTail, coordinatorState, followerStatusView, isUnmanagedRepoIdentity, machinesSummary, projectRoutingView,
    sessionRows,
    type ProjectRoutingView, type ProjectRow, type RemoteHostMachine, type SessionRow,
} from '../../assistant/project-views.js';
import { isLocalOwnerBindingRefusalCode } from '../../assistant/assistant-registry.js';
import { defaultDiscoverRoots, discoverRepos, explicitDiscoverRoots } from '../../assistant/discover-repos.js';
import { normalizeRepoIdentity } from '../../config/mesh-config-store.js';
import {
    ArtifactStore,
    MAX_ARTIFACT_MCP_PAGE_BYTES,
    toChatAttachmentMeta,
    wrapUntrustedArtifactContent,
} from '../../artifacts/index.js';

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

/** Gate + ports + boot-window handling shared by every verb. */
function assistantVerb(verb: string, run: (ports: AssistantProjectPorts, args: any, ctx: HighFamilyContext) => Promise<CommandRouterResult>): HighFamilyHandler {
    return async (ctx, args) => {
        const gate = assistantToolGate(verb, args, getAssistantServices());
        if (gate) return gate;
        try {
            return await run(await projectPortsFor(ctx), args ?? {}, ctx);
        } catch (e) {
            if (isDaemonComponentsNotReady(e)) return componentsNotReadyResult(e);
            throw e;
        }
    };
}

type ProjectCandidate = LocalMeshEntry & {
    hostDaemonId?: string;
    canonicalKey?: string;
    _followedRemote?: FollowedRemoteProjectEntry;
};

function followedCandidate(entry: FollowedRemoteProjectEntry): ProjectCandidate {
    return {
        id: entry.meshId,
        name: entry.name,
        repoIdentity: entry.sanitizedRepoIdentity,
        nodes: [],
        hostDaemonId: entry.hostDaemonId,
        canonicalKey: entry.key,
        _followedRemote: entry,
    } as unknown as ProjectCandidate;
}

/** `remote` is null when this daemon hosts the mesh. */
type Resolved =
    | { ok: true; mesh: LocalMeshEntry; slug: string; remote: RemoteHostView | null; followedRemote?: FollowedRemoteProjectEntry }
    | { ok: false; result: CommandRouterResult };

/**
 * Resolve a project ref over the inventory, which includes the meshes this
 * daemon is a member of (member-meshes.ts) plus checkout-less followed remote
 * projects from `assistant.json` (never injected into `meshes.json`).
 *
 * Canonical `hostDaemonId::meshId` keys prevent name/host collisions and silent
 * rebind across hosts. Unfollowed or revoked remote projects fail closed and
 * can never be reopened by a `project_send` or other verb.
 */
async function resolveProject(ports: AssistantProjectPorts, ref: unknown): Promise<Resolved> {
    await ports.refreshMemberMeshes?.();
    const localMeshes = ports.listMeshes();
    const followedList = (ports.followedRemoteProjects?.() ?? []).filter((e) =>
        !localMeshes.some((m) => m.id === e.meshId && (ports.isHostedHere(m) || daemonIdsEquivalent(ports.remoteHost(m).hostDaemonId, e.hostDaemonId))),
    );
    const candidates: ProjectCandidate[] = [
        ...localMeshes,
        ...followedList.map(followedCandidate),
    ];
    const r = resolveAssistantProject(ref, candidates, ports.aliases());
    if (!r.ok) {
        const detail = r.code === 'project_not_found' ? { projects: r.projects } : { candidates: r.candidates };
        return { ok: false, result: fail(r.code, r.code, detail) };
    }
    const entry = r.mesh._followedRemote;
    if (entry) {
        if (entry.state === 'unfollowed') {
            return {
                ok: false,
                result: fail(
                    'remote_project_unfollowed',
                    'Remote project is not currently followed. Follow it again from the dashboard before accessing or sending.',
                    { project: r.slug, meshId: entry.meshId, hostDaemonId: entry.hostDaemonId },
                ),
            };
        }
        if (entry.state === 'revoked') {
            const revokedReason = entry.revokedReason ?? entry.lastErrorCode;
            if (isLocalOwnerBindingRefusalCode(revokedReason)) {
                const verify = ports.verifyOwnerBinding?.();
                const code = verify && !verify.ok
                    ? verify.code
                    : revokedReason === 'local_owner_binding_mismatch'
                        ? 'local_owner_binding_mismatch'
                        : 'local_owner_binding_missing';
                const error = verify && !verify.ok
                    ? verify.error
                    : 'Local assistant owner binding requires explicit owner reconciliation (ensure_binding) before this followed project can resume.';
                return {
                    ok: false,
                    result: fail(code, error, { project: r.slug, meshId: entry.meshId, hostDaemonId: entry.hostDaemonId }),
                };
            }
            return {
                ok: false,
                result: fail(
                    'host_revoked',
                    'Remote host access for this project has been revoked.',
                    { project: r.slug, meshId: entry.meshId, hostDaemonId: entry.hostDaemonId },
                ),
            };
        }
        const verify = ports.verifyOwnerBinding?.();
        if (verify && !verify.ok) {
            return {
                ok: false,
                result: fail(verify.code, verify.error, { project: r.slug, meshId: entry.meshId, hostDaemonId: entry.hostDaemonId }),
            };
        }
        const remote: RemoteHostView = ports.followedRemoteHost
            ? ports.followedRemoteHost(entry)
            : {
                label: entry.hostLabel || entry.hostDaemonId,
                hostDaemonId: entry.hostDaemonId,
                hostMeshId: entry.meshId,
                reachable: true,
                followerAccess: {
                    accountSlot: entry.accountSlot,
                    bindingRevision: entry.bindingRevision,
                    grantRevision: entry.grantRevision,
                },
            };
        return { ok: true, mesh: r.mesh, slug: r.slug, remote, followedRemote: entry };
    }
    return { ok: true, mesh: r.mesh, slug: r.slug, remote: ports.isHostedHere(r.mesh) ? null : ports.remoteHost(r.mesh) };
}

/** `project_unreachable{reason, host}`, or the host's own refusal, for a remote call that did not succeed. */
export function remoteFailure(
    where: { project: string; meshId: string },
    remote: RemoteHostView,
    out: Exclude<RemoteCallOutcome, { ok: true }>,
    ports?: AssistantProjectPorts,
    followedRemote?: FollowedRemoteProjectEntry,
): CommandRouterResult {
    if (followedRemote && out.kind === 'refused' && (out.code === 'host_revoked' || out.code === 'remote_access_denied')) {
        ports?.markFollowedRemoteRevoked?.(followedRemote.key, out.code);
        ports?.relay.closeThread?.(where.meshId, { suppressPending: true });
    }
    if (out.kind === 'unreachable') {
        return fail('project_unreachable', out.error, { ...where, host: remote.label, reason: out.reason });
    }
    return fail(out.code, out.error, { ...where, host: remote.label, ...(out.code === 'host_unsupported' ? { reason: 'host_unsupported' } : {}) });
}

/** Call the host of a remote-hosted project; an unreachable host is refused before any call. */
async function callRemote(ports: AssistantProjectPorts, p: { slug: string; mesh: LocalMeshEntry; remote: RemoteHostView }, op: Parameters<AssistantProjectPorts['callHost']>[1], args: Record<string, unknown>): Promise<RemoteCallOutcome> {
    if (p.remote.followerAccess?.localBindingError) {
        const { code, error } = p.remote.followerAccess.localBindingError;
        return { ok: false, kind: 'refused', code, error, result: { success: false, code, error } };
    }
    if (!p.remote.reachable) {
        return { ok: false, kind: 'unreachable', code: 'project_unreachable', reason: p.remote.reason ?? 'relay_failed', error: `${p.slug} is hosted on ${p.remote.label}, which cannot be reached now (${p.remote.reason ?? 'relay_failed'})` };
    }
    return ports.callHost(p.remote, op, args);
}

/** Body of a host's answer: `{success, result: {...}}` → `{...}`. */
function remoteBody(out: Extract<RemoteCallOutcome, { ok: true }>): Record<string, unknown> {
    const r = out.result.result;
    return r && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : {};
}

export function coordinatorPorts(ports: AssistantProjectPorts): EnsureCoordinatorPorts {
    return {
        coordinators: (meshId) => ports.coordinators(meshId),
        launch: (input) => ports.execute('launch_mesh_coordinator', {
            meshId: input.meshId,
            extraSystemPrompt: input.extraSystemPrompt,
            managedByAssistant: input.managedByAssistant,
        }),
        hide: async (sessionId) => { await ports.execute('set_conversation_prefs', { sessionId, hidden: true }); },
    };
}

// ── projects / project_status ──────────────────────────────────────────────

function projectRow(ports: AssistantProjectPorts, mesh: LocalMeshEntry, slug: string, remoteHosts?: RemoteHostMachine[]): ProjectRow {
    const base = { slug, meshId: mesh.id, name: mesh.name, repo: mesh.repoIdentity };
    if (!ports.isHostedHere(mesh)) {
        // Remote: listing stays local and cheap (no call per project); project_status asks the host.
        const remote = ports.remoteHost(mesh);
        remoteHosts?.push({ daemonId: remote.hostDaemonId, label: remote.label });
        return {
            ...base,
            hosting: 'remote',
            host: remote.label,
            hostLabel: remote.label,
            ...(remote.hostMeshId && remote.hostMeshId !== mesh.id ? { hostMeshId: remote.hostMeshId } : {}),
            reachability: remote.reachable ? 'relay' : 'unreachable',
            ...(remote.reachable ? {} : { unreachableReason: remote.reason ?? 'relay_failed' }),
            threadOpen: ports.relay.isThreadOpen ? ports.relay.isThreadOpen(mesh.id) : null,
        };
    }
    return {
        ...base,
        hosting: 'here',
        host: 'this machine',
        reachability: 'local',
        coordinator: coordinatorState(ports.coordinators(mesh.id)),
        threadOpen: ports.relay.isThreadOpen ? ports.relay.isThreadOpen(mesh.id) : null,
        queue: ports.queueCounts(mesh.id),
        activeMissions: ports.activeMissionCount(mesh.id),
        pendingApprovals: ports.pendingApprovals(mesh.id),
    };
}

const environment = assistantVerb(ASSISTANT_VERB.environment, async (ports) => {
    await ports.refreshMemberMeshes?.();
    const meshes = ports.listMeshes();
    const now = Date.now();
    const result = environmentInventory(meshes, now, ports.localNodeFacts ? { daemonId: ports.selfDaemonId(), facts: ports.localNodeFacts() } : undefined);
    const targets = new Map<string, { mesh: LocalMeshEntry; remote: RemoteHostView }>();
    for (const mesh of meshes) if (!ports.isHostedHere(mesh)) {
        const remote = ports.remoteHost(mesh);
        targets.set(canonicalDaemonId(remote.hostDaemonId) ?? mesh.id, { mesh, remote });
    }
    for (const mesh of meshes) for (const node of mesh.nodes ?? []) {
        const id = canonicalDaemonId(node.daemonId);
        if (!id || daemonIdsEquivalent(id, ports.selfDaemonId()) || targets.has(id)) continue;
        const hostMeshId = ports.isHostedHere(mesh) ? mesh.id : ports.remoteHost(mesh).hostMeshId;
        targets.set(id, { mesh, remote: { hostDaemonId: id, hostMeshId, label: id, reachable: true } });
    }
    const errors: Array<{ meshId: string; daemonId: string | null; reason: string }> = [];
    // At most eight host probes, four concurrently; roster-gated op sees just its named mesh.
    const probes = [...targets.values()].slice(0, 8);
    for (let at = 0; at < probes.length; at += 4) {
        const answers = await Promise.all(probes.slice(at, at + 4).map(async p => ({ p, out: await callRemote(ports, { slug: p.mesh.id, ...p }, 'inventory', {}) })));
        for (const { p, out } of answers) {
            if (!out.ok) { errors.push({ meshId: p.mesh.id, daemonId: p.remote.hostDaemonId, reason: out.kind === 'unreachable' ? out.reason : out.code }); continue; }
            const observed = remoteBody(out).machines;
            if (!Array.isArray(observed)) { errors.push({ meshId: p.mesh.id, daemonId: p.remote.hostDaemonId, reason: 'inventory_unavailable' }); continue; }
            // Projection is generated by the same allow-list on the authenticated host.
            for (const raw of observed.slice(0, 64)) {
                const machine = observedInventoryMachine(raw);
                if (!machine || (!(p.mesh.nodes ?? []).some(n => daemonIdsEquivalent(n.daemonId, machine.daemonId)) && !daemonIdsEquivalent(p.remote.hostDaemonId, machine.daemonId))) continue;
                const row = result.machines.find(m => daemonIdsEquivalent(m.daemonId, machine.daemonId));
                if (row && typeof machine.reportedAt === 'number' && (row.reportedAt === null || machine.reportedAt > row.reportedAt)) {
                    Object.assign(row, { reportedAt: machine.reportedAt, freshness: machine.freshness, providers: machine.providers });
                }
            }
        }
    }
    return { success: true, ...result, errors, omittedHostProbes: Math.max(0, targets.size - probes.length) };
});

const projects = assistantVerb(ASSISTANT_VERB.projects, async (ports) => {
    await ports.refreshMemberMeshes?.();
    const meshes = ports.listMeshes();
    const followedActive = (ports.followedRemoteProjects?.() ?? []).filter((e) =>
        e.state === 'followed' && !meshes.some((m) => m.id === e.meshId && (ports.isHostedHere(m) || daemonIdsEquivalent(ports.remoteHost(m).hostDaemonId, e.hostDaemonId))),
    );
    const allCandidates: ProjectCandidate[] = [
        ...meshes,
        ...followedActive.map(followedCandidate),
    ];
    const slugs = projectSlugs(allCandidates);
    const managed: ProjectRow[] = [];
    const unmanaged: ProjectRow[] = [];
    const remoteHosts: RemoteHostMachine[] = [];
    for (const mesh of meshes) {
        const row = projectRow(ports, mesh, slugs.get(mesh.id) ?? mesh.id, remoteHosts);
        // A remote mesh whose host has not told us its repo yet is still a project.
        const scratch = row.hosting === 'remote' && !str(mesh.repoIdentity) ? false : isUnmanagedRepoIdentity(mesh.repoIdentity);
        (scratch ? unmanaged : managed).push(row);
    }
    for (const entry of followedActive) {
        const remote: RemoteHostView = ports.followedRemoteHost
            ? ports.followedRemoteHost(entry)
            : { label: entry.hostLabel || entry.hostDaemonId, hostDaemonId: entry.hostDaemonId, hostMeshId: entry.meshId, reachable: true };
        remoteHosts.push({ daemonId: entry.hostDaemonId, label: remote.label });
        managed.push({
            slug: slugs.get(entry.key) ?? slugs.get(entry.meshId) ?? entry.slug,
            meshId: entry.meshId,
            name: entry.name,
            repo: entry.sanitizedRepoIdentity ?? '',
            hosting: 'remote_followed',
            host: remote.label,
            hostLabel: remote.label,
            hostDaemonId: entry.hostDaemonId,
            canonicalKey: entry.key,
            grantRevision: entry.grantRevision,
            bindingRevision: entry.bindingRevision,
            reachability: remote.reachable ? 'relay' : 'unreachable',
            ...(remote.reachable ? {} : { unreachableReason: remote.reason ?? 'relay_failed' }),
            threadOpen: ports.relay.isThreadOpen ? ports.relay.isThreadOpen(entry.meshId) : null,
        });
    }
    return { success: true, projects: managed, unmanaged, machines: machinesSummary(meshes, ports.selfDaemonId(), undefined, remoteHosts) };
});

/**
 * project_status body for a mesh hosted HERE (also the host side of a remote
 * status — so `routing` reaches the assistant for remote projects too, computed
 * by the daemon that actually owns the slots and the quota facts).
 */
export async function localProjectStatus(ports: AssistantProjectPorts, mesh: LocalMeshEntry): Promise<Record<string, unknown>> {
    const meshId = mesh.id;
    const view = await ports.execute('mesh_status_view', { meshId, compact: true });
    const status = compactProjectStatus(view.success ? view : {}, {
        queue: ports.queueCounts(meshId),
        pendingApprovals: ports.pendingApprovals(meshId),
        coordinator: coordinatorState(ports.coordinators(meshId)),
        threadOpen: ports.relay.isThreadOpen ? ports.relay.isThreadOpen(meshId) : null,
        lastRelayAt: ports.relay.lastRelayAt ? ports.relay.lastRelayAt(meshId) : null,
        ...(ports.relay.missedReports ? { missedReports: ports.relay.missedReports(meshId) } : {}),
    });
    // Routing visibility (A7d): reuse the labels project_status already resolved
    // so the assistant reads machine names, not node ids.
    const labels = new Map<string, string | null>(
        (Array.isArray(status.machines) ? status.machines : []).map((m: any) => [str(m?.node), (m?.label ?? null) as string | null]),
    );
    const preview = await ports.routePreview(meshId, PROJECT_STATUS_ROUTING_DIFFICULTY);
    const routing: ProjectRoutingView = preview
        ? projectRoutingView(preview, PROJECT_STATUS_ROUTING_DIFFICULTY, labels)
        : { ...projectRoutingView(null, PROJECT_STATUS_ROUTING_DIFFICULTY, labels), error: 'route_preview_unavailable' };
    // A2 session visibility: the live sessions of THIS daemon, so the assistant
    // can spot an orphan (messageCount 0 + spawnedForTaskId null) itself rather
    // than waiting for the owner to find it. Scoped to this mesh plus sessions
    // carrying no mesh stamp — see `sessionRows`. Like `routing`, this is
    // computed wherever localProjectStatus runs, so the HOST's sessions reach
    // the assistant for a remote project too.
    const sessions: SessionRow[] = ports.liveSessionStates
        ? sessionRows(ports.liveSessionStates(), { meshId })
        : [];
    return { name: mesh.name, repo: mesh.repoIdentity, ...status, routing, sessions, ...(view.success ? {} : { statusError: str(view.error) || 'mesh_status_view failed' }) };
}

const projectStatus = assistantVerb(ASSISTANT_VERB.projectStatus, async (ports, args) => {
    const p = await resolveProject(ports, args.project);
    if (!p.ok) return p.result;
    const meshId = p.mesh.id;
    if (!p.remote) return wrap(p.slug, meshId, { ...(await localProjectStatus(ports, p.mesh)), host: 'this machine' });
    const out = await callRemote(ports, { ...p, remote: p.remote }, 'status', {});
    if (!out.ok) {
        if (p.followedRemote && out.kind === 'unreachable' && p.followedRemote.lastObserved) {
            const lastRelayAt = ports.relay.lastRelayAt ? ports.relay.lastRelayAt(meshId) : null;
            return wrap(p.slug, meshId, {
                name: p.mesh.name,
                repo: p.mesh.repoIdentity,
                host: p.remote.label,
                hostDaemonId: p.followedRemote.hostDaemonId,
                via: 'cached_observation',
                reachability: 'unreachable',
                unreachableReason: out.reason,
                observationOnly: true,
                lastObserved: p.followedRemote.lastObserved,
                coordinator: p.followedRemote.lastObserved.coordinatorState ?? 'unknown',
                threadOpen: ports.relay.isThreadOpen ? ports.relay.isThreadOpen(meshId) : null,
                lastRelayAt: lastRelayAt ? new Date(lastRelayAt).toISOString() : null,
            });
        }
        return remoteFailure({ project: p.slug, meshId }, p.remote, out, ports, p.followedRemote);
    }
    const rawBody = remoteBody(out);
    const body = p.followedRemote
        ? followerStatusView(rawBody, {
            id: meshId,
            name: p.mesh.name,
            repoIdentity: p.followedRemote.sanitizedRepoIdentity || str(rawBody.repo),
        } as LocalMeshEntry)
        : rawBody;
    if (p.followedRemote) {
        const coordState = str(body.coordinator) || 'none';
        ports.updateFollowedRemoteObservation?.(p.followedRemote.key, {
            lastObserved: {
                observedAt: new Date().toISOString(),
                coordinatorState: coordState,
                coordinatorMissing: coordState === 'none',
            },
        });
    }
    // The thread and relay times live HERE (this daemon's assistant), not on the host.
    const lastRelayAt = ports.relay.lastRelayAt ? ports.relay.lastRelayAt(meshId) : null;
    const repo = p.followedRemote
        ? (typeof body.repo === 'string' ? body.repo : sanitizeRemoteRepoIdentity(p.followedRemote.sanitizedRepoIdentity ?? str(rawBody.repo)))
        : p.mesh.repoIdentity;
    return wrap(p.slug, meshId, {
        ...body,
        name: p.mesh.name,
        repo,
        host: p.remote.label,
        ...(p.followedRemote ? { hostDaemonId: p.followedRemote.hostDaemonId, hosting: 'remote_followed' } : {}),
        via: 'relay',
        threadOpen: ports.relay.isThreadOpen ? ports.relay.isThreadOpen(meshId) : null,
        lastRelayAt: lastRelayAt ? new Date(lastRelayAt).toISOString() : null,
    });
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
    const p = await resolveProject(ports, args.project);
    if (!p.ok) return p.result;
    const meshId = p.mesh.id;
    const where = { project: p.slug, meshId };
    const clientId = str(args.messageId) || randomUUID();
    const attached = composed.attached.length > 0 ? { attachedSkills: composed.attached } : {};

    if (p.remote) {
        // The host runs the same local path (ensure coordinator → send_chat) under its own mesh id,
        // or followerProjectSend (existing live coordinator only) for followed remote projects.
        const expectedCoordinatorSessionId = str(args.expectedCoordinatorSessionId) || str(p.followedRemote?.coordinatorSessionId);
        const out = await callRemote(ports, { ...p, remote: p.remote }, 'send', {
            text: composed.text,
            clientId,
            ...(expectedCoordinatorSessionId ? { expectedCoordinatorSessionId } : {}),
        });
        if (!out.ok) return remoteFailure(where, p.remote, out, ports, p.followedRemote);
        const body = remoteBody(out);
        const remoteCursor = str(body.cursor) || null;
        const remoteCoordSessionId = str(body.coordinatorSessionId) || null;
        ports.relay.openThread?.(meshId);
        ports.relay.remoteSent?.(meshId, remoteCursor, remoteCoordSessionId);
        if (p.followedRemote) {
            ports.updateFollowedRemoteObservation?.(p.followedRemote.key, {
                ...(remoteCursor !== null ? { lastCursor: remoteCursor } : {}),
                ...(remoteCoordSessionId !== null ? { coordinatorSessionId: remoteCoordSessionId } : {}),
            });
        }
        if (composed.attached.length > 0) ports.relay.recordSkillAttaches?.(meshId, composed.attached.length);
        return wrap(p.slug, meshId, {
            status: str(body.status) || 'accepted',
            ...(body.receiptUnverified ? { receiptUnverified: true, deliveryNote: body.deliveryNote } : {}),
            launched: body.launched === true,
            coordinatorSessionId: remoteCoordSessionId,
            messageId: str(body.messageId) || null,
            host: p.remote.label,
            via: 'relay',
            ...attached,
        });
    }

    const sent = await localProjectSend(ports, p.mesh, composed.text, clientId);
    if (!sent.ok) return fail(sent.code, sent.error, { ...where, ...sent.detail });
    ports.relay.openThread?.(meshId);
    if (composed.attached.length > 0) ports.relay.recordSkillAttaches?.(meshId, composed.attached.length);
    const { ok: _ok, cursor: _cursor, ...result } = sent;
    return wrap(p.slug, meshId, { ...result, ...attached });
});

export type LocalSendResult =
    | { ok: true; receiptUnverified?: boolean; deliveryNote?: string; status: 'duplicate' | 'queued' | 'accepted'; launched: boolean; coordinatorSessionId: string; messageId: string; cursor: string | null }
    | { ok: false; code: string; error: string; detail: Record<string, unknown> };

/**
 * Ensure a coordinator on THIS daemon and submit the composed text to it
 * (send_chat, origin `assistant`, always queue). Shared by the local verb and
 * the host side of a remote send; neither opens a thread here — the caller
 * does, on the daemon whose assistant asked. `cursor` is the coordinator's
 * newest committed turn before this send (a remote caller relays only later ones).
 */
export async function localProjectSend(ports: AssistantProjectPorts, mesh: LocalMeshEntry, text: string, clientId: string): Promise<LocalSendResult> {
    const meshId = mesh.id;
    const coord = await ensureCoordinator(meshId, coordinatorPorts(ports));
    if (!coord.ok) return { ok: false, code: coord.code, error: coord.error, detail: coord.detail };
    const cursor = ports.coordinatorTurns(coord.sessionId, 1).committed[0]?.attemptId ?? null;
    const messageId = `assistant:${meshId}:${clientId}`;
    const sent = await ports.execute('send_chat', {
        targetSessionId: coord.sessionId,
        text,
        origin: 'assistant',
        policy: { mode: 'queue' },
        messageId,
    });
    if (!sent.success) {
        return {
            ok: false,
            code: str(sent.reason) || str(sent.code) || 'send_failed',
            error: str(sent.error) || 'send_failed',
            detail: { launched: coord.launched, coordinatorSessionId: coord.sessionId, messageId },
        };
    }
    const status = sent.deduplicated === true ? 'duplicate' : sent.queued === true ? 'queued' : 'accepted';
    return { ok: true, status, ...(sent.receiptUnverified ? { receiptUnverified: true, deliveryNote: str(sent.deliveryNote) } : {}), launched: coord.launched, coordinatorSessionId: coord.sessionId, messageId, cursor };
}

// ── project_read ────────────────────────────────────────────────────────────

export function readTailArg(raw: unknown): number {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), PROJECT_READ_MAX_TAIL) : PROJECT_READ_DEFAULT_TAIL;
}

/** project_read body for a mesh hosted HERE (also the host side of a remote read). */
export async function localProjectRead(ports: AssistantProjectPorts, meshId: string, tail: number, continuation?: ReportCursor | null): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string; coordinatorSessionId: string }> {
    if (continuation && 'taskId' in continuation) return { ok: true, result: readTaskReportPage(MeshRuntimeStore.getInstance().db, meshId, continuation) };
    const live = pickCoordinator(ports.coordinators(meshId));
    const sessionId = live?.sessionId ?? ports.lastCoordinatorSessionId(meshId);
    if (continuation) {
        if (continuation.coordinatorSessionId !== sessionId && !ports.coordinatorSessionAuthorized?.(meshId, continuation.coordinatorSessionId)) return { ok: true, result: { success: false, code: 'original_report_unavailable', reason: 'coordinator_session_no_longer_authorized' } };
        if ('attemptId' in continuation) {
            const original = await localAttemptReport(ports, meshId, continuation.coordinatorSessionId, continuation.attemptId);
            return { ok: true, result: original.body ? pageAttemptReport(original.body, continuation, original.source, original.completeness ?? 'final_native') : { success: false, code: 'original_report_unavailable', reason: original.reason } };
        }
        return { ok: true, result: await continueReport(ports.execute, continuation) };
    }
    if (!sessionId) return { ok: true, result: { coordinator: 'none', messages: [] } };
    const chat = await ports.execute('read_chat', { targetSessionId: sessionId, limit: Math.max(tail * 4, 40) });
    if (!chat.success) return { ok: false, error: str(chat.error) || 'read_chat failed', coordinatorSessionId: sessionId };
    return { ok: true, result: { coordinatorSessionId: sessionId, live: !!live, sourceComplete: verifiedNativeRead(chat, sessionId), ...compactTranscriptTail(chat, tail) } };
}

const projectRead = assistantVerb(ASSISTANT_VERB.projectRead, async (ports, args) => {
    const p = await resolveProject(ports, args.project);
    if (!p.ok) return p.result;
    const meshId = p.mesh.id;
    const tail = readTailArg(args.tail);
    const caller = readAssistantSessionId(args);
    const acknowledge = (result: Record<string, unknown>) => {
        if (caller && caller === ports.relay.assistantSessionId?.()) ports.relay.recordProjectRead?.(result, caller);
    };
    const continuation = parseReportContinuation(args);
    if (typeof continuation === 'string') return fail('invalid_args', continuation);
    if (p.remote) {
        const out = await callRemote(ports, { ...p, remote: p.remote }, 'read', { tail, ...(continuation ?? {}) });
        if (!out.ok) return remoteFailure({ project: p.slug, meshId }, p.remote, out, ports, p.followedRemote);
        acknowledge(remoteBody(out));
        return wrap(p.slug, meshId, { ...remoteBody(out), host: p.remote.label, via: 'relay' });
    }
    const r = await localProjectRead(ports, meshId, tail, continuation);
    if (!r.ok) return fail('project_read_failed', r.error, { project: p.slug, meshId, coordinatorSessionId: r.coordinatorSessionId });
    acknowledge(r.result);
    return wrap(p.slug, meshId, r.result);
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

// ── artifact_list / artifact_read ───────────────────────────────────────────

export function localArtifactList(meshId: string, args: Record<string, unknown>) {
    const store = new ArtifactStore(MeshRuntimeStore.getInstance().db);
    const sessionId = str(args.sessionId ?? args.session_id) || undefined;
    const missionId = str(args.missionId ?? args.mission_id) || undefined;
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined;
    const artifacts = store.listByMesh(meshId, { sessionId, missionId, limit });
    return { meshId, artifacts, attachments: artifacts.map(toChatAttachmentMeta) };
}

export async function localArtifactRead(
    ports: AssistantProjectPorts,
    meshId: string,
    args: Record<string, unknown>,
    ctx?: HighFamilyContext,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; code: string; error: string }> {
    const artifactId = str(args.artifactId ?? args.artifact_id);
    if (!artifactId) return { ok: false, code: 'invalid_args', error: 'artifactId required' };
    const store = new ArtifactStore(MeshRuntimeStore.getInstance().db);
    const record = store.getById(artifactId);
    if (!record) return { ok: false, code: 'artifact_not_found', error: `Artifact '${artifactId}' not found.` };
    if (record.meshId !== meshId) {
        return { ok: false, code: 'cross_mesh_artifact_denied', error: `Artifact '${artifactId}' does not belong to mesh '${meshId}'.` };
    }
    const rawOffset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
    const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.min(Math.max(1, Math.floor(args.limit)), MAX_ARTIFACT_MCP_PAGE_BYTES)
        : MAX_ARTIFACT_MCP_PAGE_BYTES;
    const self = ports.selfDaemonId();
    if (record.originDaemonId && (!self || !daemonIdsEquivalent(record.originDaemonId, self)) && ctx?.deps?.dispatchMeshCommand) {
        try {
            const p2pRaw: any = await ctx.deps.dispatchMeshCommand(record.originDaemonId, 'artifact_fetch_origin', {
                artifactId, meshId, offset: rawOffset, limit: rawLimit, asChunks: true,
            });
            const p2pRes = p2pRaw && typeof p2pRaw === 'object' && 'result' in p2pRaw && p2pRaw.result && typeof p2pRaw.result === 'object' ? p2pRaw.result : p2pRaw;
            if (!p2pRes || p2pRes.success === false) {
                return { ok: false, code: str(p2pRes?.code) || 'artifact_origin_unreachable', error: str(p2pRes?.error) || 'Failed to read artifact from origin daemon.' };
            }
            const chunks = Array.isArray(p2pRes.chunks) ? p2pRes.chunks : [];
            const rawContent = chunks.length > 0
                ? Buffer.concat(chunks.map((c: string) => Buffer.from(String(c), 'base64'))).toString('utf8')
                : (typeof p2pRes.content === 'string' ? p2pRes.content : '');
            return {
                ok: true,
                result: {
                    artifactId,
                    artifact: record,
                    attachment: toChatAttachmentMeta(record),
                    content: wrapUntrustedArtifactContent(rawContent),
                    totalBytes: typeof p2pRes.totalBytes === 'number' ? p2pRes.totalBytes : record.sizeBytes,
                    offset: typeof p2pRes.offset === 'number' ? p2pRes.offset : rawOffset,
                    pageBytes: typeof p2pRes.pageBytes === 'number' ? p2pRes.pageBytes : Buffer.byteLength(rawContent, 'utf8'),
                    hasMore: Boolean(p2pRes.hasMore),
                    nextOffset: typeof p2pRes.nextOffset === 'number' ? p2pRes.nextOffset : null,
                    source: 'p2p_origin',
                    originDaemonId: record.originDaemonId,
                },
            };
        } catch (err) {
            return { ok: false, code: 'artifact_origin_unreachable', error: err instanceof Error ? err.message : String(err) };
        }
    }
    try {
        const readRes = store.readArtifactContent(artifactId, { offset: rawOffset, limit: rawLimit });
        return {
            ok: true,
            result: {
                artifactId,
                artifact: record,
                attachment: toChatAttachmentMeta(record),
                content: wrapUntrustedArtifactContent(readRes.content),
                totalBytes: readRes.totalBytes,
                offset: readRes.offset,
                pageBytes: readRes.pageBytes,
                hasMore: readRes.hasMore,
                nextOffset: readRes.nextOffset,
                source: 'local',
            },
        };
    } catch (err: any) {
        return { ok: false, code: str(err?.code) || 'artifact_read_failed', error: err instanceof Error ? err.message : String(err) };
    }
}

const artifactList = assistantVerb(ASSISTANT_VERB.artifactList, async (ports, args) => {
    const p = await resolveProject(ports, args.project);
    if (!p.ok) return p.result;
    const meshId = p.mesh.id;
    const sessionId = str(args.sessionId ?? args.session_id) || undefined;
    const missionId = str(args.missionId ?? args.mission_id) || undefined;
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined;
    if (p.remote) {
        const out = await callRemote(ports, { ...p, remote: p.remote }, 'artifact_list', {
            ...(sessionId ? { sessionId } : {}),
            ...(missionId ? { missionId } : {}),
            ...(limit !== undefined ? { limit } : {}),
        });
        if (!out.ok) return remoteFailure({ project: p.slug, meshId }, p.remote, out, ports, p.followedRemote);
        const body = remoteBody(out);
        const artifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
        const attachments = Array.isArray(body.attachments) ? body.attachments : [];
        return {
            ...wrap(p.slug, meshId, { ...body, artifacts, attachments, host: p.remote.label, via: 'relay' }),
            artifacts,
            attachments,
        };
    }
    const listed = localArtifactList(meshId, args);
    return { ...wrap(p.slug, meshId, listed), artifacts: listed.artifacts, attachments: listed.attachments };
});

const artifactRead = assistantVerb(ASSISTANT_VERB.artifactRead, async (ports, args, ctx) => {
    const artifactId = str(args.artifactId ?? args.artifact_id);
    if (!artifactId) return fail('invalid_args', 'artifactId required');
    const p = await resolveProject(ports, args.project);
    if (!p.ok) return p.result;
    const meshId = p.mesh.id;
    const rawOffset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
    const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.min(Math.max(1, Math.floor(args.limit)), MAX_ARTIFACT_MCP_PAGE_BYTES)
        : MAX_ARTIFACT_MCP_PAGE_BYTES;
    if (p.remote) {
        const out = await callRemote(ports, { ...p, remote: p.remote }, 'artifact_read', { artifactId, offset: rawOffset, limit: rawLimit });
        if (!out.ok) return remoteFailure({ project: p.slug, meshId }, p.remote, out, ports, p.followedRemote);
        const body = remoteBody(out);
        return { ...wrap(p.slug, meshId, { ...body, host: p.remote.label, via: 'relay' }), ...body };
    }
    const read = await localArtifactRead(ports, meshId, args, ctx);
    if (!read.ok) return fail(read.code, read.error, { project: p.slug, meshId });
    return { ...wrap(p.slug, meshId, read.result), ...read.result };
});

export const assistantProjectHandlers: Record<string, HighFamilyHandler> = {
    ...remoteProjectHandlers,
    [ASSISTANT_VERB.projectAttachRemote]: assistantVerb(ASSISTANT_VERB.projectAttachRemote, async (ports, args, ctx) => {
        const p = await resolveProject(ports, args.project);
        if (!p.ok) return p.result;
        if (p.remote) return fail('project_host_required', 'Run attachment on this project host.');
        return attachRemoteProject(ctx, { meshId: p.mesh.id, targetDaemonId: args.targetDaemonId });
    }),
    [ASSISTANT_VERB.projects]: projects,
    [ASSISTANT_VERB.environment]: environment,
    [ASSISTANT_VERB.projectStatus]: projectStatus,
    [ASSISTANT_VERB.projectSend]: projectSend,
    [ASSISTANT_VERB.projectRead]: projectRead,
    [ASSISTANT_VERB.projectAdd]: projectAdd,
    [ASSISTANT_VERB.discoverRepos]: discover,
    [ASSISTANT_VERB.artifactList]: artifactList,
    [ASSISTANT_VERB.artifactRead]: artifactRead,
};

export const assistantProjectSpecs = defineCommandSpecs('high', assistantProjectHandlers, {
    ...remoteProjectSpecs,
    [ASSISTANT_VERB.projectAttachRemote]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.environment]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.projects]: { sources: [...ASSISTANT_PROJECTS_SOURCES] },
    [ASSISTANT_VERB.projectStatus]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.projectSend]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.projectRead]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.projectAdd]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.discoverRepos]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.artifactList]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.artifactRead]: { sources: [...ASSISTANT_TOOL_SOURCES] },
});

/** Exact attempt recovery shared by restart relay and the roster-gated remote host. */
export async function localAttemptReport(ports: AssistantProjectPorts, meshId: string, sessionId: string, attemptId: string) {
    const authorized = ports.coordinatorSessionAuthorized?.(meshId, sessionId)
        ?? (ports.lastCoordinatorSessionId(meshId) === sessionId || ports.coordinators(meshId).some(c => c.sessionId === sessionId));
    if (!authorized) return { body: null, source: 'unavailable', reason: 'coordinator_session_no_longer_authorized' };
    const runtime = MeshRuntimeStore.getInstance();
    return recoverAttemptReport(runtime.db, runtime.turnStore().getAttempt(attemptId), meshId, sessionId, ports.execute);
}
