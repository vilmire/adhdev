/**
 * Mesh host memory — which daemon this daemon accepts as the HOST (coordinator
 * daemon) of a mesh it holds no roster for, persisted across daemon restarts.
 *
 * Why it exists (rc.42 live regression, 2026-09-24): a worker daemon has no
 * `meshes.json`; it learns a mesh only through pairing or through the commands
 * its coordinator sends. The mesh sender gate (commands/mesh-sender.ts) used
 * session stamps (`meshCoordinatorDaemonId` on a live session) as that
 * daemon's evidence of who coordinates the mesh — but session settings are
 * in-memory, and a hosted session restored after a daemon restart comes back
 * with `meshNodeFor` only. So the first dispatch after every upgrade restart
 * was refused `mesh_sender_not_on_roster (roster_unknown)`. This record is the
 * per-MESH (not per-session) fact that survives the restart.
 *
 * Sources, strongest first:
 *  - `pairing`        — join_mesh_host_pairing accepted by that host.
 *  - `session_stamp`  — a live session stamped with that mesh named the sender
 *                       as its coordinator (migrates pre-existing evidence).
 *  - `first_dispatch` — trust on first use: no roster, no pairing, no stamp —
 *                       the first sender that dispatches (or mesh-launches) a
 *                       session naming ITSELF as coordinator. Logged at WARN.
 * Once a mesh has a record, a different sender is refused unless stronger local
 * evidence (a roster naming it) exists. Recovery for a genuine host move:
 * re-pair, or delete `<configDir>/mesh-host-records.json`.
 *
 * Content: mesh ids and daemon ids only (non-content identifiers).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { canonicalDaemonId, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getConfigDir } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import {
    canonicalizeOriginGrantPublicKey,
    isValidOriginGrantPublicKey,
    verifyOriginGrantKeyRotationProof,
    type OriginGrantKeyRotationProof,
} from './origin-grant-keypair.js';
import { maskDaemonId } from './transport/mask-daemon-id.js';

type MeshHostRecordSource = 'pairing' | 'session_stamp' | 'first_dispatch';

interface MeshHostRecord {
    meshId: string;
    hostDaemonId: string;
    source: MeshHostRecordSource;
    recordedAt: string;
    originGrantPublicKey?: string;
}

const FILE_NAME = 'mesh-host-records.json';
const authenticatedPeerPublicKeys = new Map<string, string>();

function peerKey(meshId: string, peerDaemonId: string, configDir = getConfigDir()): string {
    const canon = canonicalDaemonId(peerDaemonId.trim()) || peerDaemonId.trim();
    return `${configDir}\0${meshId.trim()}\0${canon}`;
}

function filePath(configDir = getConfigDir()): string {
    return join(configDir, FILE_NAME);
}

function readAll(configDir = getConfigDir()): Record<string, MeshHostRecord> {
    const path = filePath(configDir);
    if (!existsSync(path)) return {};
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const meshes = parsed && typeof parsed === 'object' ? parsed.meshes : undefined;
        if (!meshes || typeof meshes !== 'object' || Array.isArray(meshes)) return {};
        const out: Record<string, MeshHostRecord> = {};
        for (const [meshId, value] of Object.entries(meshes as Record<string, any>)) {
            const hostDaemonId = typeof value?.hostDaemonId === 'string' ? value.hostDaemonId.trim() : '';
            if (!meshId || !hostDaemonId) continue;
            const source: MeshHostRecordSource = value.source === 'pairing' || value.source === 'session_stamp' ? value.source : 'first_dispatch';
            const originGrantPublicKey = source === 'pairing' && isValidOriginGrantPublicKey(value?.originGrantPublicKey)
                ? value.originGrantPublicKey.trim()
                : undefined;
            out[meshId] = {
                meshId,
                hostDaemonId,
                source,
                recordedAt: typeof value.recordedAt === 'string' ? value.recordedAt : '',
                ...(originGrantPublicKey ? { originGrantPublicKey } : {}),
            };
        }
        return out;
    } catch {
        return {};
    }
}

function writeAll(records: Record<string, MeshHostRecord>, configDir = getConfigDir()): void {
    const path = filePath(configDir);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, meshes: records }, null, 2), 'utf8');
    renameSync(tmp, path);
}

/** The persisted host record for `meshId`, or null. Never throws. */
export function readMeshHostRecord(meshId: string): MeshHostRecord | null {
    if (!meshId) return null;
    try { return readAll()[meshId] ?? null; } catch { return null; }
}

/** Every persisted host record. Never throws. */
export function listMeshHostRecords(): MeshHostRecord[] {
    try { return Object.values(readAll()); } catch { return []; }
}

