/**
 * Remote-hosted projects (design 2026-10-07-assistant-layer.md §4.2 "자격",
 * owner decision 2026-10-08 closing Q4): the assistant drives every project it
 * can reach. A project whose mesh is hosted by ANOTHER daemon is driven by
 * relaying to that host over the existing daemon↔daemon mesh transport
 * (`dispatchMeshCommand` — cloud P2P, standalone direct WS). Nothing is
 * rehosted.
 *
 * This module is the assistant daemon's (the caller's) half:
 *   - `describeRemoteHost` — who hosts the mesh, the id the host keys it by,
 *     and whether it can be reached right now (`relay`) or not (`unreachable`
 *     with a reason);
 *   - `callRemoteHost` — one `assistant_remote_project` call to the host,
 *     bounded by a deadline, every transport failure folded into
 *     `project_unreachable` with a reason (never a silent drop).
 *
 * The host's half is commands/high-family/assistant-remote.ts.
 */

import { canonicalDaemonId, daemonIdsEquivalent, withStatusProbeMarker } from '@adhdev/mesh-shared';
import { resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import { classifyP2pRelayFailure } from '../mesh/p2p-relay-failure.js';
import { findMeshRelayAnswer } from '../commands/mesh-relay-result.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';

/** The host verb (daemon↔daemon only; source `mesh`). */
export const ASSISTANT_REMOTE_PROJECT_COMMAND = 'assistant_remote_project';

export const ASSISTANT_REMOTE_OPS = ['status', 'send', 'read', 'poll', 'note'] as const;
export type AssistantRemoteOp = typeof ASSISTANT_REMOTE_OPS[number];

/** Why a remote-hosted project cannot be driven right now. */
export type ProjectUnreachableReason =
    | 'host_unknown'
    | 'no_mesh_transport'
    | 'host_offline'
    | 'relay_timeout'
    | 'relay_failed'
    | 'host_refused';

export interface MeshTransportPort {
    dispatch?: (daemonId: string, command: string, args: Record<string, unknown>) => Promise<unknown>;
    peerStatus?: (daemonId: string) => Record<string, unknown> | null;
}

export interface RemoteHostView {
    /** Host node's machine nickname, else a short daemon id. */
    label: string;
    hostDaemonId: string | null;
    /** The id the HOST keys this mesh by (differs from the local id after a standalone address + code pairing). */
    hostMeshId: string;
    reachable: boolean;
    reason?: ProjectUnreachableReason;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function shortId(id: string): string {
    return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

/**
 * The mesh id the host knows this mesh by:
 *   1. `meshHost.hostMeshId` persisted at join (standalone address + code);
 *   2. a member peer-secret record for this host keyed by THIS id → this id;
 *   3. exactly one member peer-secret record for this host → its mesh id;
 *   4. this id (cloud: one id on both sides).
 */
export function resolveHostMeshId(mesh: LocalMeshEntry, hostDaemonId: string | null, peerHostMeshIds: (hostDaemonId: string) => string[]): string {
    const persisted = str((mesh.meshHost as { hostMeshId?: unknown } | undefined)?.hostMeshId);
    if (persisted) return persisted;
    if (!hostDaemonId) return mesh.id;
    let ids: string[] = [];
    try { ids = [...new Set(peerHostMeshIds(hostDaemonId).map(str).filter(Boolean))]; } catch { ids = []; }
    if (ids.includes(mesh.id)) return mesh.id;
    return ids.length === 1 ? ids[0]! : mesh.id;
}

/**
 * Who hosts a mesh this daemon does NOT host, and whether it can be reached.
 * Reachability uses only what this daemon holds: a transport, and — when the
 * transport says its link IS presence (standalone direct WS, `linkIsPresence`)
 * — a connected link. A cloud P2P peer opens on demand, so "not connected yet"
 * there is still `reachable`; the call itself reports a failure.
 */
export function describeRemoteHost(
    mesh: LocalMeshEntry,
    selfDaemonId: string,
    transport: MeshTransportPort,
    peerHostMeshIds: (hostDaemonId: string) => string[] = () => [],
): RemoteHostView {
    const status = resolveMeshHostStatus(mesh, selfDaemonId ? { localDaemonId: selfDaemonId } : undefined);
    const rawHost = str(status.hostDaemonId);
    const hostDaemonId = rawHost && !(selfDaemonId && daemonIdsEquivalent(rawHost, selfDaemonId)) ? rawHost : null;
    const node = hostDaemonId
        ? (mesh.nodes ?? []).find((n) => daemonIdsEquivalent(str(n.daemonId), hostDaemonId) || (!!status.hostNodeId && n.id === status.hostNodeId))
        : undefined;
    const label = str(node?.machineNickname) || (hostDaemonId ? shortId(canonicalDaemonId(hostDaemonId) ?? hostDaemonId) : 'unknown host');
    const hostMeshId = resolveHostMeshId(mesh, hostDaemonId, peerHostMeshIds);
    const base = { label, hostDaemonId, hostMeshId };
    if (!hostDaemonId) return { ...base, reachable: false, reason: 'host_unknown' };
    if (typeof transport.dispatch !== 'function') return { ...base, reachable: false, reason: 'no_mesh_transport' };
    let snapshot: Record<string, unknown> | null = null;
    try { snapshot = transport.peerStatus?.(hostDaemonId) ?? null; } catch { snapshot = null; }
    if (snapshot && snapshot.linkIsPresence === true && snapshot.state !== 'connected') {
        return { ...base, reachable: false, reason: 'host_offline' };
    }
    return { ...base, reachable: true };
}

/** Per-op deadlines: a send may launch a coordinator on the host; a poll must stay cheap. */
export const REMOTE_OP_TIMEOUT_MS: Record<AssistantRemoteOp, number> = {
    status: 20_000,
    send: 90_000,
    read: 30_000,
    poll: 15_000,
    note: 20_000,
};

export type RemoteCallOutcome =
    | { ok: true; result: Record<string, unknown> & { success: true } }
    /** The host answered with a refusal (its own code), e.g. a mesh-sender refusal or `project_not_hosted_here`. */
    | { ok: false; kind: 'refused'; code: string; error: string; result: Record<string, unknown> }
    /** The host could not be reached or did not answer in time. */
    | { ok: false; kind: 'unreachable'; code: 'project_unreachable'; reason: ProjectUnreachableReason; error: string };

function unreachable(reason: ProjectUnreachableReason, error: string): RemoteCallOutcome {
    return { ok: false, kind: 'unreachable', code: 'project_unreachable', reason, error };
}

class RemoteCallTimeout extends Error {}

/**
 * One `assistant_remote_project` call on the host. `poll` carries the status
 * probe marker (the short connect-wait budget — an offline host must not hold
 * the poller for the full connect deadline).
 */
export async function callRemoteHost(
    transport: MeshTransportPort,
    target: Pick<RemoteHostView, 'hostDaemonId' | 'hostMeshId'>,
    op: AssistantRemoteOp,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
): Promise<RemoteCallOutcome> {
    if (!target.hostDaemonId) return unreachable('host_unknown', 'the host daemon of this project is not known here');
    if (typeof transport.dispatch !== 'function') return unreachable('no_mesh_transport', 'this daemon has no mesh transport to the host');
    const payload = { ...args, meshId: target.hostMeshId, op };
    const timeoutMs = opts.timeoutMs ?? REMOTE_OP_TIMEOUT_MS[op];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raw: unknown;
    try {
        raw = await Promise.race([
            transport.dispatch(target.hostDaemonId, ASSISTANT_REMOTE_PROJECT_COMMAND, op === 'poll' ? withStatusProbeMarker(payload) : payload),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new RemoteCallTimeout(`no answer from the host within ${timeoutMs} ms`)), timeoutMs);
                (timer as { unref?: () => void }).unref?.();
            }),
        ]);
    } catch (e) {
        if (e instanceof RemoteCallTimeout) return unreachable('relay_timeout', e.message);
        const c = classifyP2pRelayFailure(e, { command: ASSISTANT_REMOTE_PROJECT_COMMAND, targetDaemonId: target.hostDaemonId });
        const reason: ProjectUnreachableReason = c.code === 'p2p_daemon_offline' ? 'host_offline' : c.code === 'p2p_timeout' ? 'relay_timeout' : 'relay_failed';
        return unreachable(reason, e instanceof Error ? e.message : String(e));
    } finally {
        if (timer) clearTimeout(timer);
    }
    const answer = findMeshRelayAnswer(raw);
    if (!answer) return unreachable('relay_failed', 'the host answered with a malformed relay result');
    if (answer.success === true) return { ok: true, result: answer as Record<string, unknown> & { success: true } };
    // A transport failure can also come back as a structured `{success:false}` payload.
    const transportCode = str(answer.code);
    if (/^p2p_/.test(transportCode) && transportCode !== 'mesh_logic_or_provider_failure') {
        return unreachable(transportCode === 'p2p_daemon_offline' ? 'host_offline' : transportCode === 'p2p_timeout' ? 'relay_timeout' : 'relay_failed', str(answer.error) || transportCode);
    }
    // A host on a build without the verb answers `Unknown command: …`.
    const error = str(answer.error);
    const code = transportCode || (/^unknown command/i.test(error) ? 'host_unsupported' : error) || 'host_refused';
    return { ok: false, kind: 'refused', code, error: error || code, result: answer };
}
