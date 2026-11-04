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
import { loadMeshConfig, saveMeshConfig, withMeshConfigWriteLock, withHandoffConfigWrite } from '../../config/mesh-config-store.js';
import { readMeshConfigFromDisk, saveMeshConfigDurable, withStrictMeshConfigWriteLock } from '../../config/mesh-config-store.js';
import { getOrCreateHostKeyPair } from '../origin-grant-keypair.js';
import { MeshRuntimeStore } from '../mesh-runtime-store.js';
import { resolveMeshHostStatus } from '../mesh-host-ownership.js';
import { readAuthenticatedPeerOriginGrantPublicKey, readMeshHostRecord, transferMeshHostRecord } from '../mesh-host-memory.js';
import { releaseNewWorkHold, setNewWorkHold } from '../../maintenance/new-work-hold.js';
import { signHostTransferCertificate } from './certificate.js';
import { SqliteHandoffJournal } from './journal.js';
import { createWireAckClient, createWirePeerClient, type PeerDispatch } from './peer-protocol.js';
import { HostHandoffSource, type SourceDeps } from './source-machine.js';
import { HostHandoffTarget } from './target-machine.js';
import { exportSnapshot } from './snapshot-export.js';
import { applySnapshotTables, localTableColumns, approvalProjectResolver } from './snapshot-import.js';
import { assertProjectApprovalDestinations, exportProjectApprovalFiles, importProjectApprovalFiles } from './project-files.js';
import { resolveAssistantProject } from '../../assistant/assistant-projects.js';
import { acquireProjectFileCut } from './project-write-cut.js';
import { adoptPendingNoticeReceipts, assessPreservationBoundary } from './preservation-boundary.js';
import { acquireHandoffWriteFence, releaseHandoffWriteFence, withHandoffImport } from './write-fence.js';
import { assignHostLaunchNode, findHandoffMesh, mergeHandoffNodeRoster, presentHandoffMesh, retargetHandoffMeshId, type HandoffMeshIdentity } from './paired-member.js';
import type { FreezeCheck, HandoffDataPort, HandoffHoldPort, HandoffMeshPort, HostMetaWrite } from './ports.js';
import type { HandoffLaunchPlan, HostTransferCertificate } from './types.js';

export interface LiveHandoffHost {
    selfDaemonId: string;
    dispatch: PeerDispatch;
    peerOnline(daemonId: string): boolean;
    /** This daemon's coordinator sessions of a mesh: idle / modal state, and stop. */
    coordinatorState(meshId: string): Array<{ sessionId: string; idle: boolean; modalParked: boolean }>;
    stopCoordinators(meshId: string): Promise<void | HostTransferCertificate['sourceStopProof']>;
    observeCoordinator(meshId: string, plan?: HandoffLaunchPlan): Promise<import('./ports.js').CoordinatorObservation>;
    selectLaunch(meshId: string, targetNodeId?: string): HandoffLaunchPlan;
    readiness(meshId: string, plan: HandoffLaunchPlan | undefined, opts?: { offeredMesh?: Record<string, unknown> | null; canaryMaxAgeMs?: number }): Promise<{ ok: boolean; checks: Array<{ id: string; ok: boolean; detail?: string }> }>;
    /** Relaunch this project's coordinator after an abort that stopped it. */
    restoreCoordinator?(meshId: string): Promise<{ success: boolean; sessionId?: string; error?: string }>;
    /** The role moved: anything cached from the old host must not answer again. */
    meshAuthorityChanged?(meshId: string): void;
    canLaunchCoordinator(meshId: string): boolean;
    launchCoordinator(meshId: string, handoffId: string, plan?: HandoffLaunchPlan): Promise<{ success: boolean; sessionId?: string; ready: boolean }>;
    selfNodeId(meshId: string): string | undefined;
    log(line: string): void;
}

const HOLD_TTL_MS = 30 * 60_000;

function db() { return MeshRuntimeStore.getInstance().db as unknown as Parameters<typeof applySnapshotTables>[0] & Parameters<typeof exportSnapshot>[0]['db']; }

/** Protocol mesh id, or the one paired member record that stored that id as hostMeshId. */
export function readLiveHandoffMesh(meshId: string, selfDaemonId: string) {
    const mesh = findHandoffMesh(loadMeshConfig().meshes, meshId, selfDaemonId);
    return mesh ? presentHandoffMesh(mesh, meshId, selfDaemonId) : undefined;
}

