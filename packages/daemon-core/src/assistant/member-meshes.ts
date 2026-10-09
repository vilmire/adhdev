/**
 * Meshes this daemon is a MEMBER of but does not keep in its own meshes.json
 * (design 2026-10-07-assistant-layer.md §4.3, owner decision 2026-10-08 —
 * "drive every project it can reach").
 *
 * A cloud member daemon has no meshes.json record for a mesh another daemon
 * hosts: that record lives on the host. What the member holds is the same
 * evidence it executes routed mesh work with:
 *   1. the router's inline mesh cache — the HOST's own mesh record, carried as
 *      `inlineMesh` on the commands the host relays (name, repoIdentity, nodes,
 *      meshHost). In-memory: empty after a restart until the host sends again;
 *   2. the persisted mesh-host records (mesh/mesh-host-memory.ts — pairing /
 *      session stamp / first dispatch): meshId → host daemon; survives restarts;
 *   3. the persisted node-state push subscriptions
 *      (mesh/mesh-node-state-push-store.ts): host daemon, meshId, this
 *      daemon's node id and workspace; survives restarts.
 * The same union (inline ∪ host records) is what the member's node-state push
 * restores from at boot (commands/mesh-node-state-lifecycle.ts).
 *
 * When only (2)/(3) know a mesh, its name and repoIdentity are not held here;
 * `refreshMemberMeshDescriptors` asks the host once (`get_mesh`, membership
 * only) and keeps the answer in memory. Until then the row is named after this
 * daemon's workspace.
 *
 * In the cloud the member and the host key a mesh by the SAME id, so the id
 * listed here is the host's id (no `hostMeshId`). A standalone address + code
 * pairing writes a meshes.json record instead and never reaches this module.
 *
 * Content: identifiers, the operator-set mesh name and repo identity, workspace
 * paths — what meshes.json itself holds.
 */

import { basename } from 'path';
import { daemonIdsEquivalent, meshNodeIdMatches, readText } from '@adhdev/mesh-shared';
import { resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import { listMeshHostRecords } from '../mesh/mesh-host-memory.js';
import { createFileMeshNodeStatePushPersistence } from '../mesh/mesh-node-state-push-store.js';
import { findMeshRelayAnswer } from '../commands/mesh-relay-result.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import type { MeshTransportPort } from './assistant-remote-host.js';

export interface MemberMeshEvidence {
    selfDaemonId: string;
    /** Ids of the meshes this daemon's own meshes.json holds (they are never repeated here). */
    configMeshIds: ReadonlySet<string>;
    /** The router's inline mesh cache (the host's own records). */
    inlineMeshes: readonly unknown[];
    hostRecords: ReadonlyArray<{ meshId: string; hostDaemonId: string }>;
    pushTargets: ReadonlyArray<{ coordinatorDaemonId: string; meshId: string; nodeId: string; workspace: string }>;
    /** Records fetched from the host by `refreshMemberMeshDescriptors`. */
    described?: (meshId: string) => unknown;
}

function rec(v: unknown): Record<string, any> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null;
}

function nodesOf(mesh: unknown): Record<string, any>[] {
    const nodes = rec(mesh)?.nodes;
    return Array.isArray(nodes) ? nodes.filter((n): n is Record<string, any> => !!rec(n)) : [];
}

/** The host a mesh record declares (never the read-side self synthesis), unless it is this daemon. */
function declaredHost(mesh: unknown, selfDaemonId: string): { hostDaemonId: string; hostNodeId?: string } | null {
    if (!rec(mesh)) return null;
    try {
        const s = resolveMeshHostStatus(mesh, selfDaemonId ? { localDaemonId: selfDaemonId } : undefined);
        const host = readText(s.hostDaemonId);
        if (!host || s.hostSynthesized) return null;
        return { hostDaemonId: host, ...(s.hostNodeId ? { hostNodeId: s.hostNodeId } : {}) };
    } catch {
        return null;
    }
}

