/**
 * Environment ports of the handoff engines. Every effect on the machine — the
 * live SQLite tables, meshes.json, the new-work hold, coordinator launch/stop,
 * the signing key — crosses one of these, so the protocol is exercised in-process
 * with fakes and temp stores (acceptance tests 9-18) and bound to the real daemon
 * in live-env.ts.
 */

import type { ExportedSnapshot, SnapshotPayload } from './snapshot-export.js';
import type { HandoffManifest, HostTransferCertificate } from './types.js';

export interface HostMeshView {
    role: 'host' | 'member';
    hostDaemonId?: string;
    hostNodeId?: string;
    hostEpoch: number;
    /** The origin-grant public key this daemon has pinned for `hostDaemonId` (member side). */
    hostPublicKey?: string;
    handedOff: boolean;
    handoffFence?: { handoffId: string; epoch: number };
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
    /** Persist before source stop. Absence of a response never releases this fence. */
    setFence(meshId: string, fence: { handoffId: string; epoch: number } | null, expectedHandoffId?: string): void;
    /** Durable write of the host fields of the mesh's meshHost metadata. */
    writeHost(meshId: string, meta: HostMetaWrite): void;
    /** Target: merge the (sanitised) snapshot config into the local mesh entry, keeping local pairing/secrets. */
    applyConfig(meshId: string, config: Record<string, unknown> | null): void;
}

export interface HandoffDataPort {
    exportSnapshot(a: { meshId: string; handoffId: string; fromDaemonId: string; toDaemonId: string; hostEpoch: number; meshConfig: unknown }): ExportedSnapshot;
    localColumns(table: string): string[];
    /** One transaction: replace the mesh's host-owned rows with the snapshot. */
    applySnapshot(meshId: string, payload: SnapshotPayload): Record<string, number>;
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
    /** Resolve only after the trusted runtime census proves all project coordinators stopped. */
    stopSource(meshId: string): Promise<void>;
}

export interface TargetCoordinatorPort {
    canLaunch(meshId: string): boolean;
    /** Launch the coordinator on the new host with the restart brief; `ready` = it reached ready. */
    launch(meshId: string, handoffId: string): Promise<{ success: boolean; sessionId?: string; ready: boolean }>;
}

export interface CertificatePort {
    sign(unsigned: Omit<HostTransferCertificate, 'signature'>): HostTransferCertificate;
    /** This daemon's own origin-grant public key (the target reports it in the capability probe). */
    ownPublicKey(): string;
    /** Push the certificate to the other mesh members (best-effort, idempotent). */
    broadcast(meshId: string, cert: HostTransferCertificate, exceptDaemonIds: string[]): Promise<void>;
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
