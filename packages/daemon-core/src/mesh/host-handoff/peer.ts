/**
 * Peer interfaces of the host handoff (design §7.6). The source engine talks to
 * the target through `HandoffPeerClient`, the target pushes its ACK back through
 * `HandoffAckClient`. Production binds both to the mesh transport
 * (`dispatchMeshCommand`); the tests bind them to an in-process fake network.
 */

import type { HandoffAck, HandoffLaunchPlan, HandoffManifest, HostTransferCertificate, PeerResult } from './types.js';

export interface HandoffPeerClient {
    capability(a: { handoffId: string; meshId: string; fromDaemonId: string; launchPlan?: HandoffLaunchPlan }): Promise<PeerResult & {
        protocol?: number; targetDaemonId?: string; originGrantPublicKey?: string;
        ready?: { coordinatorLaunchable: boolean; diskOk: boolean; checks?: Array<{ id: string; ok: boolean; detail?: string }> };
    }>;
    manifest(a: { handoffId: string; meshId: string; manifest: HandoffManifest }): Promise<PeerResult & { have?: number[] }>;
    chunk(a: { handoffId: string; meshId: string; seq: number; sha256: string; data: string }): Promise<PeerResult>;
    /** Ask the target to verify its staged copy; it answers with ACK asynchronously. */
    seal(a: { handoffId: string; meshId: string }): Promise<PeerResult>;
    activate(a: { handoffId: string; meshId: string; epoch: number; certificate: HostTransferCertificate }):
        Promise<PeerResult & { applied?: boolean; coordinatorReady?: boolean; coordinatorSessionId?: string }>;
    status(a: { handoffId: string; meshId: string }): Promise<PeerResult & { phase?: string; epoch?: number }>;
    discard(a: { handoffId: string; meshId: string }): Promise<PeerResult>;
}

export interface HandoffAckClient {
    ack(sourceDaemonId: string, ack: HandoffAck): Promise<PeerResult>;
}