/**
 * Persist `hostDaemonId` as the host of `meshId`. A `pairing` record replaces
 * any record; a weaker source never overwrites an existing record.
 * Only `source === 'pairing'` may pin or replace `originGrantPublicKey`.
 * Returns whether the record was written. Never throws.
 */
export function writeMeshHostRecord(
    meshId: string,
    hostDaemonId: string,
    source: MeshHostRecordSource,
    originGrantPublicKey?: string,
): boolean {
    const mesh = meshId.trim();
    const host = hostDaemonId.trim();
    if (!mesh || !host) return false;
    const configDir = getConfigDir();
    const pubKey = source === 'pairing' && isValidOriginGrantPublicKey(originGrantPublicKey)
        ? originGrantPublicKey.trim()
        : undefined;
    if (pubKey) {
        authenticatedPeerPublicKeys.set(peerKey(mesh, host, configDir), pubKey);
    }
    try {
        const all = readAll(configDir);
        const existing = all[mesh];
        if (existing && source !== 'pairing') {
            return false;
        }
        const effectivePubKey = pubKey
            || (existing && existing.source === 'pairing' && daemonIdsEquivalent(existing.hostDaemonId, host)
                ? existing.originGrantPublicKey
                : undefined);
        all[mesh] = {
            meshId: mesh,
            hostDaemonId: host,
            source,
            recordedAt: new Date().toISOString(),
            ...(effectivePubKey ? { originGrantPublicKey: effectivePubKey } : {}),
        };
        writeAll(all, configDir);
        return true;
    } catch {
        return false;
    }
}

export function canAcceptPeerOriginGrantPublicKey(
    meshId: string,
    peerDaemonId: string,
    originGrantPublicKey: string,
    opts?: { env?: NodeJS.ProcessEnv; rotationProof?: unknown },
): boolean {
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    const peer = typeof peerDaemonId === 'string' ? peerDaemonId.trim() : '';
    const pubKey = isValidOriginGrantPublicKey(originGrantPublicKey) ? originGrantPublicKey.trim() : '';
    const canonicalPubKey = canonicalizeOriginGrantPublicKey(pubKey);
    if (!mesh || !peer || !pubKey || !canonicalPubKey) return false;
    const currentPinned = readAuthenticatedPeerOriginGrantPublicKey(mesh, peer, { env: opts?.env });
    const canonicalCurrent = currentPinned ? canonicalizeOriginGrantPublicKey(currentPinned) : null;
    if (currentPinned && canonicalCurrent && canonicalCurrent !== canonicalPubKey) {
        const verified = verifyOriginGrantKeyRotationProof(opts?.rotationProof, {
            hostDaemonId: peer,
            currentPinnedPublicKey: currentPinned,
        });
        const canonicalVerifiedNew = verified.ok ? canonicalizeOriginGrantPublicKey(verified.newPublicKey) : null;
        if (!verified.ok || canonicalVerifiedNew !== canonicalPubKey) {
            const reason = verified.ok ? 'rotation_new_key_mismatch' : verified.reason;
            LOG.warn(
                'MeshHostMemory',
                `Refused unverified origin-grant public key replacement for peer ${maskDaemonId(peer)} in mesh ${mesh} (${reason})`,
            );
            return false;
        }
    }
    return true;
}

export function recordAuthenticatedPeerOriginGrantPublicKey(
    meshId: string,
    peerDaemonId: string,
    originGrantPublicKey: string,
    opts?: { env?: NodeJS.ProcessEnv; syncPeerSecrets?: boolean; rotationProof?: unknown },
): boolean {
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    const peer = typeof peerDaemonId === 'string' ? peerDaemonId.trim() : '';
    const pubKey = isValidOriginGrantPublicKey(originGrantPublicKey) ? originGrantPublicKey.trim() : '';
    if (!canAcceptPeerOriginGrantPublicKey(mesh, peer, pubKey, opts)) return false;
    const configDir = getConfigDir(opts?.env);
    authenticatedPeerPublicKeys.set(peerKey(mesh, peer, configDir), pubKey);
    try {
        const all = readAll(configDir);
        const existing = all[mesh];
        if (!existing || daemonIdsEquivalent(existing.hostDaemonId, peer)) {
            all[mesh] = {
                meshId: mesh,
                hostDaemonId: existing?.hostDaemonId || peer,
                source: 'pairing',
                recordedAt: existing?.recordedAt || new Date().toISOString(),
                originGrantPublicKey: pubKey,
            };
            writeAll(all, configDir);
        }
    } catch {
        // Best-effort durable update.
    }
    if (opts?.syncPeerSecrets !== false) {
        try {
            const secretsPath = join(configDir, 'mesh-peer-secrets.json');
            if (existsSync(secretsPath)) {
                const parsed = JSON.parse(readFileSync(secretsPath, 'utf8'));
                if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
                    let updated = false;
                    for (const rec of parsed.records) {
                        if (
                            rec &&
                            typeof rec === 'object' &&
                            rec.meshId === mesh &&
                            typeof rec.peerDaemonId === 'string' &&
                            daemonIdsEquivalent(rec.peerDaemonId, peer) &&
                            rec.originGrantPublicKey !== pubKey
                        ) {
                            rec.originGrantPublicKey = pubKey;
                            updated = true;
                        }
                    }
                    if (updated) {
                        const tmp = `${secretsPath}.tmp-${process.pid}`;
                        writeFileSync(tmp, JSON.stringify(parsed, null, 2), { encoding: 'utf8', mode: 0o600 });
                        renameSync(tmp, secretsPath);
                    }
                }
            }
        } catch {
            // Best-effort sync to peer secrets.
        }
    }
    return true;
}

