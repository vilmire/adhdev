/**
 * Compact projections for the assistant project verbs (design
 * 2026-10-07-assistant-layer.md §4.2, §4.4, §4.6). Pure functions — the
 * verbs gather the inputs through `AssistantProjectPorts`.
 *
 * Content boundary: `projects` / `project_status` carry identifiers, enums,
 * counts, labels the operator set (machine nickname, mesh name), mission
 * titles and timestamps — no transcript text. `project_read` is the one verb
 * that returns coordinator transcript text, as its tool contract says.
 */

import { canonicalDaemonId, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import type { AssistantCoordinatorView } from './coordinator-lifecycle.js';
import type { QueueCounts } from './assistant-project-ports.js';
import type { ProjectUnreachableReason } from './assistant-remote-host.js';

/**
 * Scratch meshes (§4.2) are listed apart and not treated as projects:
 * `test-repo`, `scratch/*`, `local:*`, and repos under a temp directory.
 * A repo with no remote is still a project — onboarding gives it a
 * `local/<name>` or path identity, and the owner's local-only repos look
 * exactly like that.
 */
export function isUnmanagedRepoIdentity(repoIdentity: string | undefined): boolean {
    const id = String(repoIdentity ?? '').trim();
    if (!id) return true;
    if (/^test-repo$/i.test(id) || /^scratch\//i.test(id) || /^local:/i.test(id)) return true;
    return /^(?:\/private)?\/tmp\//.test(id) || /^\/var\/folders\//.test(id) || /^[A-Za-z]:[\\/].*[\\/](?:Temp|tmp)[\\/]/i.test(id);
}

function readText(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function shortId(id: string): string {
    return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

/** Label of the daemon hosting a mesh: the host node's machine nickname, else a short daemon id. */
export function meshHostLabel(mesh: LocalMeshEntry, selfDaemonId: string): string {
    const host = resolveMeshHostStatus(mesh, { localDaemonId: selfDaemonId });
    const hostId = readText(host.hostDaemonId);
    const node = (mesh.nodes ?? []).find((n) => (hostId && daemonIdsEquivalent(readText(n.daemonId), hostId)) || (!!host.hostNodeId && n.id === host.hostNodeId));
    return readText(node?.machineNickname) || (hostId ? shortId(canonicalDaemonId(hostId) ?? hostId) : 'unknown host');
}

export type CoordinatorState = 'none' | 'idle' | 'working' | 'waiting';

export function coordinatorState(views: readonly AssistantCoordinatorView[]): CoordinatorState {
    if (views.length === 0) return 'none';
    if (views.some((v) => v.modalParked)) return 'waiting';
    return views.some((v) => !v.idle) ? 'working' : 'idle';
}

export interface ProjectRow {
    slug: string;
    meshId: string;
    name: string;
    repo: string;
    /** `here`: this daemon hosts the mesh. `remote`: another daemon does; it is driven by relay (owner decision 2026-10-08). */
    hosting: 'here' | 'remote';
    /** `this machine`, or the remote host's label. */
    host: string;
    /** Remote only: same as `host`. */
    hostLabel?: string;
    /** `local` (hosted here), `relay` (remote, reachable now) or `unreachable` (with `unreachableReason`). */
    reachability: 'local' | 'relay' | 'unreachable';
    unreachableReason?: ProjectUnreachableReason;
    coordinator?: CoordinatorState;
    threadOpen?: boolean | null;
    queue?: QueueCounts | null;
    activeMissions?: number | null;
    pendingApprovals?: number;
}

export interface MachineSummary {
    label: string;
    daemonId: string | null;
    os: string | null;
    build: string | null;
    /** True for this daemon; null when this daemon holds no liveness for it. */
    online: boolean | null;
    self: boolean;
}

/**
 * Machines across every mesh's nodes, one per daemon (canonical id), plus
 * this daemon. Labels and platform come from what the nodes report.
 */
export function machinesSummary(meshes: readonly LocalMeshEntry[], selfDaemonId: string, selfLabel?: string): MachineSummary[] {
    const selfKey = canonicalDaemonId(selfDaemonId) ?? selfDaemonId;
    const facts = new Map<string, { daemonId: string | null; nick: string; os: string; build: string; self: boolean }>();
    if (selfKey) facts.set(selfKey, { daemonId: selfDaemonId || null, nick: selfLabel ?? '', os: process.platform, build: '', self: true });
    for (const mesh of meshes) {
        for (const node of mesh.nodes ?? []) {
            const raw = readText(node.daemonId);
            const self = !raw || (!!selfDaemonId && daemonIdsEquivalent(raw, selfDaemonId));
            const key = self ? selfKey : canonicalDaemonId(raw) ?? raw;
            if (!key) continue;
            const f = facts.get(key) ?? { daemonId: raw || null, nick: '', os: '', build: '', self };
            f.nick ||= readText(node.machineNickname);
            f.os ||= readText(node.reportedPlatform);
            f.build ||= readText(node.reportedDaemonBuildVersion);
            facts.set(key, f);
        }
    }
    return [...facts.entries()]
        .map(([key, f]) => ({
            label: f.nick || (f.self ? 'this machine' : `daemon ${shortId(key)}`),
            daemonId: f.daemonId,
            os: f.os || null,
            build: f.build || null,
            online: f.self ? true : null,
            self: f.self,
        }))
        .sort((a, b) => Number(b.self) - Number(a.self) || a.label.localeCompare(b.label));
}

// ── project_status ─────────────────────────────────────────────────────────

function rec(v: unknown): Record<string, any> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null;
}

export interface ProjectStatusExtras {
    queue: QueueCounts | null;
    pendingApprovals: number;
    coordinator: CoordinatorState;
    threadOpen: boolean | null;
    lastRelayAt: number | null;
}

/** The compact projection of a `mesh_status_view` answer (§4.4 project_status). */
export function compactProjectStatus(view: Record<string, unknown>, extras: ProjectStatusExtras): Record<string, unknown> {
    const routes = rec(view.routes) ?? {};
    const statusNodes: any[] = Array.isArray(rec(view.status)?.nodes) ? rec(view.status)!.nodes : [];
    const memberNodes: any[] = Array.isArray(rec(rec(view.membership)?.mesh)?.nodes) ? rec(rec(view.membership)!.mesh)!.nodes : [];
    const nodes = statusNodes.length > 0 ? statusNodes : memberNodes;
    const machines = nodes.map((n) => {
        const id = readText(n?.id) || readText(n?.nodeId);
        const local = rec(routes[id])?.route === 'local';
        return {
            node: id,
            label: readText(n?.machineNickname) || null,
            os: readText(n?.reportedPlatform) || null,
            build: readText(n?.reportedDaemonBuildVersion) || null,
            online: local || readText(n?.machineStatus) === 'online',
            ...(readText(n?.worktreeBranch) ? { branch: readText(n.worktreeBranch) } : {}),
        };
    });
    const missionList: any[] = Array.isArray(rec(rec(view.missions)?.list)?.missions) ? rec(rec(view.missions)!.list)!.missions : [];
    const activeMissions = missionList
        .filter((m) => readText(m?.status) === 'active' || readText(m?.status) === 'paused')
        .map((m) => ({ id: readText(m?.id), title: readText(m?.title), status: readText(m?.status) }));
    return {
        machines,
        machinesOnline: machines.filter((m) => m.online).length,
        queue: extras.queue,
        activeMissions,
        failedTasks: extras.queue?.failed ?? null,
        pendingApprovals: extras.pendingApprovals,
        coordinator: extras.coordinator,
        threadOpen: extras.threadOpen,
        lastRelayAt: extras.lastRelayAt ? new Date(extras.lastRelayAt).toISOString() : null,
    };
}

// ── project_read ───────────────────────────────────────────────────────────

export const PROJECT_READ_DEFAULT_TAIL = 10;
export const PROJECT_READ_MAX_TAIL = 50;
export const PROJECT_READ_MESSAGE_MAX_CHARS = 4_000;

function messageText(m: any): string {
    const c = m?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : readText(p?.text) ? p.text : '')).join('');
    return typeof m?.text === 'string' ? m.text : '';
}

/** Same visibility rule as the MCP read_chat compact mode: user/assistant bubbles, no tool/terminal/system chatter. */
function isVisible(m: any): boolean {
    if (!m || typeof m !== 'object') return false;
    const role = readText(m.role).toLowerCase();
    if (role !== 'user' && role !== 'assistant' && role !== 'agent') return false;
    const kind = readText(m.kind ?? m.type ?? m.messageKind).toLowerCase();
    if (['tool', 'tool_call', 'tool_result', 'terminal', 'internal', 'control', 'debug', 'status'].includes(kind)) return false;
    const meta = m.meta ?? m.metadata;
    return !(meta?.internal === true || meta?.debug === true || meta?.control === true || meta?.userVisible === false);
}

export function compactTranscriptTail(readChat: Record<string, unknown>, tail: number): Record<string, unknown> {
    const messages: any[] = Array.isArray(readChat.messages) ? readChat.messages : [];
    const visible = messages.filter(isVisible);
    const picked = visible.slice(-tail).map((m) => {
        const text = messageText(m);
        const truncated = text.length > PROJECT_READ_MESSAGE_MAX_CHARS;
        const at = typeof m.timestamp === 'number' ? new Date(m.timestamp).toISOString() : readText(m.timestamp) || readText(m.createdAt) || undefined;
        return {
            role: readText(m.role).toLowerCase() === 'user' ? 'user' : 'assistant',
            text: truncated ? `${text.slice(0, PROJECT_READ_MESSAGE_MAX_CHARS)}…` : text,
            ...(truncated ? { truncated: true } : {}),
            ...(at ? { at } : {}),
        };
    });
    return {
        messages: picked,
        visibleCount: visible.length,
        omitted: Math.max(0, visible.length - picked.length),
        ...(typeof readChat.status === 'string' ? { status: readChat.status } : {}),
    };
}
