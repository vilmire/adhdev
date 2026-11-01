/**
 * Bindings of the host-handoff engines to the real daemon: the live
 * MeshRuntimeStore tables, meshes.json, the new-work hold, the origin-grant key
 * and the mesh transport. This is the only file of the feature that touches the
 * machine's real state; the protocol itself is exercised through ports (see
 * test/mesh/host-handoff). Nothing here runs unless the owner starts a handoff.
 */

import { statfsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getConfigDir } from '../../config/config.js';
import { loadMeshConfig, saveMeshConfig, withMeshConfigWriteLock } from '../../config/mesh-config-store.js';
import { getMesh } from '../../config/mesh-config.js';
import { getOrCreateHostKeyPair } from '../origin-grant-keypair.js';
import { MeshRuntimeStore } from '../mesh-runtime-store.js';
import { resolveMeshHostStatus } from '../mesh-host-ownership.js';
import { releaseNewWorkHold, setNewWorkHold } from '../../maintenance/new-work-hold.js';
import { signHostTransferCertificate } from './certificate.js';
import { SqliteHandoffJournal } from './journal.js';
import { createWireAckClient, createWirePeerClient, type PeerDispatch } from './peer-protocol.js';
import { HostHandoffSource, type SourceDeps } from './source-machine.js';
import { HostHandoffTarget } from './target-machine.js';
import { exportSnapshot } from './snapshot-export.js';
import { applySnapshotTables, localTableColumns } from './snapshot-import.js';
import type { FreezeCheck, HandoffDataPort, HandoffHoldPort, HandoffMeshPort, HostMetaWrite } from './ports.js';
import type { HostTransferCertificate } from './types.js';

export interface LiveHandoffHost {
    selfDaemonId: string;
    dispatch: PeerDispatch;
    peerOnline(daemonId: string): boolean;
    /** This daemon's coordinator sessions of a mesh: idle / modal state, and stop. */
    coordinatorState(meshId: string): Array<{ sessionId: string; idle: boolean; modalParked: boolean }>;
    stopCoordinators(meshId: string): Promise<void>;
    canLaunchCoordinator(meshId: string): boolean;
    launchCoordinator(meshId: string, handoffId: string): Promise<{ success: boolean; sessionId?: string; ready: boolean }>;
    selfNodeId(meshId: string): string | undefined;
    log(line: string): void;
}

const HOLD_TTL_MS = 30 * 60_000;

function db() { return MeshRuntimeStore.getInstance().db as unknown as Parameters<typeof applySnapshotTables>[0] & Parameters<typeof exportSnapshot>[0]['db']; }

export function createLiveMeshPort(): HandoffMeshPort {
    return {
        read(meshId) {
            const mesh = getMesh(meshId);
            if (!mesh) return null;
            const status = resolveMeshHostStatus(mesh);
            return {
                role: status.role, hostDaemonId: status.hostDaemonId, hostNodeId: status.hostNodeId, hostEpoch: status.hostEpoch ?? 0,
                handedOff: !!status.handedOffTo, config: mesh,
                memberDaemonIds: (mesh.nodes ?? []).map(n => String((n as { daemonId?: string }).daemonId ?? '')).filter(Boolean),
            };
        },
        writeHost(meshId, meta: HostMetaWrite) {
            withMeshConfigWriteLock(() => {
                const config = loadMeshConfig();
                const mesh = config.meshes.find(m => m.id === meshId);
                if (!mesh) throw new Error(`mesh ${meshId} not found`);
                const prev = (mesh.meshHost ?? { role: 'host' }) as Record<string, unknown>;
                const next: Record<string, unknown> = { ...prev, role: meta.role, hostDaemonId: meta.hostDaemonId, hostEpoch: meta.hostEpoch };
                if (meta.hostNodeId) next.hostNodeId = meta.hostNodeId; else delete next.hostNodeId;
                if (meta.role === 'host') { delete next.hostAddress; delete next.hostMeshId; delete next.originGrantPublicKey; delete next.handedOffTo; }
                if (meta.hostPublicKey) next.originGrantPublicKey = meta.hostPublicKey;
                if (meta.handedOffTo) next.handedOffTo = meta.handedOffTo;
                mesh.meshHost = next as never;
                // exactly one node carries the host flag
                for (const n of mesh.nodes ?? []) {
                    const node = n as { daemonId?: string; role?: string };
                    if (node.daemonId && daemonIdsEquivalent(node.daemonId, meta.hostDaemonId)) node.role = 'host';
                    else if (node.role === 'host') delete node.role;
                }
                mesh.updatedAt = new Date().toISOString();
                saveMeshConfig(config);
            });
        },
        applyConfig(meshId, snapshotConfig) {
            if (!snapshotConfig) return;
            withMeshConfigWriteLock(() => {
                const config = loadMeshConfig();
                const mesh = config.meshes.find(m => m.id === meshId);
                if (!mesh) throw new Error(`mesh ${meshId} not found`);
                // Host-owned configuration travels; this daemon's own pairing/secret state and its meshHost stay.
                const keep = { id: mesh.id, meshHost: mesh.meshHost };
                const incoming = { ...snapshotConfig };
                delete (incoming as Record<string, unknown>).meshHost;
                Object.assign(mesh, incoming, keep);
                saveMeshConfig(config);
            });
        },
    };
}

