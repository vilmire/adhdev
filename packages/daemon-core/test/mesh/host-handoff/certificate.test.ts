import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adoptHostTransfer, signHostTransferCertificate, verifyHostTransferCertificate, type MemberHostState } from '../../../src/mesh/host-handoff/certificate.js';

const keypair = () => crypto.generateKeyPairSync('ed25519');
const pub = (k: crypto.KeyPairKeyObjectResult) => (k.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url');

const OLD = 'daemon_mach_aaaaaaaaaaaaaaaa';
const NEW = 'daemon_mach_bbbbbbbbbbbbbbbb';
const oldKeys = keypair();
const newKeys = keypair();
const unsigned = { meshId: 'mesh-1', newHostDaemonId: NEW, newHostNodeId: 'node-b', hostEpoch: 3, newHostPublicKey: pub(newKeys), handoffId: 'h1', previousHostDaemonId: OLD, issuedAt: 1000 };
const member: MemberHostState & { meshId: string } = { meshId: 'mesh-1', hostDaemonId: OLD, hostPublicKey: pub(oldKeys), hostEpoch: 2 };

describe('acceptance 15: host transfer certificate', () => {
    it('a member adopts the new host only on the previous host\'s valid signature and a higher epoch (and adopts the new key)', () => {
        const cert = signHostTransferCertificate(unsigned, oldKeys.privateKey);
        expect(verifyHostTransferCertificate(cert, { meshId: 'mesh-1', pinnedHostDaemonId: OLD, pinnedHostPublicKey: member.hostPublicKey, heldEpoch: 2 })).toEqual({ ok: true });
        const adopted = adoptHostTransfer(cert, member);
        expect(adopted).toEqual({ ok: true, next: { hostDaemonId: NEW, hostNodeId: 'node-b', hostPublicKey: pub(newKeys), hostEpoch: 3 } });
    });
    it('a forged certificate (signed by anyone but the pinned previous host) is refused', () => {
        const forged = signHostTransferCertificate(unsigned, keypair().privateKey);
        expect(adoptHostTransfer(forged, member)).toEqual({ ok: false, code: 'certificate_invalid' });
        // the NEW host cannot vouch for itself either
        expect(adoptHostTransfer(signHostTransferCertificate(unsigned, newKeys.privateKey), member)).toEqual({ ok: false, code: 'certificate_invalid' });
    });
    it('any tampered field invalidates the signature', () => {
        const cert = signHostTransferCertificate(unsigned, oldKeys.privateKey);
        for (const patch of [{ newHostDaemonId: 'daemon_mach_cccccccccccccccc' }, { hostEpoch: 99 }, { newHostPublicKey: pub(keypair()) }, { handoffId: 'h2' }, { newHostNodeId: 'node-x' }, { issuedAt: 5 }]) {
            expect(adoptHostTransfer({ ...cert, ...patch }, member), JSON.stringify(patch)).toMatchObject({ ok: false });
        }
    });
    it('binds the observed source session IDs and final complete census time into the signature', () => {
        const cert = signHostTransferCertificate({ ...unsigned, sourceStopped: true,
            sourceStopProof: { sessionIds: ['old-session'], checkedAt: 100, censusComplete: true } }, oldKeys.privateKey);
        expect(adoptHostTransfer(cert, member).ok).toBe(true);
        expect(adoptHostTransfer({ ...cert, sourceStopProof: { sessionIds: ['other-session'], checkedAt: 100, censusComplete: true } }, member))
            .toMatchObject({ ok: false, code: 'certificate_invalid' });
    });
    it('an old or equal epoch is refused (a replay of an earlier handoff cannot roll the host back)', () => {
        const cert = signHostTransferCertificate({ ...unsigned, hostEpoch: 2 }, oldKeys.privateKey);
        expect(adoptHostTransfer(cert, member)).toEqual({ ok: false, code: 'certificate_stale_epoch' });
        expect(adoptHostTransfer(signHostTransferCertificate({ ...unsigned, hostEpoch: 1 }, oldKeys.privateKey), member)).toEqual({ ok: false, code: 'certificate_stale_epoch' });
    });
    it('a certificate from a daemon the member does not have pinned as host, or for another mesh, is refused', () => {
        const other = signHostTransferCertificate({ ...unsigned, previousHostDaemonId: 'daemon_mach_dddddddddddddddd' }, oldKeys.privateKey);
        expect(adoptHostTransfer(other, member)).toEqual({ ok: false, code: 'certificate_wrong_signer' });
        const mesh = signHostTransferCertificate({ ...unsigned, meshId: 'mesh-2' }, oldKeys.privateKey);
        expect(adoptHostTransfer(mesh, member)).toEqual({ ok: false, code: 'certificate_wrong_mesh' });
        expect(adoptHostTransfer({ ...signHostTransferCertificate(unsigned, oldKeys.privateKey), signature: '' }, member)).toMatchObject({ ok: false });
    });
    it('the state is unchanged on a refusal (the helper is pure)', () => {
        const before = JSON.stringify(member);
        adoptHostTransfer(signHostTransferCertificate(unsigned, keypair().privateKey), member);
        expect(JSON.stringify(member)).toBe(before);
    });
});
