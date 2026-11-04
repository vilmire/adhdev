/**
 * Member side of a host handoff (design §7.3): adopt a transferred host only on
 * a certificate signed by the host this member already pinned, at a higher
 * epoch. Anything else is refused and changes nothing.
 *
 * Fleet daemons often hold no pin: a worker learned its host from dispatches, so
 * its trust in that host is the authenticated transport identity and nothing
 * stronger. Such a member follows the transfer only when the host it already
 * trusts tells it directly. A pin, once held, is never bypassed.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { adoptHostTransfer, verifyHostTransferCertificate } from './certificate.js';
import type { HandoffMeshPort } from './ports.js';
import type { HostTransferCertificate, PeerResult } from './types.js';

/** The durable host record and live session anchors of a mesh on this daemon. */
export interface MemberAdoptionPort {
    /** Authenticated transport sender of this certificate. */
    sender: string;
    readRecord(meshId: string): { hostDaemonId: string; originGrantPublicKey?: string } | null;
    writeRecord(meshId: string, next: { hostDaemonId: string; originGrantPublicKey?: string }): void;
    /** Worker sessions anchored to the previous host report to the new one from now on. */
    reanchorSessions?(meshId: string, fromDaemonId: string, toDaemonId: string): void;
}

export function applyHostTransferToMember(mesh: HandoffMeshPort, selfDaemonId: string, meshId: string, certificate: unknown, adoption?: MemberAdoptionPort): PeerResult {
    const cert = certificate as HostTransferCertificate | undefined;
    if (!cert || typeof cert !== 'object' || cert.meshId !== meshId) return { success: false, code: 'certificate_wrong_mesh' };
    const view = mesh.read(meshId);
    const followed = (from: string): PeerResult => {
        adoption?.writeRecord(meshId, { hostDaemonId: cert.newHostDaemonId, originGrantPublicKey: cert.newHostPublicKey });
        adoption?.reanchorSessions?.(meshId, from, cert.newHostDaemonId);
        return { success: true, adopted: true };
    };
    if (!view) {
        const record = adoption?.readRecord(meshId);
        if (!record) return { success: false, code: 'certificate_wrong_mesh', error: 'mesh unknown here' };
        if (daemonIdsEquivalent(record.hostDaemonId, cert.newHostDaemonId)) return { success: true, duplicate: true };
        if (record.originGrantPublicKey) {
            const verdict = verifyHostTransferCertificate(cert, { meshId, pinnedHostDaemonId: record.hostDaemonId, pinnedHostPublicKey: record.originGrantPublicKey, heldEpoch: cert.hostEpoch - 1 });
            if (!verdict.ok) return { success: false, code: verdict.code };
        } else if (!daemonIdsEquivalent(record.hostDaemonId, adoption!.sender) || !daemonIdsEquivalent(record.hostDaemonId, cert.previousHostDaemonId)) {
            return { success: false, code: 'certificate_wrong_signer' };
        }
        return followed(record.hostDaemonId);
    }
    if (view.role === 'member' && view.hostDaemonId && !view.hostPublicKey && adoption
        && daemonIdsEquivalent(view.hostDaemonId, adoption.sender) && daemonIdsEquivalent(view.hostDaemonId, cert.previousHostDaemonId)
        && Number.isSafeInteger(cert.hostEpoch) && cert.hostEpoch > view.hostEpoch) {
        const from = view.hostDaemonId;
        mesh.writeHost(meshId, { role: 'member', hostDaemonId: cert.newHostDaemonId, ...(cert.newHostNodeId ? { hostNodeId: cert.newHostNodeId } : {}), hostEpoch: cert.hostEpoch, hostPublicKey: cert.newHostPublicKey });
        return followed(from);
    }
    if (view.role !== 'member' || !view.hostDaemonId || !view.hostPublicKey) {
        // The new host already holds the role (epoch) itself, or this daemon pinned no key to verify against.
        return { success: false, code: view.role === 'host' ? 'certificate_stale_epoch' : 'certificate_invalid', error: 'no pinned host key to verify against' };
    }
    if (daemonIdsEquivalent(view.hostDaemonId, cert.newHostDaemonId) && view.hostEpoch === cert.hostEpoch && adoption) return { success: true, duplicate: true };
    const from = view.hostDaemonId;
    const adopted = adoptHostTransfer(cert, { meshId, hostDaemonId: view.hostDaemonId, hostPublicKey: view.hostPublicKey, hostEpoch: view.hostEpoch });
    if (!adopted.ok) return { success: false, code: adopted.code };
    mesh.writeHost(meshId, {
        role: 'member', hostDaemonId: adopted.next.hostDaemonId, ...(adopted.next.hostNodeId ? { hostNodeId: adopted.next.hostNodeId } : {}),
        hostEpoch: adopted.next.hostEpoch, hostPublicKey: adopted.next.hostPublicKey,
    });
    void selfDaemonId;
    return adoption ? followed(from) : { success: true, adopted: true };
}
