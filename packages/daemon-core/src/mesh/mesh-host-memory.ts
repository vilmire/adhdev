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
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { canonicalDaemonId, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getConfigDir } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import {
    canonicalizeOriginGrantPublicKey,
    isValidOriginGrantPublicKey,
    originGrantPublicKeysEqual,
    verifyOriginGrantKeyRotationChain,
    type OriginGrantKeyRotationProof,
} from './origin-grant-keypair.js';
import { maskDaemonId } from './transport/mask-daemon-id.js';

type MeshHostRecordSource = 'pairing' | 'session_stamp' | 'first_dispatch';

export interface MeshHostRecord {
    meshId: string;
    hostDaemonId: string;
    source: MeshHostRecordSource;
    recordedAt: string;
    originGrantPublicKey?: string;
    /** Durable marker set by real member pairings (mesh-host-pairing.ts / remote-project-attach.ts). */
    pairingVerified?: boolean;
}

const FILE_NAME = 'mesh-host-records.json';
const PEER_GRANT_KEYS_FILE_NAME = 'mesh-peer-grant-keys.json';
export const MESH_HOST_RECORDS_SCHEMA_VERSION = 2;
const authenticatedPeerPublicKeys = new Map<string, string>();

function peerKey(meshId: string, peerDaemonId: string, configDir = getConfigDir()): string {
    const canon = canonicalDaemonId(peerDaemonId.trim()) || peerDaemonId.trim();
    return `${configDir}\0${meshId.trim()}\0${canon}`;
}

function peerStoreKey(meshId: string, peerDaemonId: string): string {
    const canon = canonicalDaemonId(peerDaemonId.trim()) || peerDaemonId.trim();
    return `${meshId.trim()}\0${canon}`;
}

function filePath(configDir = getConfigDir()): string {
    return join(configDir, FILE_NAME);
}

function peerGrantKeysFilePath(configDir = getConfigDir()): string {
    return join(configDir, PEER_GRANT_KEYS_FILE_NAME);
}

function readPeerGrantKeysFile(configDir = getConfigDir()): Record<string, string> {
    const path = peerGrantKeysFilePath(configDir);
    if (!existsSync(path)) return {};
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const keys = parsed && typeof parsed === 'object' ? parsed.keys : undefined;
        if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(keys as Record<string, unknown>)) {
            if (typeof v === 'string' && isValidOriginGrantPublicKey(v)) {
                out[k] = v.trim();
            }
        }
        return out;
    } catch {
        return {};
    }
}

function writePeerGrantKeysFile(keys: Record<string, string>, configDir = getConfigDir()): void {
    const path = peerGrantKeysFilePath(configDir);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, keys }, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
}

function isBackedByRealPairingOnDisk(
    meshId: string,
    hostDaemonId: string,
    configDir = getConfigDir(),
): boolean {
    try {
        const meshesPath = join(configDir, 'meshes.json');
        if (existsSync(meshesPath)) {
            const parsed = JSON.parse(readFileSync(meshesPath, 'utf8'));
            const meshes = Array.isArray(parsed?.meshes) ? parsed.meshes : [];
            for (const m of meshes) {
                if (!m || typeof m !== 'object') continue;
                const mh = m.meshHost;
                if (!mh || typeof mh !== 'object' || mh.role !== 'member') continue;
                const matchesMesh = m.id === meshId || mh.hostMeshId === meshId;
                if (!matchesMesh) continue;
                const isPaired =
                    mh.pairing?.status === 'paired' ||
                    Boolean(mh.pairing?.joinedAt) ||
                    Boolean(mh.pairing?.tokenId);
                const matchesHost =
                    !mh.hostDaemonId || daemonIdsEquivalent(String(mh.hostDaemonId), hostDaemonId);
                if (isPaired && matchesHost) {
                    return true;
                }
            }
        }
    } catch {
        // Ignore unreadable meshes.json.
    }
    try {
        const secretsPath = join(configDir, 'mesh-peer-secrets.json');
        if (existsSync(secretsPath)) {
            const parsed = JSON.parse(readFileSync(secretsPath, 'utf8'));
            const records = Array.isArray(parsed?.records) ? parsed.records : [];
            for (const rec of records) {
                if (
                    rec &&
                    typeof rec === 'object' &&
                    rec.meshId === meshId &&
                    rec.role === 'member' &&
                    typeof rec.peerDaemonId === 'string' &&
                    daemonIdsEquivalent(rec.peerDaemonId, hostDaemonId)
                ) {
                    return true;
                }
            }
        }
    } catch {
        // Ignore unreadable mesh-peer-secrets.json.
    }
    return false;
}

