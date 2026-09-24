/**
 * Mesh sender verification — who may run a command that arrived over the
 * daemon↔daemon mesh relay (router source `mesh`).
 *
 * A mesh command crosses daemons over an authenticated P2P channel; the
 * receiving transport (daemon-cloud `CloudCommandTransports.handleMeshCommand`)
 * stamps the authenticated peer's daemon id as the router-internal arg
 * {@link MESH_SENDER_DAEMON_ID_ARG} — as a `withMeshDirectDispatch` extra, so it
 * OVERRIDES anything the peer put in its own args. That arg is the ONLY sender
 * identity this module reads. Every id the payload carries (meshId, nodeId,
 * meshContext.coordinatorDaemonId, inlineMesh, …) is a CLAIM that is checked
 * against state this daemon holds, never an identity.
 *
 * Each command that accepts the `mesh` source declares a {@link MeshSenderClass}
 * on its `CommandSpec` (`meshSender`); the router evaluates it before the
 * handler runs (`DaemonCommandRouter.execute`). A command accepting `mesh`
 * without a declared class is refused (fail closed) and is caught by
 * test/commands/mesh-sender-registry.test.ts.
 *
 * Peers are same-account daemons, so this is robustness against a stale or
 * buggy daemon acting on wrong ids more than a security boundary — but the
 * owner decision (2026-09-24 audit) is that it fails closed, including session
 * ownership: a mesh peer must not drive a local user's session.
 *
 * ─── Roster evidence ────────────────────────────────────────────────────
 *
 * `meshes.json` is machine-local and normally populated only on the
 * coordinator; a worker daemon learns a roster from its inline-mesh cache
 * (`inlineMesh` carried by earlier commands) or not at all. The roster answer
 * therefore takes, in order:
 *   1. the LOCAL mesh view (inline cache, then local config) — authoritative
 *      when it has nodes: sender on it ⇒ accept;
 *   2. local session stamps — a live session on this daemon stamped
 *      `meshNodeFor = <mesh>` with `meshCoordinatorDaemonId ≡ sender` is this
 *      daemon's own record that the sender coordinates that mesh here;
 *   3. only when (1) knows nothing: the payload's `inlineMesh`, accepted as
 *      evidence only when it is self-consistent — it names this mesh, lists
 *      the sender AND lists this daemon (a peer cannot assert membership of a
 *      mesh this daemon is not on).
 * No evidence at all ⇒ refuse (`roster_unknown`).
 */
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { readMeshNodeDaemonId } from '../mesh/mesh-node-identity.js';
import { resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import { LOG } from '../logging/logger.js';

/**
 * rc.37 Finding A: the router-internal arg the receiving mesh transport stamps
 * with the daemon id of the authenticated P2P peer a command arrived from.
 * Leading underscore = router-internal: strict decoders strip it, and no wire
 * contract carries it. The router drops it from every non-`mesh` command so
 * only the mesh transport can present one.
 */
export const MESH_SENDER_DAEMON_ID_ARG = '_meshSenderDaemonId';

/** The transport-stamped sender daemon id of a mesh command, or '' when absent. */
export function readMeshSender(args: unknown): string {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
    const value = (args as Record<string, unknown>)[MESH_SENDER_DAEMON_ID_ARG];
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Who may send a mesh-sourced command:
 *  - `roster`: a daemon on the roster of the mesh the command names.
 *  - `node_owner`: the daemon owning the payload's node on that mesh's roster
 *    (a worker reporting about its own node).
 *  - `session_coordinator`: the target session is a mesh-owned session on this
 *    daemon whose stamped coordinator daemon is the sender, or the sender hosts
 *    that session's mesh.
 *  - `any_member_mesh`: a daemon on the roster of a mesh this daemon belongs to
 *    (the named mesh, when the command names one).
 *  - `pairing_member`: the joining daemon itself — the sender must be the daemon
 *    the join request's `memberNode` names (it is not on the host's roster yet;
 *    the pairing token authorises the join, the handler checks it).
 *  - `authenticated_peer`: any authenticated same-account peer. For commands a
 *    receiving daemon cannot tie to a roster (read-only probes, launch) — a
 *    worker daemon usually holds no roster, so a roster requirement there would
 *    refuse its own coordinator.
 */
export type MeshSenderClass =
    | 'roster'
    | 'node_owner'
    | 'session_coordinator'
    | 'any_member_mesh'
    | 'pairing_member'
    | 'authenticated_peer';

export const MESH_SENDER_CLASSES: readonly MeshSenderClass[] = [
    'roster', 'node_owner', 'session_coordinator', 'any_member_mesh', 'pairing_member', 'authenticated_peer',
];

export type MeshSenderRefusal =
    | 'mesh_sender_unknown'
    | 'mesh_sender_policy_missing'
    | 'mesh_sender_not_on_roster'
    | 'mesh_sender_not_node_owner'
    | 'mesh_sender_not_session_coordinator'
    | 'mesh_session_not_mesh_owned'
    | 'mesh_coordinator_stamp_mismatch'
    | 'mesh_sender_not_join_member';

export type MeshSenderVerdict =
    | { ok: true; sender: string; evidence: string }
    | { ok: false; sender: string; refusal: MeshSenderRefusal; detail: string };

/** What the gate reads from the receiving daemon. Everything here is local state. */
export interface MeshSenderGateDeps {
    /** This daemon's own id (`statusInstanceId`), when the host told us. */
    selfDaemonId?: string;
    /** The local mesh view for `meshId` (inline cache, then local config) — never the payload's. */
    getLocalMesh(meshId: string): Promise<any | null | undefined>;
    /** Every mesh this daemon knows locally (inline cache + local config). */
    listLocalMeshes(): Promise<any[]> | any[];
    /** A live session's settings; `null` when no such session is live here. */
    getSessionSettings(sessionId: string): Record<string, unknown> | null;
    /** Settings of every live session on this daemon. */
    listSessionSettings(): Array<{ sessionId: string; settings: Record<string, unknown> }>;
    /** Resolve a `mesh_forward_event` payload's mesh the way its handler does. */
    resolveForwardEventMeshId?(payload: Record<string, unknown>): string;
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nodesOf(mesh: unknown): Record<string, unknown>[] {
    const nodes = record(mesh)?.nodes;
    return Array.isArray(nodes) ? nodes.filter((n): n is Record<string, unknown> => !!record(n)) : [];
}

function sameDaemon(a: string | undefined, b: string | undefined): boolean {
    return !!a && !!b && daemonIdsEquivalent(a, b);
}

function meshHostDaemonId(mesh: unknown, selfDaemonId?: string): string | undefined {
    try {
        return resolveMeshHostStatus(mesh, selfDaemonId ? { localDaemonId: selfDaemonId } : undefined).hostDaemonId;
    } catch {
        return undefined;
    }
}

function senderOnMesh(mesh: unknown, sender: string, selfDaemonId?: string): boolean {
    if (nodesOf(mesh).some((node) => sameDaemon(readMeshNodeDaemonId(node), sender))) return true;
    return sameDaemon(meshHostDaemonId(mesh, selfDaemonId), sender);
}

/** The mesh a command names: top-level `meshId`, else `meshContext.meshId`. */
export function readCommandMeshId(args: Record<string, unknown>): string {
    return str(args.meshId) || str(record(args.meshContext)?.meshId);
}

/** The session a command addresses (same precedence as the router's owner forward). */
export function readCommandSessionId(args: Record<string, unknown>): string {
    return str(args.targetSessionId) || str(args.sessionId) || str(args.instanceId);
}

type RosterAnswer =
    | { known: true; onRoster: boolean; source: string; mesh?: unknown }
    | { known: false };

async function rosterAnswer(
    deps: MeshSenderGateDeps,
    meshId: string,
    sender: string,
    args: Record<string, unknown>,
): Promise<RosterAnswer> {
    let local: unknown;
    try { local = await deps.getLocalMesh(meshId); } catch { local = undefined; }
    const localKnown = nodesOf(local).length > 0;
    if (localKnown && senderOnMesh(local, sender, deps.selfDaemonId)) {
        return { known: true, onRoster: true, source: 'local_roster', mesh: local };
    }
    if (sessionStampNamesCoordinator(deps, meshId, sender)) {
        return { known: true, onRoster: true, source: 'session_stamp', mesh: localKnown ? local : undefined };
    }
    if (localKnown) return { known: true, onRoster: false, source: 'local_roster', mesh: local };
    // (3) payload inlineMesh — only when this daemon knows nothing of the mesh,
    // and only when it is self-consistent (names this mesh, lists sender AND us).
    const inline = record(args.inlineMesh);
    if (inline && nodesOf(inline).length > 0) {
        const inlineId = str(inline.id) || str(inline.meshId);
        if (inlineId && inlineId !== meshId) return { known: false };
        const self = str(deps.selfDaemonId);
        // No host synthesis here (it can name the evaluating daemon): the inline
        // roster must list both daemons as nodes or as its declared host.
        if (!self || !senderOnMesh(inline, self)) return { known: false };
        return { known: true, onRoster: senderOnMesh(inline, sender), source: 'payload_inline_self_consistent', mesh: inline };
    }
    return { known: false };
}

function sessionStampNamesCoordinator(deps: MeshSenderGateDeps, meshId: string | undefined, sender: string): boolean {
    let sessions: Array<{ sessionId: string; settings: Record<string, unknown> }> = [];
    try { sessions = deps.listSessionSettings(); } catch { sessions = []; }
    return sessions.some(({ settings }) => {
        const stampedMesh = str(settings.meshNodeFor);
        if (!stampedMesh || (meshId && stampedMesh !== meshId)) return false;
        return sameDaemon(str(settings.meshCoordinatorDaemonId), sender);
    });
}

function refuse(sender: string, refusal: MeshSenderRefusal, detail: string): MeshSenderVerdict {
    return { ok: false, sender, refusal, detail };
}

async function checkRoster(deps: MeshSenderGateDeps, meshId: string, sender: string, args: Record<string, unknown>): Promise<MeshSenderVerdict> {
    if (!meshId) return refuse(sender, 'mesh_sender_not_on_roster', 'command names no mesh');
    const answer = await rosterAnswer(deps, meshId, sender, args);
    if (!answer.known) return refuse(sender, 'mesh_sender_not_on_roster', `roster_unknown: this daemon holds no roster for mesh ${meshId}`);
    if (!answer.onRoster) return refuse(sender, 'mesh_sender_not_on_roster', `sender is not on the roster of mesh ${meshId} (${answer.source})`);
    return { ok: true, sender, evidence: `${answer.source}:${meshId}` };
}

async function checkAnyMemberMesh(deps: MeshSenderGateDeps, sender: string, args: Record<string, unknown>): Promise<MeshSenderVerdict> {
    const named = readCommandMeshId(args);
    if (named) return checkRoster(deps, named, sender, args);
    let meshes: any[] = [];
    try { meshes = await deps.listLocalMeshes(); } catch { meshes = []; }
    const known = meshes.filter((m) => nodesOf(m).length > 0);
    const hit = known.find((m) => senderOnMesh(m, sender, deps.selfDaemonId));
    if (hit) return { ok: true, sender, evidence: `local_roster:${str(record(hit)?.id) || '?'}` };
    if (sessionStampNamesCoordinator(deps, undefined, sender)) return { ok: true, sender, evidence: 'session_stamp' };
    return refuse(sender, 'mesh_sender_not_on_roster', known.length === 0
        ? 'roster_unknown: this daemon holds no mesh roster'
        : `sender is on none of the ${known.length} mesh roster(s) this daemon holds`);
}

async function checkNodeOwner(deps: MeshSenderGateDeps, sender: string, args: Record<string, unknown>): Promise<MeshSenderVerdict> {
    const meshId = str(args.meshId) || str(deps.resolveForwardEventMeshId?.(args));
    if (!meshId) return refuse(sender, 'mesh_sender_not_on_roster', 'the event names no resolvable mesh');
    let mesh: unknown;
    try { mesh = await deps.getLocalMesh(meshId); } catch { mesh = undefined; }
    const nodes = nodesOf(mesh);
    if (nodes.length === 0) return refuse(sender, 'mesh_sender_not_on_roster', `roster_unknown: this daemon holds no roster for mesh ${meshId}`);
    const nodeId = str(args.nodeId);
    const workspace = str(args.workspace);
    const node = nodeId
        ? nodes.find((n) => meshNodeIdMatches(n as any, nodeId))
        : workspace ? nodes.find((n) => str(n.workspace) === workspace) : undefined;
    if (nodeId && !node) return refuse(sender, 'mesh_sender_not_node_owner', `node ${nodeId} is not on the roster of mesh ${meshId}`);
    if (node) {
        const owner = readMeshNodeDaemonId(node);
        if (!sameDaemon(owner, sender)) {
            return refuse(sender, 'mesh_sender_not_node_owner', `node ${nodeId || workspace} is owned by ${owner ? owner.slice(0, 20) : 'no daemon'} on mesh ${meshId}`);
        }
        return { ok: true, sender, evidence: `node_owner:${meshId}/${nodeId || workspace}` };
    }
    // No node reference at all: the best available check is roster membership.
    if (!senderOnMesh(mesh, sender, deps.selfDaemonId)) {
        return refuse(sender, 'mesh_sender_not_on_roster', `sender is not on the roster of mesh ${meshId}`);
    }
    return { ok: true, sender, evidence: `roster(no node named):${meshId}` };
}

async function checkSessionAnchor(
    deps: MeshSenderGateDeps,
    sessionId: string,
    settings: Record<string, unknown>,
    sender: string,
    args: Record<string, unknown>,
): Promise<MeshSenderVerdict> {
    const meshId = str(settings.meshNodeFor) || str(settings.meshCoordinatorFor);
    if (!meshId) return refuse(sender, 'mesh_session_not_mesh_owned', `session ${sessionId} carries no mesh stamp`);
    const anchor = str(settings.meshCoordinatorDaemonId);
    if (sameDaemon(anchor, sender)) return { ok: true, sender, evidence: `session_anchor:${sessionId}` };
    let mesh: unknown;
    try { mesh = await deps.getLocalMesh(meshId); } catch { mesh = undefined; }
    if (mesh && sameDaemon(meshHostDaemonId(mesh, deps.selfDaemonId), sender)) {
        return { ok: true, sender, evidence: `mesh_host:${meshId}` };
    }
    // First binding: a mesh session nobody has anchored yet may be bound by the
    // dispatch that stamps the anchor — provided it anchors the SENDER (checked
    // separately as mesh_coordinator_stamp_mismatch) on the session's own mesh.
    if (!anchor) {
        const meshContext = record(args.meshContext);
        if (meshContext && str(meshContext.meshId) === meshId && sameDaemon(str(meshContext.coordinatorDaemonId), sender)) {
            return { ok: true, sender, evidence: `first_binding:${sessionId}` };
        }
    }
    return refuse(sender, 'mesh_sender_not_session_coordinator', anchor
        ? `session ${sessionId} is coordinated by ${anchor.slice(0, 20)}, and the sender is not the host of mesh ${meshId}`
        : `session ${sessionId} has no coordinator anchor, and the sender is not the host of mesh ${meshId}`);
}

async function checkSessionCoordinator(deps: MeshSenderGateDeps, sender: string, args: Record<string, unknown>): Promise<MeshSenderVerdict> {
    // agent_command meshContext: a peer may not re-point a session's
    // coordinator anchor to a third daemon.
    const stampClaim = str(record(args.meshContext)?.coordinatorDaemonId);
    if (stampClaim && !sameDaemon(stampClaim, sender)) {
        return refuse(sender, 'mesh_coordinator_stamp_mismatch', `meshContext.coordinatorDaemonId ${stampClaim.slice(0, 20)} is not the sender`);
    }
    const sessionId = readCommandSessionId(args);
    if (sessionId) {
        const settings = deps.getSessionSettings(sessionId);
        if (!settings) return refuse(sender, 'mesh_session_not_mesh_owned', `session ${sessionId} is not live on this daemon`);
        return checkSessionAnchor(deps, sessionId, settings, sender, args);
    }
    // A (mesh, task)-addressed command (deposit_worker_mailbox): the session is
    // the local worker whose assignment stamp names that task.
    const meshId = readCommandMeshId(args);
    const taskId = str(args.taskId);
    if (meshId && taskId) {
        let sessions: Array<{ sessionId: string; settings: Record<string, unknown> }> = [];
        try { sessions = deps.listSessionSettings(); } catch { sessions = []; }
        const worker = sessions.find(({ settings }) => str(settings.meshNodeFor) === meshId && str(settings.meshActiveTaskId) === taskId);
        if (worker) return checkSessionAnchor(deps, worker.sessionId, worker.settings, sender, args);
    }
    // Sessionless (node-scoped) dispatch: the handler resolves the node's
    // session itself; the sender must at least be on that mesh's roster.
    if (meshId) return checkRoster(deps, meshId, sender, args);
    return refuse(sender, 'mesh_session_not_mesh_owned', 'the command names no session and no mesh');
}

function checkPairingMember(sender: string, args: Record<string, unknown>): MeshSenderVerdict {
    const memberNode = record(args.memberNode);
    const memberDaemonId = memberNode ? readMeshNodeDaemonId(memberNode) : undefined;
    if (!sameDaemon(memberDaemonId, sender)) {
        return refuse(sender, 'mesh_sender_not_join_member', memberDaemonId
            ? `memberNode names daemon ${memberDaemonId.slice(0, 20)}, not the sender`
            : 'memberNode names no daemon');
    }
    return { ok: true, sender, evidence: 'pairing_member' };
}

/** Evaluate one mesh-sourced command against its declared class. */
export async function evaluateMeshSender(
    cls: MeshSenderClass | undefined,
    args: Record<string, unknown>,
    deps: MeshSenderGateDeps,
): Promise<MeshSenderVerdict> {
    const sender = readMeshSender(args);
    if (!sender) return refuse('', 'mesh_sender_unknown', 'no transport-stamped sender daemon id');
    if (!cls) return refuse(sender, 'mesh_sender_policy_missing', 'the command declares no meshSender class');
    // A daemon is authoritative about itself (the transport refuses self-dial,
    // so this only arises in tests / a looped-back relay).
    if (sameDaemon(sender, deps.selfDaemonId)) return { ok: true, sender, evidence: 'self' };
    switch (cls) {
        case 'authenticated_peer':
            return { ok: true, sender, evidence: 'authenticated_peer' };
        case 'roster':
            return checkRoster(deps, readCommandMeshId(args), sender, args);
        case 'any_member_mesh':
            return checkAnyMemberMesh(deps, sender, args);
        case 'node_owner':
            return checkNodeOwner(deps, sender, args);
        case 'session_coordinator':
            return checkSessionCoordinator(deps, sender, args);
        case 'pairing_member':
            return checkPairingMember(sender, args);
    }
}

/** The command result for a refusal, plus its ONE warn line. */
export function meshSenderRefusalResult(cmd: string, verdict: Extract<MeshSenderVerdict, { ok: false }>): { success: false; error: MeshSenderRefusal; code: MeshSenderRefusal; detail: string } {
    LOG.warn('MeshSender', `Refused mesh command '${cmd}' from ${verdict.sender ? verdict.sender.slice(0, 24) : 'an unidentified daemon'}: ${verdict.refusal} — ${verdict.detail}`);
    return { success: false, error: verdict.refusal, code: verdict.refusal, detail: verdict.detail };
}

/**
 * Forwarder side of the roster evidence: when a daemon relays a mesh-named
 * command to a node's daemon, attach the mesh it resolved (unless the caller
 * already carried one) so a receiving daemon with no roster of its own can
 * still check the sender — self-consistently (see the module header, step 3).
 */
export function rosterEvidenceExtra(args: unknown, mesh: unknown): { inlineMesh?: unknown } {
    const carried = args && typeof args === 'object' ? (args as Record<string, unknown>).inlineMesh : undefined;
    if (carried && typeof carried === 'object') return {};
    return nodesOf(mesh).length > 0 ? { inlineMesh: mesh } : {};
}

const MESH_SENDER_REFUSALS: ReadonlySet<string> = new Set<MeshSenderRefusal>([
    'mesh_sender_unknown',
    'mesh_sender_policy_missing',
    'mesh_sender_not_on_roster',
    'mesh_sender_not_node_owner',
    'mesh_sender_not_session_coordinator',
    'mesh_session_not_mesh_owned',
    'mesh_coordinator_stamp_mismatch',
    'mesh_sender_not_join_member',
]);

/**
 * Whether a router result is a mesh sender refusal — the command never ran. A
 * transport that applies side effects of its own after the router (daemon-cloud's
 * `mesh_forward_event` dashboard mirror) must skip them on a refusal.
 */
export function isMeshSenderRefusalResult(result: unknown): boolean {
    const rec = record(result);
    return !!rec && rec.success === false && typeof rec.code === 'string' && MESH_SENDER_REFUSALS.has(rec.code);
}
