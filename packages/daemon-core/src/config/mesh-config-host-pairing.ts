/**
 * Mesh host pairing in meshes.json: manual host addresses, pairing tokens and their
 * expiry, applying a member's join request, the host pin (with its downgrade /
 * takeover rules), and marking a pairing joined. Every write goes through the
 * meshes.json write lock.
 */
import { shortHash } from '../system/hash.js';
import type { RepoMeshHostMetadata, LocalMeshEntry, RepoMeshNodeCapabilities, RepoMeshNodePolicy, RepoMeshDaemonRole, LocalMeshNodeEntry } from '../repo-mesh-types.js';
import { withMeshConfigWriteLock, loadMeshConfig, saveMeshConfig } from './mesh-config-store.js';
import { createDefaultMeshHostMetadata } from '../mesh/mesh-host-ownership.js';
import { randomBytes, randomUUID } from 'crypto';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';

function normalizeManualHostAddress(hostAddress: string): string {
    const normalized = hostAddress.trim().replace(/\/+$/, '');
    if (!normalized) throw new Error('hostAddress required');
    let parsed: URL;
    try {
        parsed = new URL(normalized);
    } catch {
        throw new Error('hostAddress must be a valid http(s) or ws(s) URL');
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
        throw new Error('hostAddress must use http, https, ws, or wss');
    }
    return normalized;
}

export function tokenIdForManualPairing(token: string): string {
    return `tok_${shortHash(token)}`;
}

function normalizeTokenExpiry(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('expiresAt must be a valid ISO date');
    return date.toISOString();
}

function assertPairingTokenValid(pairing: RepoMeshHostMetadata['pairing'], rawToken: string, nowIso: string): { ok: true; tokenId: string } | { ok: false; reason: string; expectedTokenId?: string; presentedTokenId?: string } {
    const token = rawToken.trim();
    if (!token) return { ok: false, reason: 'token required' };
    const presentedTokenId = tokenIdForManualPairing(token);
    const expectedTokenId = pairing?.tokenId;
    if (!expectedTokenId || pairing?.status === 'not_configured' || pairing?.status === 'revoked') {
        return { ok: false, reason: 'host pairing token is not configured', presentedTokenId };
    }
    if (pairing.expiresAt && new Date(pairing.expiresAt).getTime() <= new Date(nowIso).getTime()) {
        return { ok: false, reason: 'host pairing token expired', expectedTokenId, presentedTokenId };
    }
    if (presentedTokenId !== expectedTokenId) {
        return { ok: false, reason: 'invalid pairing token', expectedTokenId, presentedTokenId };
    }
    return { ok: true, tokenId: presentedTokenId };
}

export interface ConfigureMeshHostPairingOptions {
    hostAddress: string;
    token: string;
    now?: string;
}

export function configureMeshHostPairing(
    ...args: Parameters<typeof configureMeshHostPairingUnlocked>
): ReturnType<typeof configureMeshHostPairingUnlocked> {
    return withMeshConfigWriteLock(() => configureMeshHostPairingUnlocked(...args));
}

function configureMeshHostPairingUnlocked(
    meshId: string,
    opts: ConfigureMeshHostPairingOptions,
): { mesh: LocalMeshEntry; meshHost: RepoMeshHostMetadata; hostAddress: string } | undefined {
    const hostAddress = normalizeManualHostAddress(opts.hostAddress);
    const token = opts.token.trim();
    if (!token) throw new Error('token required');

    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;

    const now = opts.now || new Date().toISOString();
    const previous = mesh.meshHost || createDefaultMeshHostMetadata();
    const meshHost: RepoMeshHostMetadata = {
        ...previous,
        role: 'member',
        hostAddress,
        pairing: {
            status: 'pairing',
            tokenId: tokenIdForManualPairing(token),
            lastPairedAt: now,
        },
    };

    mesh.meshHost = meshHost;
    mesh.updatedAt = now;
    saveMeshConfig(config);
    return { mesh, meshHost, hostAddress };
}

export interface CreateMeshHostPairingTokenOptions {
    token?: string;
    expiresAt?: string;
    now?: string;
}

export function createMeshHostPairingToken(
    ...args: Parameters<typeof createMeshHostPairingTokenUnlocked>
): ReturnType<typeof createMeshHostPairingTokenUnlocked> {
    return withMeshConfigWriteLock(() => createMeshHostPairingTokenUnlocked(...args));
}

