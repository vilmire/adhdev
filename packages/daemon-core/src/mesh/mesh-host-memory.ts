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

function peerKey(meshId: string, peerDaemonId: string): string {
    const canon = canonicalDaemonId(peerDaemonId.trim()) || peerDaemonId.trim();
    return `${meshId.trim()}\0${canon}`;
}

function filePath(): string {
    return join(getConfigDir(), FILE_NAME);
}

function readAll(): Record<string, MeshHostRecord> {
    const path = filePath();
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
            const originGrantPublicKey = typeof value?.originGrantPublicKey === 'string' && value.originGrantPublicKey.trim()
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

function writeAll(records: Record<string, MeshHostRecord>): void {
    const path = filePath();
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
 * any record; a weaker source never overwrites an existing record. Returns
 * whether the record was written. Never throws.
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
    const pubKey = typeof originGrantPublicKey === 'string' && originGrantPublicKey.trim()
        ? originGrantPublicKey.trim()
        : undefined;
    if (pubKey) {
        authenticatedPeerPublicKeys.set(peerKey(mesh, host), pubKey);
    }
    try {
        const all = readAll();
        const existing = all[mesh];
        if (existing && source !== 'pairing') {
            if (pubKey && daemonIdsEquivalent(existing.hostDaemonId, host) && existing.originGrantPublicKey !== pubKey) {
                all[mesh] = { ...existing, originGrantPublicKey: pubKey };
                writeAll(all);
                return true;
            }
            return false;
        }
        const effectivePubKey = pubKey || (existing && daemonIdsEquivalent(existing.hostDaemonId, host) ? existing.originGrantPublicKey : undefined);
        all[mesh] = {
            meshId: mesh,
            hostDaemonId: host,
            source,
            recordedAt: new Date().toISOString(),
            ...(effectivePubKey ? { originGrantPublicKey: effectivePubKey } : {}),
        };
        writeAll(all);
        return true;
    } catch {
        return false;
    }
}

export function recordAuthenticatedPeerOriginGrantPublicKey(
    meshId: string,
    peerDaemonId: string,
    originGrantPublicKey: string,
): void {
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    const peer = typeof peerDaemonId === 'string' ? peerDaemonId.trim() : '';
    const pubKey = typeof originGrantPublicKey === 'string' ? originGrantPublicKey.trim() : '';
    if (!mesh || !peer || !pubKey) return;
    authenticatedPeerPublicKeys.set(peerKey(mesh, peer), pubKey);
    try {
        const all = readAll();
        const existing = all[mesh];
        if (existing && daemonIdsEquivalent(existing.hostDaemonId, peer) && existing.originGrantPublicKey !== pubKey) {
            all[mesh] = { ...existing, originGrantPublicKey: pubKey };
            writeAll(all);
        }
    } catch {
        // Best-effort durable update.
    }
}

export function readAuthenticatedPeerOriginGrantPublicKey(
    meshId: string,
    peerDaemonId: string,
): string | null {
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    const peer = typeof peerDaemonId === 'string' ? peerDaemonId.trim() : '';
    if (!mesh || !peer) return null;
    const inMem = authenticatedPeerPublicKeys.get(peerKey(mesh, peer));
    if (inMem) return inMem;
    const rec = readMeshHostRecord(mesh);
    if (rec && daemonIdsEquivalent(rec.hostDaemonId, peer) && rec.originGrantPublicKey) {
        return rec.originGrantPublicKey;
    }
    return null;
}