function ownsANode(mesh: unknown, selfDaemonId: string): boolean {
    return !!selfDaemonId && nodesOf(mesh).some((n) => daemonIdsEquivalent(readText(n.daemonId), selfDaemonId));
}

/**
 * Member meshes as project inventory entries: `meshHost = {role: 'member',
 * hostDaemonId}` so every consumer (hosting check, host label, relay target)
 * reads them as hosted elsewhere. Pure.
 */
export function collectMemberMeshes(ev: MemberMeshEvidence): LocalMeshEntry[] {
    const self = readText(ev.selfDaemonId);
    const inlineById = new Map<string, Record<string, any>>();
    for (const m of ev.inlineMeshes) {
        const id = readText(rec(m)?.id);
        if (id && !inlineById.has(id)) inlineById.set(id, rec(m)!);
    }
    const recordOf = new Map(ev.hostRecords.map((r) => [readText(r.meshId), readText(r.hostDaemonId)] as const));
    const targetsOf = new Map<string, typeof ev.pushTargets[number][]>();
    for (const t of ev.pushTargets) {
        const id = readText(t.meshId);
        if (id) targetsOf.set(id, [...(targetsOf.get(id) ?? []), t]);
    }
    const ids = [...new Set([...inlineById.keys(), ...recordOf.keys(), ...targetsOf.keys()])].filter((id) => id && !ev.configMeshIds.has(id));
    const out: LocalMeshEntry[] = [];
    for (const id of ids) {
        const inline = inlineById.get(id);
        let described: Record<string, any> | null = null;
        try { described = rec(ev.described?.(id)); } catch { described = null; }
        const source = inline ?? (described && readText(described.id) === id ? described : null);
        const targets = targetsOf.get(id) ?? [];
        // Membership: this daemon owns a node of the record, or holds a host record / push subscription for it.
        if (!recordOf.has(id) && targets.length === 0 && !(source && ownsANode(source, self))) continue;
        const declared = declaredHost(inline, self) ?? declaredHost(described, self);
        const hostDaemonId = declared?.hostDaemonId || recordOf.get(id) || readText(targets[0]?.coordinatorDaemonId);
        if (!hostDaemonId || (self && daemonIdsEquivalent(hostDaemonId, self))) continue;
        const nodes = nodesOf(source).length > 0
            ? nodesOf(source).map((n) => ({ ...n }))
            : targets.map((t) => ({ id: t.nodeId, workspace: t.workspace, daemonId: self }));
        for (const t of targets) {
            if (!nodes.some((n) => meshNodeIdMatches(n as any, t.nodeId))) nodes.push({ id: t.nodeId, workspace: t.workspace, daemonId: self });
        }
        const ownWorkspace = readText(nodes.find((n) => daemonIdsEquivalent(readText(n.daemonId), self))?.workspace);
        const now = new Date(0).toISOString();
        out.push({
            id,
            name: readText(source?.name) || (ownWorkspace ? basename(ownWorkspace) : '') || id,
            repoIdentity: readText(source?.repoIdentity),
            policy: {},
            coordinator: {},
            meshHost: {
                role: 'member',
                hostDaemonId,
                ...(declared?.hostNodeId ? { hostNodeId: declared.hostNodeId } : {}),
            },
            nodes: nodes as unknown as LocalMeshEntry['nodes'],
            createdAt: readText(source?.createdAt) || now,
            updatedAt: readText(source?.updatedAt) || now,
        } as LocalMeshEntry);
    }
    return out;
}

// ── live source ────────────────────────────────────────────────────────────

export interface MemberMeshSource {
    selfDaemonId(): string;
    /** The router's inline mesh cache values. */
    inlineMeshes(): unknown[];
}

let source: MemberMeshSource | null = null;
const pushPersistence = createFileMeshNodeStatePushPersistence();