export function createLiveMeshPort(selfDaemonId = ''): HandoffMeshPort {
    const locate = <T extends HandoffMeshIdentity>(meshes: readonly T[] | undefined, meshId: string) => meshes ? findHandoffMesh(meshes, meshId, selfDaemonId) : undefined;
    return {
        read(meshId) {
            const raw = locate(loadMeshConfig().meshes, meshId);
            if (!raw) return null;
            const mesh = presentHandoffMesh(raw, meshId, selfDaemonId);
            const status = resolveMeshHostStatus(raw);
            return {
                role: status.role, hostDaemonId: status.hostDaemonId, hostNodeId: status.hostNodeId, hostEpoch: status.hostEpoch ?? 0,
                handedOff: !!status.handedOffTo, config: mesh,
                // Pairing pins into the host record for a daemon that holds no project record, and
                // into both once it does. Only authenticated pairing or a verified transfer writes either.
                hostPublicKey: raw.meshHost?.originGrantPublicKey ?? (status.role === 'member' && status.hostDaemonId ? readAuthenticatedPeerOriginGrantPublicKey(meshId, status.hostDaemonId) ?? undefined : undefined),
                handoffFence: raw.meshHost?.handoffFence,
                memberDaemonIds: (raw.nodes ?? []).map(n => String(n.daemonId ?? '')).filter(Boolean),
            };
        },
        describeMember(meshId, sender) {
            const record = readMeshHostRecord(meshId);
            if (!record || !daemonIdsEquivalent(record.hostDaemonId, sender)) return null;
            return {
                role: 'member', hostDaemonId: record.hostDaemonId, hostEpoch: 0, unrecorded: true, handedOff: false, memberDaemonIds: [], config: null,
                hostPublicKey: readAuthenticatedPeerOriginGrantPublicKey(meshId, record.hostDaemonId) ?? undefined,
            };
        },
        materializeMember(meshId, snapshotConfig, hostDaemonId, hostPublicKey) {
            withHandoffConfigWrite(meshId, () => withMeshConfigWriteLock(() => {
                const config = loadMeshConfig();
                if (locate(config.meshes, meshId)) return;
                if (!snapshotConfig) throw new Error('handoff snapshot carries no project config');
                const { meshHost: _hostOwned, ...incoming } = snapshotConfig;
                config.meshes.push({ ...incoming, id: meshId, meshHost: { role: 'member', hostDaemonId, originGrantPublicKey: hostPublicKey } } as never);
                saveMeshConfig(config);
            }));
        },
        setFence(meshId, fence, expectedHandoffId) {
            withHandoffConfigWrite(meshId, () => withStrictMeshConfigWriteLock(() => {
                const config = readMeshConfigFromDisk();
                const mesh = locate(config?.meshes, meshId);
                if (!config || !mesh) throw new Error('handoff fence storage unavailable');
                const prior = mesh.meshHost?.handoffFence;
                if (fence && prior && prior.handoffId !== fence.handoffId) throw new Error('another handoff holds the source fence');
                if (!fence && prior && prior.handoffId !== expectedHandoffId) throw new Error('handoff fence identity changed');
                const store = MeshRuntimeStore.getInstance().db;
                if (!fence) releaseHandoffWriteFence(store as never, meshId, expectedHandoffId!, mesh.meshHost?.role === 'member' && mesh.meshHost?.handedOffTo?.handoffId === expectedHandoffId);
                mesh.meshHost = { ...(mesh.meshHost ?? { role: 'host' }), ...(fence ? { handoffFence: fence } : {}) };
                if (!fence) delete mesh.meshHost.handoffFence;
                const saved = saveMeshConfigDurable(config);
                if (!saved.ok) throw new Error('handoff fence persistence failed');
            }));
        },
        writeHost(meshId, meta: HostMetaWrite) {
            withHandoffConfigWrite(meshId, () => withMeshConfigWriteLock(() => {
                const config = loadMeshConfig();
                const mesh = locate(config.meshes, meshId);
                if (!mesh) throw new Error(`mesh ${meshId} not found`);
                if (meta.role === 'host') {
                    const moved = retargetHandoffMeshId(config.meshes, mesh, meshId);
                    if (!moved.ok) throw new Error(moved.error);
                    const assigned = assignHostLaunchNode(mesh.nodes ?? [], meta.hostNodeId, meta.hostDaemonId);
                    if (!assigned.ok) throw new Error(assigned.error);
                    mesh.nodes = assigned.nodes as typeof mesh.nodes;
                }
                const prev = (mesh.meshHost ?? { role: 'host' }) as Record<string, unknown>;
                const next: Record<string, unknown> = { ...prev, role: meta.role, hostDaemonId: meta.hostDaemonId, hostEpoch: meta.hostEpoch };
                if (meta.hostNodeId) next.hostNodeId = meta.hostNodeId; else delete next.hostNodeId;
                if (meta.role === 'host') { delete next.hostAddress; delete next.hostMeshId; delete next.originGrantPublicKey; delete next.handedOffTo; }
                if (meta.hostPublicKey) next.originGrantPublicKey = meta.hostPublicKey;
                if (meta.handedOffTo) next.handedOffTo = meta.handedOffTo;
                mesh.meshHost = next as never;
                if (meta.hostNodeId) mesh.coordinator = { ...mesh.coordinator, preferredNodeId: meta.hostNodeId };
                // exactly one node carries the host flag
                for (const n of mesh.nodes ?? []) {
                    const node = n as { daemonId?: string; role?: string };
                    if (node.daemonId && daemonIdsEquivalent(node.daemonId, meta.hostDaemonId)) node.role = 'host';
                    else if (node.role === 'host') delete node.role;
                }
                mesh.updatedAt = new Date().toISOString();
                saveMeshConfig(config);
            }));
            // The learned record would otherwise keep answering "the host is the old daemon".
            if (meta.role === 'host') transferMeshHostRecord(meshId, null);
        },
        applyConfig(meshId, snapshotConfig) {
            if (!snapshotConfig) return;
            withHandoffConfigWrite(meshId, () => withMeshConfigWriteLock(() => {
                const config = loadMeshConfig();
                const mesh = locate(config.meshes, meshId);
                if (!mesh) throw new Error(`mesh ${meshId} not found`);
                const aliased = mesh.id !== meshId;
                // Host-owned configuration travels; this daemon's own pairing/secret state and its meshHost stay.
                const localNodes = mesh.nodes ?? [];
                const keep = { id: mesh.id, meshHost: mesh.meshHost };
                const incoming = { ...snapshotConfig };
                delete (incoming as Record<string, unknown>).meshHost;
                if (Array.isArray(incoming.nodes)) {
                    const merged = mergeHandoffNodeRoster(localNodes as unknown as Array<Record<string, unknown>>, incoming.nodes as Array<Record<string, unknown>>, { aliased, selfDaemonId });
                    if (!merged.ok) throw new Error(merged.error);
                    incoming.nodes = merged.nodes;
                }
                Object.assign(mesh, incoming, keep);
                if (aliased) {
                    const moved = retargetHandoffMeshId(config.meshes, mesh, meshId);
                    if (!moved.ok) throw new Error(moved.error);
                }
                saveMeshConfig(config);
            }));
        },
    };
}

