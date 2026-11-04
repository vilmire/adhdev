/**
 * Peer interfaces of the host handoff (design §7.6). The source engine talks to
 * the target through `HandoffPeerClient`, the target pushes its ACK back through
 * `HandoffAckClient`. Production binds both to the mesh transport
 * (`dispatchMeshCommand`); the tests bind them to an in-process fake network.
 */

import type { HandoffAck, HandoffLaunchPlan, HandoffManifest, HostTransferCertificate, PeerResult } from './types.js';
import type { ProbeConflict, SnapshotConflictProbe } from './snapshot-probe.js';

export interface HandoffPeerClient {
    capability(a: { handoffId: string; meshId: string; fromDaemonId: string; launchPlan?: HandoffLaunchPlan; sourcePublicKey?: string; offeredMesh?: Record<string, unknown> | null }): Promise<PeerResult & {
        protocol?: number; targetDaemonId?: string; originGrantPublicKey?: string; hostKeyPinned?: boolean; diskFreeBytes?: number;
        ready?: { coordinatorLaunchable: boolean; diskOk: boolean; checks?: Array<{ id: string; ok: boolean; detail?: string }> };
    }>;
    /** `encodings` lists wire encodings this target can read. An older target omits it and gets plain chunks. */
    manifest(a: { handoffId: string; meshId: string; manifest: HandoffManifest }): Promise<PeerResult & { have?: number[]; encodings?: string[] }>;
    chunk(a: { handoffId: string; meshId: string; seq: number; sha256: string; data: string; encoding?: string }): Promise<PeerResult>;
    /** Read-only check of the keys the importer would refuse. An older target answers `invalid_args`. */
    conflictProbe?(a: { handoffId: string; meshId: string; probe: SnapshotConflictProbe }): Promise<PeerResult & { conflicts?: ProbeConflict[] }>;
    /** Ask the target to verify its staged copy; it answers with ACK asynchronously. */
    seal(a: { handoffId: string; meshId: string }): Promise<PeerResult>;
    activate(a: { handoffId: string; meshId: string; epoch: number; certificate: HostTransferCertificate }):
        Promise<PeerResult & { applied?: boolean; coordinatorReady?: boolean; coordinatorSessionId?: string }>;
    status(a: { handoffId: string; meshId: string }): Promise<PeerResult & { phase?: string; epoch?: number }>;
    discard(a: { handoffId: string; meshId: string }): Promise<PeerResult>;
    memberProbe?(a: { meshId: string }): Promise<PeerResult & { protocol?: number }>;
}

export interface HandoffAckClient {
    ack(sourceDaemonId: string, ack: HandoffAck): Promise<PeerResult>;
}
