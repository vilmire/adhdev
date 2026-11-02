/**
 * Host transfer certificate (design §7.3): the PREVIOUS host signs
 * `{meshId, newHostDaemonId, newHostNodeId, hostEpoch, newHostPublicKey, handoffId}`
 * with its origin-grant key. A member (or a following assistant) replaces its
 * pinned host only when the signature verifies against the key it ALREADY pinned
 * for the previous host and the epoch is higher than the one it holds.
 */

import crypto from 'node:crypto';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { parseOriginGrantPublicKeyObject } from '../origin-grant-keypair.js';
import type { HostTransferCertificate } from './types.js';

type Unsigned = Omit<HostTransferCertificate, 'signature'>;

/** Canonical signed bytes: fixed field order, NUL-separated, domain-prefixed. */
export function certificatePayload(c: Unsigned): Buffer {
    return Buffer.from([
        'adhdev.host-transfer.v1', c.meshId, c.newHostDaemonId, c.newHostNodeId ?? '', String(c.hostEpoch),
        c.newHostPublicKey, c.handoffId, c.previousHostDaemonId, String(c.issuedAt),
        ...(c.sourceStopped === true ? ['source-stopped-v2'] : []),
    ].join('\0'), 'utf8');
}

export function signHostTransferCertificate(unsigned: Unsigned, privateKey: crypto.KeyObject): HostTransferCertificate {
    const signature = crypto.sign(null, certificatePayload(unsigned), privateKey).toString('base64url');
    return { ...unsigned, signature };
}

export type CertificateVerdict =
    | { ok: true }
    | { ok: false; code: 'certificate_invalid' | 'certificate_wrong_signer' | 'certificate_stale_epoch' | 'certificate_wrong_mesh' };

export interface MemberHostView {
    meshId: string;
    pinnedHostDaemonId: string;
    /** The origin-grant public key this member already pinned for that host. */
    pinnedHostPublicKey: string;
    heldEpoch: number;
}

export function verifyHostTransferCertificate(cert: HostTransferCertificate, view: MemberHostView): CertificateVerdict {
    if (!cert || typeof cert.signature !== 'string' || cert.meshId !== view.meshId) return { ok: false, code: 'certificate_wrong_mesh' };
    if (!daemonIdsEquivalent(cert.previousHostDaemonId, view.pinnedHostDaemonId)) return { ok: false, code: 'certificate_wrong_signer' };
    if (!Number.isSafeInteger(cert.hostEpoch) || cert.hostEpoch <= view.heldEpoch) return { ok: false, code: 'certificate_stale_epoch' };
    const key = parseOriginGrantPublicKeyObject(view.pinnedHostPublicKey);
    if (!key) return { ok: false, code: 'certificate_invalid' };
    const { signature, ...unsigned } = cert;
    try {
        return crypto.verify(null, certificatePayload(unsigned), key, Buffer.from(signature, 'base64url')) ? { ok: true } : { ok: false, code: 'certificate_invalid' };
    } catch { return { ok: false, code: 'certificate_invalid' }; }
}

export interface MemberHostState {
    hostDaemonId: string;
    hostNodeId?: string;
    hostPublicKey: string;
    hostEpoch: number;
}

/** Pure adoption: returns the member's new host state, or the refusal (state unchanged). */
export function adoptHostTransfer(cert: HostTransferCertificate, current: MemberHostState & { meshId: string }):
    { ok: true; next: MemberHostState } | { ok: false; code: Extract<CertificateVerdict, { ok: false }>['code'] } {
    const verdict = verifyHostTransferCertificate(cert, {
        meshId: current.meshId, pinnedHostDaemonId: current.hostDaemonId, pinnedHostPublicKey: current.hostPublicKey, heldEpoch: current.hostEpoch,
    });
    if (!verdict.ok) return verdict;
    return { ok: true, next: { hostDaemonId: cert.newHostDaemonId, ...(cert.newHostNodeId ? { hostNodeId: cert.newHostNodeId } : {}), hostPublicKey: cert.newHostPublicKey, hostEpoch: cert.hostEpoch } };
}