export function createLiveDataPort(): HandoffDataPort {
    return {
        freezeWrites: (meshId, handoffId, epoch) => {
            const cut = acquireProjectFileCut(getConfigDir(), meshId);
            try { acquireHandoffWriteFence(MeshRuntimeStore.getInstance().db as never, meshId, handoffId, epoch); }
            finally { cut.release(); }
        },
        exportSnapshot: (a) => {
            const config = readMeshConfigFromDisk();
            if (!config) throw new Error('project inventory unavailable during approval snapshot');
            const projectFiles = exportProjectApprovalFiles(getConfigDir(), a.meshId, ref => {
                const resolved = resolveAssistantProject(ref, config.meshes);
                return resolved.ok ? resolved.mesh.id : null;
            });
            return exportSnapshot({ ...a, db: db(), projectFiles });
        },
        localColumns: localTableColumns(db() as never),
        applySnapshot: (meshId, payload, provenance) => {
            const store = MeshRuntimeStore.getInstance().db as unknown as { transaction<T>(fn: () => T): () => T };
            let counts: Record<string, number>;
            try {
                counts = withHandoffImport(MeshRuntimeStore.getInstance().db, meshId, () => store.transaction(() => {
                    const applied = applySnapshotTables(db(), meshId, payload, provenance);
                    adoptPendingNoticeReceipts(db() as never, meshId, payload, provenance);
                    return applied;
                })());
            } catch (e) { throw Object.assign(e as Error, { handoffNoEffect: true }); }
            importProjectApprovalFiles(getConfigDir(), meshId, payload.files, approvalProjectResolver(payload.config, meshId));
            return counts;
        },
        dryRunApply: (meshId, payload, provenance) => {
            const store = MeshRuntimeStore.getInstance().db as unknown as { transaction<T>(fn: () => T): () => T };
            const rollback = new Error('handoff dry run');
            try {
                withHandoffImport(MeshRuntimeStore.getInstance().db, meshId, () => store.transaction(() => {
                    applySnapshotTables(db(), meshId, payload, provenance);
                    adoptPendingNoticeReceipts(db() as never, meshId, payload, provenance);
                    throw rollback;
                })());
            } catch (e) { if (e !== rollback) throw e; }
            assertProjectApprovalDestinations(getConfigDir(), payload.files);
        },
        freeDiskBytes: () => { try { const s = statfsSync(getConfigDir()); return Number(s.bavail) * Number(s.bsize); } catch { return 0; } },
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
        const raw = MeshRuntimeStore.getInstance().db as unknown as { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): any[] } };
        const table = raw.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'mesh_writer_stop_captures'").get();
        if (table) for (const row of raw.prepare('SELECT capture_json FROM mesh_writer_stop_captures WHERE settled = 0').all()) {
            try {
                const capture = JSON.parse(row.capture_json);
                const request = JSON.parse(capture.requestKey);
                if (!Array.isArray(request) || typeof request[0] !== 'string') throw new Error('unscoped capture');
                if (request[0] === meshId) return { ready: false, code: 'writer_checkpoint_pending', detail: 'this project has an unsettled writer stop capture' };
            } catch { return { ready: false, code: 'writer_checkpoint_pending', detail: 'writer checkpoint project identity is unverifiable' }; }
        }
        if (raw.prepare("SELECT 1 AS open FROM turn_attempts WHERE mesh_id = ? AND state = 'stopping' LIMIT 1").get(meshId)) {
            return { ready: false, code: 'writer_checkpoint_pending', detail: 'an attempt is stopping' };
        }
        if (raw.prepare("SELECT 1 FROM turn_attempts WHERE mesh_id=? AND terminal_outcome IS NULL LIMIT 1").get(meshId)) return { ready: false, code: 'coordinator_not_quiescent', detail: 'project worker turns are still draining' };
        const busy = host.coordinatorState(meshId).filter(c => !c.idle || c.modalParked);
        if (busy.length) return { ready: false, code: 'coordinator_not_quiescent', detail: busy.map(b => b.sessionId).join(',') };
        return { ready: true };
    };
}