/**
 * One-time, idempotent migration that removes bogus `'pairing'` host records
 * created by Round 6/7 builds (via `recordAuthenticatedPeerOriginGrantPublicKey`)
 * that are NOT backed by a real member pairing, while preserving genuine
 * pairing records (backed by `pairingVerified: true`, `meshes.json` member
 * pairing, or `mesh-peer-secrets.json` `role: 'member'`).
 */
export function migrateBogusPairingHostRecords(
    configDir = getConfigDir(),
): { removed: string[]; kept: string[] } {
    const path = filePath(configDir);
    if (!existsSync(path)) return { removed: [], kept: [] };
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const meshes = parsed && typeof parsed === 'object' ? parsed.meshes : undefined;
        if (!meshes || typeof meshes !== 'object' || Array.isArray(meshes)) {
            return { removed: [], kept: [] };
        }
        const fileVersion = typeof parsed.version === 'number' ? parsed.version : 1;
        const out: Record<string, MeshHostRecord> = {};
        const removed: string[] = [];
        const kept: string[] = [];
        let dirty = fileVersion !== MESH_HOST_RECORDS_SCHEMA_VERSION;

        for (const [meshId, value] of Object.entries(meshes as Record<string, any>)) {
            const hostDaemonId = typeof value?.hostDaemonId === 'string' ? value.hostDaemonId.trim() : '';
            if (!meshId || !hostDaemonId) {
                dirty = true;
                continue;
            }
            const source: MeshHostRecordSource =
                value.source === 'pairing' || value.source === 'session_stamp'
                    ? value.source
                    : 'first_dispatch';
            if (source === 'pairing') {
                const explicitlyVerified = value.pairingVerified === true;
                const backedOnDisk = isBackedByRealPairingOnDisk(meshId, hostDaemonId, configDir);
                if (!explicitlyVerified && !backedOnDisk) {
                    removed.push(meshId);
                    dirty = true;
                    continue;
                }
                const originGrantPublicKey = isValidOriginGrantPublicKey(value?.originGrantPublicKey)
                    ? value.originGrantPublicKey.trim()
                    : undefined;
                if (value.pairingVerified !== true) {
                    dirty = true;
                }
                out[meshId] = {
                    meshId,
                    hostDaemonId,
                    source: 'pairing',
                    recordedAt: typeof value.recordedAt === 'string' ? value.recordedAt : '',
                    ...(originGrantPublicKey ? { originGrantPublicKey } : {}),
                    pairingVerified: true,
                };
                kept.push(meshId);
            } else {
                out[meshId] = {
                    meshId,
                    hostDaemonId,
                    source,
                    recordedAt: typeof value.recordedAt === 'string' ? value.recordedAt : '',
                };
                kept.push(meshId);
            }
        }

        if (dirty) {
            writeAll(out, configDir);
        }
        return { removed, kept };
    } catch {
        return { removed: [], kept: [] };
    }
}

function readAll(configDir = getConfigDir()): Record<string, MeshHostRecord> {
    const path = filePath(configDir);
    if (!existsSync(path)) return {};
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const meshes = parsed && typeof parsed === 'object' ? parsed.meshes : undefined;
        if (!meshes || typeof meshes !== 'object' || Array.isArray(meshes)) return {};
        const fileVersion = typeof parsed.version === 'number' ? parsed.version : 1;
        const needsMigration =
            fileVersion !== MESH_HOST_RECORDS_SCHEMA_VERSION ||
            Object.values(meshes as Record<string, any>).some(
                (v) => v?.source === 'pairing' && v?.pairingVerified !== true,
            );
        if (needsMigration) {
            migrateBogusPairingHostRecords(configDir);
            if (!existsSync(path)) return {};
            const reParsed = JSON.parse(readFileSync(path, 'utf8'));
            const reMeshes = reParsed && typeof reParsed === 'object' ? reParsed.meshes : undefined;
            if (!reMeshes || typeof reMeshes !== 'object' || Array.isArray(reMeshes)) return {};
            return parseValidatedRecords(reMeshes as Record<string, any>);
        }
        return parseValidatedRecords(meshes as Record<string, any>);
    } catch {
        return {};
    }
}