/** Boot (assistant runtime) installs the live source; null clears it. */
export function setAssistantMemberMeshSource(next: MemberMeshSource | null): void {
    source = next;
}

interface Descriptor { mesh: Record<string, any> | null; at: number }
const descriptors = new Map<string, Descriptor>();
const inflight = new Map<string, Promise<void>>();

/** A failed ask (host offline, older build) is retried after this long. */
export const DESCRIPTOR_FAILED_RETRY_MS = 60_000;
export const DESCRIPTOR_FETCH_TIMEOUT_MS = 4_000;

/** Tests: forget the fetched host records. */
export function resetMemberMeshDescriptorsForTests(): void {
    descriptors.clear();
    inflight.clear();
}

/**
 * This daemon's project inventory: its meshes.json plus the meshes it is a
 * member of (above). Never throws; a member source failure lists config only.
 */
export function withMemberMeshes(configMeshes: LocalMeshEntry[]): LocalMeshEntry[] {
    if (!source) return configMeshes;
    try {
        const members = collectMemberMeshes({
            selfDaemonId: source.selfDaemonId(),
            // A standalone member keeps its own local id in meshes.json and the
            // host's id in meshHost.hostMeshId; the host's id must not be listed
            // a second time from the member evidence (same project twice, slug clash).
            configMeshIds: new Set(configMeshes.flatMap((m) => {
                const hostMeshId = typeof m.meshHost?.hostMeshId === 'string' ? m.meshHost.hostMeshId.trim() : '';
                return hostMeshId ? [m.id, hostMeshId] : [m.id];
            })),
            inlineMeshes: source.inlineMeshes(),
            hostRecords: listMeshHostRecords(),
            pushTargets: pushPersistence.load(),
            described: (meshId) => descriptors.get(meshId)?.mesh ?? null,
        });
        return members.length > 0 ? [...configMeshes, ...members] : configMeshes;
    } catch {
        return configMeshes;
    }
}

/**
 * Ask the host of each member mesh this daemon knows only by id (no
 * repoIdentity) for its record — `get_mesh {membershipOnly}`, bounded by
 * DESCRIPTOR_FETCH_TIMEOUT_MS, concurrent, kept for the process lifetime (the
 * inline cache, when the host warms it, takes precedence). Never throws.
 */
export async function refreshMemberMeshDescriptors(meshes: readonly LocalMeshEntry[], transport: MeshTransportPort, now: number = Date.now()): Promise<void> {
    const dispatch = transport.dispatch;
    if (typeof dispatch !== 'function') return;
    const due = meshes.filter((m) => {
        if (m.meshHost?.role !== 'member' || readText(m.repoIdentity) || !readText(m.meshHost.hostDaemonId)) return false;
        const d = descriptors.get(m.id);
        return !d || (!d.mesh && now - d.at >= DESCRIPTOR_FAILED_RETRY_MS);
    });
    await Promise.all(due.map((m) => {
        const running = inflight.get(m.id);
        if (running) return running;
        const p = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let mesh: Record<string, any> | null = null;
            try {
                const raw = await Promise.race([
                    dispatch(readText(m.meshHost!.hostDaemonId), 'get_mesh', { meshId: m.id, membershipOnly: true }),
                    new Promise<null>((resolve) => {
                        timer = setTimeout(() => resolve(null), DESCRIPTOR_FETCH_TIMEOUT_MS);
                        (timer as { unref?: () => void }).unref?.();
                    }),
                ]);
                const answer = findMeshRelayAnswer(raw);
                const got = answer?.success === true ? rec((answer as Record<string, unknown>).mesh) : null;
                mesh = got && readText(got.id) === m.id ? got : null;
            } catch {
                mesh = null;
            } finally {
                if (timer) clearTimeout(timer);
            }
            descriptors.set(m.id, { mesh, at: now });
        })().finally(() => inflight.delete(m.id));
        inflight.set(m.id, p);
        return p;
    }));
}
