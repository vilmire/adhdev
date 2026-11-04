/**
 * Environment ports of the handoff engines. Every effect on the machine — the
 * live SQLite tables, meshes.json, the new-work hold, coordinator launch/stop,
 * the signing key — crosses one of these, so the protocol is exercised in-process
 * with fakes and temp stores (acceptance tests 9-18) and bound to the real daemon
 * in live-env.ts.
 */

import type { ExportedSnapshot, SnapshotPayload } from './snapshot-export.js';
import type { ProbeConflict, SnapshotConflictProbe } from './snapshot-probe.js';
import type { HandoffManifest, HandoffLaunchPlan, HostTransferCertificate } from './types.js';

export interface HostMeshView {
    role: 'host' | 'member';
    hostDaemonId?: string;
    hostNodeId?: string;
    hostEpoch: number;
    /** The origin-grant public key this daemon has pinned for `hostDaemonId` (member side). */
    hostPublicKey?: string;
    handedOff: boolean;
    handoffFence?: { handoffId: string; epoch: number };
    /** No local record: a worker daemon known only through its pairing/host record. Holds no epoch of its own. */
    unrecorded?: boolean;
    /** Daemons on the mesh roster (nodes), excluding nobody — callers filter self. */
    memberDaemonIds: string[];
    /** Raw mesh config entry (sanitised by the exporter). */
    config: unknown;
}

export interface HostMetaWrite {
    role: 'host' | 'member';
    hostDaemonId: string;
    hostNodeId?: string;
    hostEpoch: number;
    /** Public key of the host this daemon now follows (member side after a handoff). */
    hostPublicKey?: string;
    handedOffTo?: { daemonId: string; epoch: number; handoffId: string; at: number; retainUntil: number };
}

export interface HandoffMeshPort {
    read(meshId: string): HostMeshView | null;
    /** A daemon with no local project record whose durable host record names `sender`. */
    describeMember?(meshId: string, sender: string): HostMeshView | null;
    /** Create the local member record a config-less worker daemon needs before it can take authority. */
    materializeMember?(meshId: string, config: Record<string, unknown> | null, hostDaemonId: string, hostPublicKey: string): void;
    /** Persist before source stop. Absence of a response never releases this fence. */
    setFence(meshId: string, fence: { handoffId: string; epoch: number } | null, expectedHandoffId?: string): void;
    /** Durable write of the host fields of the mesh's meshHost metadata. */
    writeHost(meshId: string, meta: HostMetaWrite): void;
    /** Target: merge the (sanitised) snapshot config into the local mesh entry, keeping local pairing/secrets. */
    applyConfig(meshId: string, config: Record<string, unknown> | null): void;
}

export interface HandoffDataPort {
    /** Cut the selected project's SQLite writers after coordinator exit, before export/import. */
    freezeWrites?(meshId: string, handoffId: string, epoch: number): void;
    exportSnapshot(a: { meshId: string; handoffId: string; fromDaemonId: string; toDaemonId: string; hostEpoch: number; meshConfig: unknown; launchPlan?: HandoffLaunchPlan }): ExportedSnapshot;
    localColumns(table: string): string[];
    /** One transaction: replace the mesh's host-owned rows with the snapshot. */
    applySnapshot(meshId: string, payload: SnapshotPayload, provenance?: { handoffId: string; sourceDaemonId: string; snapshotDigest: string; epoch?: number }): Record<string, number>;
    /** Prove the snapshot would apply, then roll everything back. Throws the conflict the real apply would hit. */
    dryRunApply?(meshId: string, payload: SnapshotPayload, provenance?: { handoffId: string; sourceDaemonId: string; snapshotDigest: string; epoch?: number }): void;
    /** Source: the compact key set of `conflictProbe`, read in preflight. */
    buildConflictProbe?(meshId: string): SnapshotConflictProbe;
    /** Target: read-only match of that key set against local rows. */
    findProbeConflicts?(meshId: string, probe: SnapshotConflictProbe): ProbeConflict[];
    freeDiskBytes(): number;
    /** Source: record that the mesh's host-owned data is now read-only history. */
    markHandedOff(row: { meshId: string; handoffId: string; newHostDaemonId: string; epoch: number; handedOffAt: number; retainUntil: number }): void;
}

export interface HandoffHoldPort {
    acquire(meshId: string, handoffId: string): { ok: true } | { ok: false; error: string };
    release(meshId: string, handoffId: string): void;
}

export type FreezeCheck =
    | { ready: true }
    | { ready: false; code: 'coordinator_not_quiescent' | 'writer_checkpoint_pending'; detail?: string };

export interface HandoffFreezePort {
    /** Coordinator idle, no modal, no settling dispatch, no open writer checkpoint. */
    check(meshId: string): Promise<FreezeCheck>;
}

export interface SourceCoordinatorPort {
    selectLaunch?(meshId: string, targetNodeId?: string): HandoffLaunchPlan;
    /** Resolve only after the trusted runtime census proves all project coordinators stopped. */
    stopSource(meshId: string): Promise<void | HostTransferCertificate['sourceStopProof']>;
    /** Only after the handoff can no longer activate: bring back the coordinator this handoff stopped. */
    restoreSource?(meshId: string): Promise<{ success: boolean; sessionId?: string; error?: string }>;
}

export interface CoordinatorObservation { liveCount?: number; ready: boolean; sessionId?: string; runtimeVerified: boolean; checkedAt: number }

export interface TargetCoordinatorPort {
    observe?(meshId: string, plan?: HandoffLaunchPlan): Promise<CoordinatorObservation>;
    readiness?(meshId: string, plan: HandoffLaunchPlan | undefined, opts?: { offeredMesh?: Record<string, unknown> | null; canaryMaxAgeMs?: number }): Promise<{ ok: boolean; checks: Array<{ id: string; ok: boolean; detail?: string }> }>;
    canLaunch(meshId: string): boolean;
    /** Launch the coordinator on the new host with the restart brief; `ready` = it reached ready. */
    launch(meshId: string, handoffId: string, plan?: HandoffLaunchPlan): Promise<{ success: boolean; sessionId?: string; ready: boolean }>;
}

export interface CertificatePort {
    sign(unsigned: Omit<HostTransferCertificate, 'signature'>): HostTransferCertificate;
    /** This daemon's own origin-grant public key (the target reports it in the capability probe). */
    ownPublicKey(): string;
    /** Push the certificate to the other mesh members (best-effort, idempotent). */
    broadcast(meshId: string, cert: HostTransferCertificate, exceptDaemonIds: string[]): Promise<void>;
    /** Deliver to one member and report whether it adopted (or already holds) the transfer. */
    deliver?(daemonId: string, meshId: string, cert: HostTransferCertificate): Promise<boolean>;
}

export interface HandoffClock {
    now(): number;
    newId(): string;
}

export interface HandoffLog {
    (line: string): void;
}

export interface HandoffMetrics {
    phase(handoffId: string, from: string, to: string, ms: number): void;
}

export type { HandoffManifest };