function liveCertificatePort(host: LiveHandoffHost) {
    return {
        sign: (u: Omit<HostTransferCertificate, 'signature'>) => signHostTransferCertificate(u, getOrCreateHostKeyPair(host.selfDaemonId).privateKeyObj),
        ownPublicKey: () => getOrCreateHostKeyPair(host.selfDaemonId).publicKey,
        async deliver(daemonId: string, meshId: string, cert: HostTransferCertificate) {
            const answer = await host.dispatch(daemonId, 'mesh_host_handoff_certificate', { meshId, handoffId: cert.handoffId, certificate: cert });
            return answer.success === true;
        },
        async broadcast(meshId: string, cert: HostTransferCertificate, except: string[]) {
            const view = createLiveMeshPort(host.selfDaemonId).read(meshId);
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
    const mesh = createLiveMeshPort(host.selfDaemonId);
    const data = createLiveDataPort();
    const clock = { now: () => Date.now(), newId: () => randomUUID() };
    const certificate = liveCertificatePort(host);
    const log = (line: string) => host.log(line);
    const sourceDeps: SourceDeps = {
        // Success only when memory, pending notices, and approval bytes verify
        // together. A missing inventory, open turn, index mismatch, or unreadable
        // file stays state_preservation_unverified.
        preservationCheck: (meshId) => assessPreservationBoundary(MeshRuntimeStore.getInstance().db as never, getConfigDir(), meshId),
        selfDaemonId: host.selfDaemonId, journal, mesh, data, hold: createLiveHoldPort(), freeze: { check: liveFreezeCheck(host) },
        coordinator: { selectLaunch: (m, n) => host.selectLaunch(m, n), stopSource: (meshId) => host.stopCoordinators(meshId),
            ...(host.restoreCoordinator ? { restoreSource: (meshId: string) => host.restoreCoordinator!(meshId) } : {}) }, certificate,
        peer: (target) => createWirePeerClient(host.dispatch, target), peerOnline: (d) => host.peerOnline(d), clock, log,
    };
    return {
        journal,
        source: new HostHandoffSource(sourceDeps),
        target: new HostHandoffTarget({
            selfDaemonId: host.selfDaemonId, journal, mesh, data, clock, certificate, log,
            coordinator: { observe: (m, p) => host.observeCoordinator(m, p), readiness: (m, p, o) => host.readiness(m, p, o), canLaunch: (m) => host.canLaunchCoordinator(m), launch: (m, h, p) => host.launchCoordinator(m, h, p) },
            ackClient: createWireAckClient(host.dispatch), selfNodeId: (m) => host.selfNodeId(m),
        }),
    };
}