function createMeshHostPairingTokenUnlocked(
    meshId: string,
    opts: CreateMeshHostPairingTokenOptions = {},
): { mesh: LocalMeshEntry; meshHost: RepoMeshHostMetadata; token: string; tokenId: string; expiresAt?: string } | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;
    const now = opts.now || new Date().toISOString();
    const token = (opts.token || `mhj_${randomBytes(24).toString('base64url')}`).trim();
    if (!token) throw new Error('token required');
    const tokenId = tokenIdForManualPairing(token);
    const expiresAt = normalizeTokenExpiry(opts.expiresAt);
    const previous = mesh.meshHost || createDefaultMeshHostMetadata();
    if (previous.role === 'member') {
        throw new Error('Mesh Host daemon required to create host pairing tokens; member daemons cannot mint host join tokens.');
    }
    const meshHost: RepoMeshHostMetadata = {
        ...previous,
        role: 'host',
        pairing: {
            status: 'pairing',
            tokenId,
            lastPairedAt: now,
            ...(expiresAt ? { expiresAt } : {}),
        },
    };
    mesh.meshHost = meshHost;
    mesh.updatedAt = now;
    saveMeshConfig(config);
    return { mesh, meshHost, token, tokenId, ...(expiresAt ? { expiresAt } : {}) };
}

export interface MeshHostJoinMemberNodeInput {
    id?: string;
    workspace: string;
    repoRoot?: string;
    daemonId?: string;
    machineId?: string;
    userOverrides?: Partial<RepoMeshNodeCapabilities>;
    policy?: RepoMeshNodePolicy;
    role?: RepoMeshDaemonRole;
}

export interface ApplyMeshHostJoinOptions {
    token: string;
    memberNode: MeshHostJoinMemberNodeInput;
    memberMeshId?: string;
    now?: string;
}

export function applyMeshHostJoinRequest(
    ...args: Parameters<typeof applyMeshHostJoinRequestUnlocked>
): ReturnType<typeof applyMeshHostJoinRequestUnlocked> {
    return withMeshConfigWriteLock(() => applyMeshHostJoinRequestUnlocked(...args));
}

function applyMeshHostJoinRequestUnlocked(
    meshId: string,
    opts: ApplyMeshHostJoinOptions,
): { accepted: true; mesh: LocalMeshEntry; meshHost: RepoMeshHostMetadata; node: LocalMeshNodeEntry; tokenId: string } | { accepted: false; mesh?: LocalMeshEntry; meshHost?: RepoMeshHostMetadata; tokenId?: string; reason: string } | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;
    const now = opts.now || new Date().toISOString();
    const previous = mesh.meshHost || createDefaultMeshHostMetadata();
    if (previous.role === 'member') {
        return { accepted: false, mesh, meshHost: previous, reason: 'Mesh Host daemon required to accept join requests' };
    }
    const meshHost: RepoMeshHostMetadata = { ...previous, role: 'host' };
    const validation = assertPairingTokenValid(meshHost.pairing, opts.token, now);
    if (!validation.ok) {
        mesh.meshHost = {
            ...meshHost,
            pairing: {
                ...(meshHost.pairing || { status: 'not_configured' as const }),
                status: 'rejected',
                lastRejectedAt: now,
            },
        };
        mesh.updatedAt = now;
        saveMeshConfig(config);
        return { accepted: false, mesh, meshHost: mesh.meshHost, tokenId: validation.presentedTokenId, reason: validation.reason };
    }

    const workspace = opts.memberNode.workspace.trim();
    if (!workspace) throw new Error('memberNode.workspace required');
    const memberId = opts.memberNode.id?.trim();
    let node = mesh.nodes.find(n => (memberId && n.id === memberId) || n.workspace === workspace);
    if (node) {
        node.workspace = workspace;
        node.repoRoot = opts.memberNode.repoRoot;
        node.daemonId = opts.memberNode.daemonId;
        node.machineId = opts.memberNode.machineId;
        node.userOverrides = opts.memberNode.userOverrides || node.userOverrides || {};
        node.policy = { ...(node.policy || {}), ...(opts.memberNode.policy || {}) };
        node.role = 'member';
    } else {
        if (mesh.nodes.length >= 10) throw new Error('Maximum 10 nodes per mesh');
        node = {
            id: memberId || `node_${randomUUID().replace(/-/g, '')}`,
            workspace,
            repoRoot: opts.memberNode.repoRoot,
            daemonId: opts.memberNode.daemonId,
            machineId: opts.memberNode.machineId,
            userOverrides: opts.memberNode.userOverrides || {},
            policy: opts.memberNode.policy || {},
            role: 'member',
        };
        mesh.nodes.push(node);
    }
    mesh.meshHost = {
        ...meshHost,
        pairing: {
            ...(meshHost.pairing || {}),
            status: 'paired',
            tokenId: validation.tokenId,
            joinedAt: now,
            lastPairedAt: meshHost.pairing?.lastPairedAt || now,
            ...(meshHost.pairing?.expiresAt ? { expiresAt: meshHost.pairing.expiresAt } : {}),
        },
    };
    mesh.updatedAt = now;
    saveMeshConfig(config);
    return { accepted: true, mesh, meshHost: mesh.meshHost, node, tokenId: validation.tokenId };
}

