/**
 * Member side of a host handoff (design §7.3): adopt a transferred host only on
 * a certificate signed by the host this member already pinned, at a higher
 * epoch. Anything else is refused and changes nothing.
 */

import { adoptHostTransfer } from './certificate.js';
import type { HandoffMeshPort } from './ports.js';
import type { HostTransferCertificate, PeerResult } from './types.js';

export function applyHostTransferToMember(mesh: HandoffMeshPort, selfDaemonId: string, meshId: string, certificate: unknown): PeerResult {
    const cert = certificate as HostTransferCertificate | undefined;
    if (!cert || typeof cert !== 'object' || cert.meshId !== meshId) return { success: false, code: 'certificate_wrong_mesh' };
    const view = mesh.read(meshId);
    if (!view) return { success: false, code: 'certificate_wrong_mesh', error: 'mesh unknown here' };
    if (view.role !== 'member' || !view.hostDaemonId || !view.hostPublicKey) {
        // The new host already holds the role (epoch) itself, or this daemon pinned no key to verify against.
        return { success: false, code: view.role === 'host' ? 'certificate_stale_epoch' : 'certificate_invalid', error: 'no pinned host key to verify against' };
    }
    const adopted = adoptHostTransfer(cert, { meshId, hostDaemonId: view.hostDaemonId, hostPublicKey: view.hostPublicKey, hostEpoch: view.hostEpoch });
    if (!adopted.ok) return { success: false, code: adopted.code };
    mesh.writeHost(meshId, {
        role: 'member', hostDaemonId: adopted.next.hostDaemonId, ...(adopted.next.hostNodeId ? { hostNodeId: adopted.next.hostNodeId } : {}),
        hostEpoch: adopted.next.hostEpoch, hostPublicKey: adopted.next.hostPublicKey,
    });
    void selfDaemonId;
    return { success: true, adopted: true };
}
