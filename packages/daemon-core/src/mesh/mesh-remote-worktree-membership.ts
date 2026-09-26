/**
 * Coordinator-held membership of worktree nodes that live on ANOTHER machine.
 *
 * Owner principle (2026-09-26): clients only talk to the coordinator daemon,
 * which holds every node of its meshes. A worktree cloned on a remote member
 * (clone_mesh_node forwarded to the source node's daemon) used to reach the
 * coordinator only as an in-memory inline-cache seed (REMOTE-CLONE-CACHE-SEED)
 * or a bootstrap-event hydrate — neither written to the coordinator's
 * meshes.json, so after a coordinator restart the node was known only to the
 * member, and MCP needed a member fan-out to find it.
 *
 * Two halves close that:
 *   1. PERSIST — the node a forwarded clone returns is written to the
 *      coordinator's mesh config with the same shape a local clone gets
 *      (persistRemoteWorktreeNodeToConfig). Idempotent by id.
 *   2. RECONCILE — a member reports the worktree nodes it owns on a mesh once
 *      per coordinator boot on its state push (mesh-node-state-pusher.ts); the
 *      coordinator adopts the ones it does not hold (planMemberWorktreeAdoption),
 *      covering nodes created before (1) or lost to a crash between the clone
 *      reply and the write.
 *
 * Adoption is owner-gated: only a worktree node whose owning daemon IS the
 * authenticated sender (and the owner of the subscribed node), on a mesh this
 * daemon hosts, that is not tombstoned by a removal, and whose id/workspace do
 * not collide with a node the coordinator already holds. Removal semantics are
 * unchanged: remove_mesh_node on a remote worktree removes it on the member
 * FIRST (and only then on the coordinator), so a member never reports a node
 * the coordinator removed; an in-flight report that raced the removal is
 * dropped by the in-memory removal tombstone.
 *
 * P2P only (daemon↔daemon mesh channel) — nothing here reaches the server.
 */
import { daemonIdsEquivalent, meshNodeIdMatches, normalizeMeshNodeId } from '@adhdev/mesh-shared';

/** Upper bound on worktree nodes a member reports per push (meshes cap at 10 nodes). */
export const MEMBER_WORKTREE_REPORT_MAX_NODES = 10;
const MAX_ID_CHARS = 200;
const MAX_PATH_CHARS = 4096;

/** The static scheduling identity of a worktree node — what a remote clone reply carries. */
export interface MemberWorktreeNodeRecord {
    id: string;
    workspace: string;
    repoRoot?: string;
    daemonId: string;
    machineId?: string;
    machineNickname?: string;
    isLocalWorktree: true;
    worktreeBranch?: string;
    clonedFromNodeId?: string;
    capabilities?: string[];
    policy?: Record<string, unknown>;
    userOverrides?: Record<string, unknown>;
    worktreeBootstrap?: { status: string; required?: boolean; startedAt?: string; completedAt?: string };
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ID_CHARS || /[\r\n]/.test(trimmed)) return undefined;
    return trimmed;
}