export type SetMeshHostPinReason =
    | 'pinned'
    | 'already_pinned_same'
    | 'host_already_pinned'
    | 'not_host_role'
    | 'invalid_host_daemon_id';

export interface SetMeshHostPinResult {
    mesh: LocalMeshEntry;
    meshHost: RepoMeshHostMetadata;
    /** True only when this call actually wrote the pin. */
    applied: boolean;
    reason: SetMeshHostPinReason;
    /** The pin in force after the call (existing one when the write was refused). */
    hostDaemonId?: string;
    hostNodeId?: string;
}

/**
 * HOST-PIN-WRITER — establish THIS mesh's host daemon (`role:'host'` side).
 *
 * The mirror of `markMeshHostPairingJoined`, which records the daemon we JOINED as a
 * `role:'member'`. Nothing previously wrote the host direction, so a mesh created here
 * carried role-only host metadata and never gained a `hostDaemonId` — every peer then
 * synthesized itself as host on read, which is the defect HOST-SELF-SYNTHESIS-GUARD
 * surfaced by refusing to answer.
 *
 * The host pin is a 1:1, effectively permanent assignment (the dashboard states it
 * "cannot be reassigned here"), so this mutator is deliberately conservative:
 *   • no pin yet            → write it (`applied:true`, reason 'pinned')
 *   • same daemon re-pinned → NO-OP, `updatedAt` untouched ('already_pinned_same')
 *   • different daemon      → REFUSED unless `force` ('host_already_pinned')
 *   • `role:'member'` mesh  → REFUSED ('not_host_role') — a member must never claim
 *     local coordinator/queue ownership; its host lives on the daemon it paired with.
 *
 * Identity comparison goes through `daemonIdsEquivalent`, never a raw `!==`. The
 * persisted pin is often a config-form id (`mach_…`) while callers pass the runtime
 * form (`daemon_mach_…`); a raw compare would read the same machine as a reassignment
 * and refuse it — the recurring canon-identity defect class.
 *
 * The host NODE is flagged `role:'host'` alongside the pin. That keeps
 * `resolveMeshHostStatus`'s node-declaration path (which outranks self-synthesis and
 * works for readers that only ever see the node list) consistent with the pin, and
 * exactly one node carries the flag after a forced re-home.
 */
export function setMeshHostPin(
    ...args: Parameters<typeof setMeshHostPinUnlocked>
): ReturnType<typeof setMeshHostPinUnlocked> {
    return withMeshConfigWriteLock(() => setMeshHostPinUnlocked(...args));
}