export function createLiveDataPort(): HandoffDataPort {
    return {
        exportSnapshot: (a) => exportSnapshot({ ...a, db: db() }),
        localColumns: localTableColumns(db() as never),
        applySnapshot: (meshId, payload) => applySnapshotTables(db(), meshId, payload),
        freeDiskBytes: () => { try { const s = statfsSync(getConfigDir()); return Number(s.bavail) * Number(s.bsize); } catch { return Number.MAX_SAFE_INTEGER; } },
        markHandedOff: (row) => {
            (MeshRuntimeStore.getInstance().db.prepare(
                'INSERT INTO mesh_host_handed_off (mesh_id, handoff_id, new_host_daemon_id, epoch, handed_off_at, retain_until) VALUES (?,?,?,?,?,?) '
                + 'ON CONFLICT(mesh_id) DO UPDATE SET handoff_id=excluded.handoff_id, new_host_daemon_id=excluded.new_host_daemon_id, epoch=excluded.epoch, handed_off_at=excluded.handed_off_at, retain_until=excluded.retain_until',
            ) as { run(...a: unknown[]): unknown }).run(row.meshId, row.handoffId, row.newHostDaemonId, row.epoch, row.handedOffAt, row.retainUntil);
        },
    };
}

/** The mesh-scoped new-work hold: claims, dispatch and launches stop; running worker turns do not. */
export function createLiveHoldPort(): HandoffHoldPort {
    const holdId = (handoffId: string) => `host-handoff:${handoffId}`;
    return {
        acquire(meshId, handoffId) {
            const res = setNewWorkHold({ holdId: holdId(handoffId), holder: 'host-handoff', meshId, reason: 'host handoff', ttlMs: HOLD_TTL_MS, autoExtend: true, requestId: `set:${handoffId}` });
            return res.success ? { ok: true } : { ok: false, error: String(res.error ?? res.code ?? 'hold refused') };
        },
        release(meshId, handoffId) {
            try { releaseNewWorkHold({ holdId: holdId(handoffId), holder: 'host-handoff', reason: 'host handoff finished', requestId: `release:${handoffId}:${meshId}` }); } catch { /* an expired hold is already free */ }
        },
    };
}

export function liveFreezeCheck(host: LiveHandoffHost) {
    return async (meshId: string): Promise<FreezeCheck> => {
        const raw = MeshRuntimeStore.getInstance().db as unknown as { prepare(sql: string): { get(...a: unknown[]): unknown } };
        const table = raw.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'mesh_writer_stop_captures'").get();
        if (table && raw.prepare('SELECT 1 AS open FROM mesh_writer_stop_captures WHERE settled = 0 LIMIT 1').get()) {
            return { ready: false, code: 'writer_checkpoint_pending', detail: 'an unsettled writer stop capture exists' };
        }
        if (raw.prepare("SELECT 1 AS open FROM turn_attempts WHERE mesh_id = ? AND state = 'stopping' LIMIT 1").get(meshId)) {
            return { ready: false, code: 'writer_checkpoint_pending', detail: 'an attempt is stopping' };
        }
        const busy = host.coordinatorState(meshId).filter(c => !c.idle || c.modalParked);
        if (busy.length) return { ready: false, code: 'coordinator_not_quiescent', detail: busy.map(b => b.sessionId).join(',') };
        return { ready: true };
    };
}

function liveCertificatePort(host: LiveHandoffHost) {
    return {
        sign: (u: Omit<HostTransferCertificate, 'signature'>) => signHostTransferCertificate(u, getOrCreateHostKeyPair(host.selfDaemonId).privateKeyObj),
        ownPublicKey: () => getOrCreateHostKeyPair(host.selfDaemonId).publicKey,
        async broadcast(meshId: string, cert: HostTransferCertificate, except: string[]) {
            const view = createLiveMeshPort().read(meshId);
            for (const daemonId of view?.memberDaemonIds ?? []) {
                if (except.some(e => daemonIdsEquivalent(e, daemonId))) continue;
                try { await host.dispatch(daemonId, 'mesh_host_handoff_certificate', { meshId, handoffId: cert.handoffId, certificate: cert }); } catch { /* offline members ask on reconnect */ }
            }
        },
    };
}

export interface LiveHandoffEngines { source: HostHandoffSource; target: HostHandoffTarget; journal: SqliteHandoffJournal }

export function createLiveHandoffEngines(host: LiveHandoffHost): LiveHandoffEngines {
    const journal = new SqliteHandoffJournal(MeshRuntimeStore.getInstance().db as never);
    const mesh = createLiveMeshPort();
    const data = createLiveDataPort();
    const clock = { now: () => Date.now(), newId: () => randomUUID() };
    const certificate = liveCertificatePort(host);
    const log = (line: string) => host.log(line);
    const sourceDeps: SourceDeps = {
        selfDaemonId: host.selfDaemonId, journal, mesh, data, hold: createLiveHoldPort(), freeze: { check: liveFreezeCheck(host) },
        coordinator: { stopSource: (meshId) => host.stopCoordinators(meshId) }, certificate,
        peer: (target) => createWirePeerClient(host.dispatch, target), peerOnline: (d) => host.peerOnline(d), clock, log,
    };
    return {
        journal,
        source: new HostHandoffSource(sourceDeps),
        target: new HostHandoffTarget({
            selfDaemonId: host.selfDaemonId, journal, mesh, data, clock, certificate, log,
            coordinator: { canLaunch: (m) => host.canLaunchCoordinator(m), launch: (m, h) => host.launchCoordinator(m, h) },
            ackClient: createWireAckClient(host.dispatch), selfNodeId: (m) => host.selfNodeId(m),
        }),
    };
}