function readPath(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_PATH_CHARS || /[\r\n\0]/.test(trimmed)) return undefined;
    return trimmed;
}

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
    const record = readRecord(value);
    if (!record) return undefined;
    try {
        return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/**
 * Allow-list projection of a worktree node record, applied by the member before
 * sending and again by the coordinator at ingest. Null when the record is not a
 * worktree node with an id, a workspace and an owning daemon.
 */
export function projectMemberWorktreeNode(raw: unknown): MemberWorktreeNodeRecord | null {
    const node = readRecord(raw);
    if (!node || node.isLocalWorktree !== true) return null;
    const id = readId(normalizeMeshNodeId(node as any));
    const workspace = readPath(node.workspace);
    const daemonId = readId(node.daemonId);
    if (!id || !workspace || !daemonId) return null;
    const bootstrap = readRecord(node.worktreeBootstrap);
    const bootstrapStatus = readId(bootstrap?.status);
    const capabilities = Array.isArray(node.capabilities)
        ? node.capabilities.map(readId).filter((tag): tag is string => !!tag).slice(0, 64)
        : undefined;
    const out: MemberWorktreeNodeRecord = {
        id,
        workspace,
        daemonId,
        isLocalWorktree: true,
    };
    const repoRoot = readPath(node.repoRoot);
    if (repoRoot) out.repoRoot = repoRoot;
    const machineId = readId(node.machineId);
    if (machineId) out.machineId = machineId;
    const machineNickname = readId(node.machineNickname);
    if (machineNickname) out.machineNickname = machineNickname;
    const worktreeBranch = readId(node.worktreeBranch);
    if (worktreeBranch) out.worktreeBranch = worktreeBranch;
    const clonedFromNodeId = readId(node.clonedFromNodeId);
    if (clonedFromNodeId) out.clonedFromNodeId = clonedFromNodeId;
    if (capabilities && capabilities.length > 0) out.capabilities = capabilities;
    const policy = readPlainObject(node.policy);
    if (policy) out.policy = policy;
    const userOverrides = readPlainObject(node.userOverrides);
    if (userOverrides) out.userOverrides = userOverrides;
    if (bootstrapStatus) {
        out.worktreeBootstrap = { status: bootstrapStatus };
        if (typeof bootstrap?.required === 'boolean') out.worktreeBootstrap.required = bootstrap.required;
        const startedAt = readId(bootstrap?.startedAt);
        if (startedAt) out.worktreeBootstrap.startedAt = startedAt;
        const completedAt = readId(bootstrap?.completedAt);
        if (completedAt) out.worktreeBootstrap.completedAt = completedAt;
    }
    return out;
}

/** Sanitize a reported list (bounded, deduped by id). */
export function sanitizeMemberWorktreeNodes(raw: unknown): MemberWorktreeNodeRecord[] {
    if (!Array.isArray(raw)) return [];
    const out: MemberWorktreeNodeRecord[] = [];
    for (const entry of raw) {
        const node = projectMemberWorktreeNode(entry);
        if (!node || out.some(existing => existing.id === node.id)) continue;
        out.push(node);
        if (out.length >= MEMBER_WORKTREE_REPORT_MAX_NODES) break;
    }
    return out;
}

/**
 * Member side: the worktree nodes THIS daemon owns among `nodes` (the union of
 * its inline view and its config for one mesh).
 */
export function collectMemberWorktreeNodes(nodes: unknown[], selfDaemonId: string | undefined): MemberWorktreeNodeRecord[] {
    const self = readId(selfDaemonId);
    if (!self) return [];
    return sanitizeMemberWorktreeNodes(nodes.filter((node) => {
        const daemonId = readId(readRecord(node)?.daemonId);
        return !!daemonId && daemonIdsEquivalent(daemonId, self);
    }));
}

function isTerminalBootstrapStatus(status: unknown): status is 'complete' | 'failed' {
    return status === 'complete' || status === 'failed';
}

export type MemberWorktreeRejectReason =
    | 'not_sender_owned'
    | 'coordinator_owned'
    | 'tombstoned'
    | 'workspace_conflict'
    /** This daemon does not host the mesh (only the host adopts roster members). */
    | 'not_mesh_host'
    /** Neither an inline view nor a config twin could take the node. */
    | 'no_roster';

/** What the coordinator did with one member report. */
export interface MemberWorktreeAdoptionResult {
    adopted: string[];
    healed: string[];
    rejected: Array<{ nodeId: string; reason: MemberWorktreeRejectReason }>;
}

export interface MemberWorktreeAdoptionPlan {
    /** Nodes to register on the coordinator (inline view + config). */
    adopt: MemberWorktreeNodeRecord[];
    /** Known nodes whose held bootstrap is still 'running' while the member reports it terminal. */
    healBootstrap: Array<{ nodeId: string; status: 'complete' | 'failed'; workspace: string; daemonId: string; machineId?: string }>;
    rejected: Array<{ nodeId: string; reason: MemberWorktreeRejectReason }>;
}

/**
 * Coordinator side, pure: which of the member-reported worktree nodes to adopt.
 * `senderDaemonId` is the transport-authenticated sender, `ownerDaemonId` the
 * owner of the node the push subscription is for; both must name the reported
 * node's owning daemon. The caller has already checked that this daemon hosts
 * the mesh.
 */
export function planMemberWorktreeAdoption(args: {
    meshNodes: unknown[];
    reported: MemberWorktreeNodeRecord[];
    senderDaemonId: string;
    ownerDaemonId: string;
    selfDaemonId?: string;
    isTombstoned: (node: MemberWorktreeNodeRecord) => boolean;
}): MemberWorktreeAdoptionPlan {
    const plan: MemberWorktreeAdoptionPlan = { adopt: [], healBootstrap: [], rejected: [] };
    const sender = readId(args.senderDaemonId);
    const owner = readId(args.ownerDaemonId);
    const self = readId(args.selfDaemonId);
    const meshNodes = args.meshNodes.map(readRecord).filter((node): node is Record<string, unknown> => !!node);
    for (const node of args.reported) {
        if (!sender || !owner
            || !daemonIdsEquivalent(node.daemonId, sender)
            || !daemonIdsEquivalent(node.daemonId, owner)) {
            plan.rejected.push({ nodeId: node.id, reason: 'not_sender_owned' });
            continue;
        }
        // A node claiming the coordinator's own daemon is never adopted from a peer.
        if (self && daemonIdsEquivalent(node.daemonId, self)) {
            plan.rejected.push({ nodeId: node.id, reason: 'coordinator_owned' });
            continue;
        }
        const existing = meshNodes.find(entry => meshNodeIdMatches(entry as any, node.id));
        if (existing) {
            const heldStatus = readRecord(existing.worktreeBootstrap)?.status;
            const reportedStatus = node.worktreeBootstrap?.status;
            if (heldStatus === 'running' && isTerminalBootstrapStatus(reportedStatus)) {
                plan.healBootstrap.push({
                    nodeId: node.id,
                    status: reportedStatus,
                    workspace: node.workspace,
                    daemonId: node.daemonId,
                    ...(node.machineId ? { machineId: node.machineId } : {}),
                });
            }
            continue;
        }
        if (args.isTombstoned(node)) {
            plan.rejected.push({ nodeId: node.id, reason: 'tombstoned' });
            continue;
        }
        const workspaceTaken = meshNodes.some(entry => entry.workspace === node.workspace
            && typeof entry.daemonId === 'string' && daemonIdsEquivalent(entry.daemonId, node.daemonId));
        if (workspaceTaken) {
            plan.rejected.push({ nodeId: node.id, reason: 'workspace_conflict' });
            continue;
        }
        plan.adopt.push(node);
    }
    return plan;
}

export type PersistRemoteWorktreeNodeOutcome = 'persisted' | 'already_present' | 'no_config_mesh' | 'invalid' | 'failed';

/**
 * Write a remote-owned worktree node into THIS daemon's meshes.json twin of the
 * mesh — the same shape a local clone registers (mesh-crud clone_mesh_node's
 * addNode call), keyed by the node's own id. Idempotent: a node already present
 * by id is left untouched. A mesh with no config twin (pure inline / cloud mesh)
 * is a no-op, exactly like the local clone branch.
 */
export async function persistRemoteWorktreeNodeToConfig(meshId: string, rawNode: unknown): Promise<PersistRemoteWorktreeNodeOutcome> {
    const node = projectMemberWorktreeNode(rawNode);
    if (!meshId || !node) return 'invalid';
    try {
        const { getMesh, addNode } = await import('../config/mesh-config.js');
        const mesh = getMesh(meshId);
        if (!mesh) return 'no_config_mesh';
        if (mesh.nodes.some(entry => meshNodeIdMatches(entry as any, node.id))) return 'already_present';
        const added = addNode(meshId, {
            id: node.id,
            workspace: node.workspace,
            repoRoot: node.repoRoot ?? node.workspace,
            daemonId: node.daemonId,
            machineId: node.machineId,
            // The owning member's nickname — never this daemon's (see ownerIsRemote).
            machineNickname: node.machineNickname,
            ownerIsRemote: true,
            capabilities: node.capabilities,
            userOverrides: (node.userOverrides ?? {}) as any,
            policy: (node.policy ?? {}) as any,
            isLocalWorktree: true,
            worktreeBranch: node.worktreeBranch,
            clonedFromNodeId: node.clonedFromNodeId,
            worktreeBootstrap: node.worktreeBootstrap as any,
        });
        return added ? 'persisted' : 'no_config_mesh';
    } catch {
        // Mesh at its node cap, or the workspace path already registered.
        return 'failed';
    }
}