function setMeshHostPinUnlocked(
    meshId: string,
    opts: { hostDaemonId?: string; hostNodeId?: string; hostAddress?: string; force?: boolean; now?: string },
): SetMeshHostPinResult | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;

    const hostDaemonId = typeof opts.hostDaemonId === 'string' ? opts.hostDaemonId.trim() : '';
    const hostNodeId = typeof opts.hostNodeId === 'string' ? opts.hostNodeId.trim() : '';
    const previous = mesh.meshHost || createDefaultMeshHostMetadata();

    if (!hostDaemonId && !hostNodeId) {
        return {
            mesh,
            meshHost: previous,
            applied: false,
            reason: 'invalid_host_daemon_id',
            ...(previous.hostDaemonId ? { hostDaemonId: previous.hostDaemonId } : {}),
            ...(previous.hostNodeId ? { hostNodeId: previous.hostNodeId } : {}),
        };
    }

    // A mesh we joined as a member is hosted elsewhere — never let it pin a local host.
    if (previous.role === 'member') {
        return {
            mesh,
            meshHost: previous,
            applied: false,
            reason: 'not_host_role',
            ...(previous.hostDaemonId ? { hostDaemonId: previous.hostDaemonId } : {}),
            ...(previous.hostNodeId ? { hostNodeId: previous.hostNodeId } : {}),
        };
    }

    const existingDaemonId = typeof previous.hostDaemonId === 'string' ? previous.hostDaemonId.trim() : '';
    if (existingDaemonId && !opts.force) {
        const sameHost = hostDaemonId ? daemonIdsEquivalent(existingDaemonId, hostDaemonId) : true;
        if (!sameHost) {
            // Refuse silently-destructive re-homing: the caller must pass force.
            return {
                mesh,
                meshHost: previous,
                applied: false,
                reason: 'host_already_pinned',
                hostDaemonId: existingDaemonId,
                ...(previous.hostNodeId ? { hostNodeId: previous.hostNodeId } : {}),
            };
        }
        // Same host. Only a genuinely NEW node anchor is worth a write; otherwise no-op
        // so repeated launches never churn updatedAt.
        const existingNodeId = typeof previous.hostNodeId === 'string' ? previous.hostNodeId.trim() : '';
        if (!hostNodeId || hostNodeId === existingNodeId) {
            return {
                mesh,
                meshHost: previous,
                applied: false,
                reason: 'already_pinned_same',
                hostDaemonId: existingDaemonId,
                ...(existingNodeId ? { hostNodeId: existingNodeId } : {}),
            };
        }
    }

    const now = opts.now || new Date().toISOString();
    const effectiveDaemonId = hostDaemonId || existingDaemonId;
    mesh.meshHost = {
        ...previous,
        role: 'host',
        ...(effectiveDaemonId ? { hostDaemonId: effectiveDaemonId } : {}),
        ...(hostNodeId ? { hostNodeId } : previous.hostNodeId ? { hostNodeId: previous.hostNodeId } : {}),
        ...(opts.hostAddress?.trim() ? { hostAddress: opts.hostAddress.trim() } : {}),
    };

    // Keep the node-level declaration in lockstep with the pin, and single-valued.
    const hostNode = hostNodeId
        ? mesh.nodes.find(n => n.id === hostNodeId)
        : effectiveDaemonId
            ? mesh.nodes.find(n => n.daemonId && daemonIdsEquivalent(n.daemonId, effectiveDaemonId))
            : undefined;
    if (hostNode) {
        for (const node of mesh.nodes) {
            if (node.role === 'host' && node !== hostNode) node.role = undefined;
        }
        hostNode.role = 'host';
        if (!mesh.meshHost.hostNodeId) mesh.meshHost.hostNodeId = hostNode.id;
    }

    mesh.updatedAt = now;
    saveMeshConfig(config);
    return {
        mesh,
        meshHost: mesh.meshHost,
        applied: true,
        reason: 'pinned',
        ...(mesh.meshHost.hostDaemonId ? { hostDaemonId: mesh.meshHost.hostDaemonId } : {}),
        ...(mesh.meshHost.hostNodeId ? { hostNodeId: mesh.meshHost.hostNodeId } : {}),
    };
}

export function markMeshHostPairingJoined(
    ...args: Parameters<typeof markMeshHostPairingJoinedUnlocked>
): ReturnType<typeof markMeshHostPairingJoinedUnlocked> {
    return withMeshConfigWriteLock(() => markMeshHostPairingJoinedUnlocked(...args));
}

function markMeshHostPairingJoinedUnlocked(
    meshId: string,
    opts: { hostDaemonId?: string; hostNodeId?: string; joinedAt?: string; token?: string; tokenId?: string },
): { mesh: LocalMeshEntry; meshHost: RepoMeshHostMetadata } | undefined {
    const config = loadMeshConfig();
    const mesh = config.meshes.find(m => m.id === meshId);
    if (!mesh) return undefined;
    const now = opts.joinedAt || new Date().toISOString();
    const previous = mesh.meshHost || createDefaultMeshHostMetadata();
    const tokenId = opts.tokenId || (opts.token ? tokenIdForManualPairing(opts.token) : previous.pairing?.tokenId);
    mesh.meshHost = {
        ...previous,
        role: 'member',
        ...(opts.hostDaemonId ? { hostDaemonId: opts.hostDaemonId } : {}),
        ...(opts.hostNodeId ? { hostNodeId: opts.hostNodeId } : {}),
        pairing: {
            ...(previous.pairing || {}),
            status: 'paired',
            ...(tokenId ? { tokenId } : {}),
            joinedAt: now,
            lastPairedAt: previous.pairing?.lastPairedAt || now,
        },
    };
    mesh.updatedAt = now;
    saveMeshConfig(config);
    return { mesh, meshHost: mesh.meshHost };
}