function parseValidatedRecords(meshes: Record<string, any>): Record<string, MeshHostRecord> {
    const out: Record<string, MeshHostRecord> = {};
    for (const [meshId, value] of Object.entries(meshes)) {
        const hostDaemonId = typeof value?.hostDaemonId === 'string' ? value.hostDaemonId.trim() : '';
        if (!meshId || !hostDaemonId) continue;
        const source: MeshHostRecordSource =
            value.source === 'pairing' || value.source === 'session_stamp' ? value.source : 'first_dispatch';
        const originGrantPublicKey =
            source === 'pairing' && isValidOriginGrantPublicKey(value?.originGrantPublicKey)
                ? value.originGrantPublicKey.trim()
                : undefined;
        out[meshId] = {
            meshId,
            hostDaemonId,
            source,
            recordedAt: typeof value.recordedAt === 'string' ? value.recordedAt : '',
            ...(originGrantPublicKey ? { originGrantPublicKey } : {}),
            ...(source === 'pairing' && value.pairingVerified === true ? { pairingVerified: true } : {}),
        };
    }
    return out;
}

function writeAll(records: Record<string, MeshHostRecord>, configDir = getConfigDir()): void {
    const path = filePath(configDir);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(
        tmp,
        JSON.stringify({ version: MESH_HOST_RECORDS_SCHEMA_VERSION, meshes: records }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
    );
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
    opts?: { pairingVerified?: boolean; env?: NodeJS.ProcessEnv },
): boolean {
    const mesh = meshId.trim();
    const host = hostDaemonId.trim();
    if (!mesh || !host) return false;
    const configDir = getConfigDir(opts?.env);
    const pubKey = source === 'pairing' && isValidOriginGrantPublicKey(originGrantPublicKey)
        ? originGrantPublicKey.trim()
        : undefined;
    if (pubKey && opts?.pairingVerified !== false) {
        authenticatedPeerPublicKeys.set(peerKey(mesh, host, configDir), pubKey);
        try {
            const peerKeys = readPeerGrantKeysFile(configDir);
            peerKeys[peerStoreKey(mesh, host)] = pubKey;
            writePeerGrantKeysFile(peerKeys, configDir);
        } catch {
            // Best-effort sync to peer grant keys store.
        }
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
        const pairingVerified =
            source === 'pairing'
                ? (opts?.pairingVerified ?? true)
                : undefined;
        all[mesh] = {
            meshId: mesh,
            hostDaemonId: host,
            source,
            recordedAt: new Date().toISOString(),
            ...(effectivePubKey ? { originGrantPublicKey: effectivePubKey } : {}),
            ...(pairingVerified ? { pairingVerified: true } : {}),
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
    opts?: { env?: NodeJS.ProcessEnv; rotationProof?: unknown; rotationChain?: unknown },
): boolean {
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    const peer = typeof peerDaemonId === 'string' ? peerDaemonId.trim() : '';
    const pubKey = isValidOriginGrantPublicKey(originGrantPublicKey) ? originGrantPublicKey.trim() : '';
    const canonicalPubKey = canonicalizeOriginGrantPublicKey(pubKey);
    if (!mesh || !peer || !pubKey || !canonicalPubKey) return false;
    const currentPinned = readAuthenticatedPeerOriginGrantPublicKey(mesh, peer, { env: opts?.env });
    if (currentPinned && !originGrantPublicKeysEqual(currentPinned, pubKey)) {
        const verified = verifyOriginGrantKeyRotationChain(
            {
                rotationProof: opts?.rotationProof,
                rotationChain: opts?.rotationChain,
            },
            {
                hostDaemonId: peer,
                currentPinnedPublicKey: currentPinned,
                targetPublicKey: pubKey,
            },
        );
        if (!verified.ok) {
            const detail = verified.error ? `${verified.reason}: ${verified.error}` : verified.reason;
            LOG.warn(
                'MeshHostMemory',
                `Refused unverified origin-grant public key replacement for peer ${maskDaemonId(peer)} in mesh ${mesh} (${detail})`,
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
    opts?: {
        env?: NodeJS.ProcessEnv;
        syncPeerSecrets?: boolean;
        rotationProof?: unknown;
        rotationChain?: unknown;
    },
): boolean {
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    const peer = typeof peerDaemonId === 'string' ? peerDaemonId.trim() : '';
    const pubKey = isValidOriginGrantPublicKey(originGrantPublicKey) ? originGrantPublicKey.trim() : '';
    if (!canAcceptPeerOriginGrantPublicKey(mesh, peer, pubKey, opts)) return false;
    const configDir = getConfigDir(opts?.env);
    authenticatedPeerPublicKeys.set(peerKey(mesh, peer, configDir), pubKey);
    try {
        const peerKeys = readPeerGrantKeysFile(configDir);
        peerKeys[peerStoreKey(mesh, peer)] = pubKey;
        writePeerGrantKeysFile(peerKeys, configDir);
    } catch {
        // Best-effort durable update to dedicated peer grant keys store.
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

/**
 * Evict a peer's pinned `originGrantPublicKey` across all four stores using a
 * two-phase stage-then-rename commit order:
 *  1. Immediately delete from in-memory `authenticatedPeerPublicKeys`.
 *  2. Stage updated `.tmp` files (mode 0600) for all on-disk stores that hold
 *     the peer's key (`mesh-peer-secrets.json`, `mesh-host-records.json`,
 *     `mesh-peer-grant-keys.json`).
 *  3. Atomically `renameSync` the staged files in reverse read-fallback order:
 *       (a) `mesh-peer-secrets.json` (4th-priority fallback)
 *       (b) `mesh-host-records.json` (3rd-priority fallback)
 *       (c) `mesh-peer-grant-keys.json` (2nd-priority dedicated store)
 *     followed by a final in-memory eviction.
 * Recovery: if a crash occurs mid-clear, the caller (`removePeerSecret` /
 * re-pairing) is idempotent and re-runs `clearAuthenticatedPeerOriginGrantPublicKey`;
 * any leftover `.tmp` files are overwritten on the next write.
 */
export function clearAuthenticatedPeerOriginGrantPublicKey(
    meshId: string,
    peerDaemonId: string,
    opts?: { env?: NodeJS.ProcessEnv },
): void {
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    const peer = typeof peerDaemonId === 'string' ? peerDaemonId.trim() : '';
    if (!mesh || !peer) return;
    const configDir = getConfigDir(opts?.env);
    const memKey = peerKey(mesh, peer, configDir);
    authenticatedPeerPublicKeys.delete(memKey);

    const stagedRenames: Array<{ tmp: string; target: string }> = [];
    const stageFile = (target: string, serialized: string) => {
        const tmp = `${target}.clear-${process.pid}.tmp`;
        writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
        stagedRenames.push({ tmp, target });
    };

    // Phase 1: Stage fallback stores in reverse read priority (secrets -> host-records -> peer-grant-keys)
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
                        rec.originGrantPublicKey !== undefined
                    ) {
                        delete rec.originGrantPublicKey;
                        updated = true;
                    }
                }
                if (updated) {
                    stageFile(secretsPath, JSON.stringify(parsed, null, 2));
                }
            }
        }
    } catch {
        // Continue staging remaining stores.
    }

    try {
        const hostRecordsPath = filePath(configDir);
        const all = readAll(configDir);
        const existing = all[mesh];
        if (existing && daemonIdsEquivalent(existing.hostDaemonId, peer) && existing.originGrantPublicKey) {
            const { originGrantPublicKey: _removed, ...rest } = existing;
            all[mesh] = rest;
            stageFile(
                hostRecordsPath,
                JSON.stringify({ version: MESH_HOST_RECORDS_SCHEMA_VERSION, meshes: all }, null, 2),
            );
        }
    } catch {
        // Continue staging remaining stores.
    }

    try {
        const peerGrantPath = peerGrantKeysFilePath(configDir);
        const peerKeys = readPeerGrantKeysFile(configDir);
        const sKey = peerStoreKey(mesh, peer);
        if (sKey in peerKeys) {
            delete peerKeys[sKey];
            stageFile(peerGrantPath, JSON.stringify({ version: 1, keys: peerKeys }, null, 2));
        }
    } catch {
        // Continue committing staged stores.
    }

    // Phase 2: Commit all staged renames in reverse fallback order
    for (const { tmp, target } of stagedRenames) {
        try {
            renameSync(tmp, target);
        } catch {
            try {
                unlinkSync(tmp);
            } catch {
                // Ignore unlink cleanup errors.
            }
        }
    }
    authenticatedPeerPublicKeys.delete(memKey);
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
    const fromPeerGrantStore = readPeerGrantKeysFile(configDir)[peerStoreKey(mesh, peer)];
    if (fromPeerGrantStore && isValidOriginGrantPublicKey(fromPeerGrantStore)) {
        return fromPeerGrantStore;
    }
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
    rotationProof?: unknown;
    rotationChain?: unknown;
    env?: NodeJS.ProcessEnv;
}):
    | { ok: true; newPublicKey: string; proof: OriginGrantKeyRotationProof }
    | { ok: false; reason: string; code?: string; error?: string } {
    const verified = verifyOriginGrantKeyRotationChain(
        {
            rotationProof: params.rotationProof,
            rotationChain: params.rotationChain,
        },
        {
            hostDaemonId: params.hostDaemonId,
            currentPinnedPublicKey: params.currentPinnedPublicKey,
        },
    );
    if (!verified.ok) return verified;
    const recorded = recordAuthenticatedPeerOriginGrantPublicKey(
        params.meshId,
        params.hostDaemonId,
        verified.newPublicKey,
        {
            env: params.env,
            rotationProof: params.rotationProof,
            rotationChain: params.rotationChain,
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