export function clearAuthenticatedPeerOriginGrantPublicKey(
    meshId: string,
    peerDaemonId: string,
    opts?: { env?: NodeJS.ProcessEnv },
): void {
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    const peer = typeof peerDaemonId === 'string' ? peerDaemonId.trim() : '';
    if (!mesh || !peer) return;
    const configDir = getConfigDir(opts?.env);
    authenticatedPeerPublicKeys.delete(peerKey(mesh, peer, configDir));
    try {
        const all = readAll(configDir);
        const existing = all[mesh];
        if (existing && daemonIdsEquivalent(existing.hostDaemonId, peer) && existing.originGrantPublicKey) {
            const { originGrantPublicKey: _removed, ...rest } = existing;
            all[mesh] = rest;
            writeAll(all, configDir);
        }
    } catch {
        // Best-effort cleanup.
    }
}

export function readAuthenticatedPeerOriginGrantPublicKey(
    meshId: string,
    peerDaemonId: string,
    opts?: { env?: NodeJS.ProcessEnv },
): string | null {
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    const peer = typeof peerDaemonId === 'string' ? peerDaemonId.trim() : '';
    if (!mesh || !peer) return null;
    const configDir = getConfigDir(opts?.env);
    const inMem = authenticatedPeerPublicKeys.get(peerKey(mesh, peer, configDir));
    if (inMem && isValidOriginGrantPublicKey(inMem)) return inMem;
    const rec = readAll(configDir)[mesh] ?? null;
    if (
        rec &&
        rec.source === 'pairing' &&
        daemonIdsEquivalent(rec.hostDaemonId, peer) &&
        rec.originGrantPublicKey &&
        isValidOriginGrantPublicKey(rec.originGrantPublicKey)
    ) {
        return rec.originGrantPublicKey;
    }
    try {
        const secretsPath = join(configDir, 'mesh-peer-secrets.json');
        if (existsSync(secretsPath)) {
            const parsed = JSON.parse(readFileSync(secretsPath, 'utf8'));
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
                for (const secretRec of parsed.records) {
                    if (
                        secretRec &&
                        typeof secretRec === 'object' &&
                        secretRec.meshId === mesh &&
                        typeof secretRec.peerDaemonId === 'string' &&
                        daemonIdsEquivalent(secretRec.peerDaemonId, peer) &&
                        typeof secretRec.originGrantPublicKey === 'string' &&
                        isValidOriginGrantPublicKey(secretRec.originGrantPublicKey)
                    ) {
                        return secretRec.originGrantPublicKey.trim();
                    }
                }
            }
        }
    } catch {
        // Ignore unreadable peer-secrets file.
    }
    return null;
}

export function applyAuthenticatedHostKeyRotation(params: {
    meshId: string;
    hostDaemonId: string;
    currentPinnedPublicKey: string;
    rotationProof: unknown;
    env?: NodeJS.ProcessEnv;
}): { ok: true; newPublicKey: string; proof: OriginGrantKeyRotationProof } | { ok: false; reason: string } {
    const verified = verifyOriginGrantKeyRotationProof(params.rotationProof, {
        hostDaemonId: params.hostDaemonId,
        currentPinnedPublicKey: params.currentPinnedPublicKey,
    });
    if (!verified.ok) return verified;
    const recorded = recordAuthenticatedPeerOriginGrantPublicKey(
        params.meshId,
        params.hostDaemonId,
        verified.newPublicKey,
        {
            env: params.env,
            rotationProof: params.rotationProof,
        },
    );
    if (!recorded) {
        return { ok: false, reason: 'rotation_old_key_mismatch' };
    }
    return verified;
}

export function __resetAuthenticatedPeerKeysForTest(): void {
    authenticatedPeerPublicKeys.clear();
}
