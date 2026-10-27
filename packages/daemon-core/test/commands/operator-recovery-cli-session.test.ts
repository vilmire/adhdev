import { describe, it, expect } from 'vitest';
import { createRecoveryCliSession } from '../../src/commands/operator-recovery-cli-session.js';
import { applyRouterCommandIngressProvenance, isNondelegatedLocalOwnerIngress, issueTrustedOwnerIngressProof } from '../../src/commands/command-args.js';
function ownerArgs(verifyCurrent: () => boolean) {
    const args = {};
    const proof = issueTrustedOwnerIngressProof({ source: 'p2p', peerId: 'fixture-owner-peer', ownerVerified: true,
        nondelegatedLocalOwner: true, channelGeneration: 1, authEpoch: 1, verifyCurrent });
    applyRouterCommandIngressProvenance({}, args, 'p2p', 'fixture-owner-peer', { ownerProof: proof }, false, 'operator_recovery');
    return args;
}
async function send(session: { url: string; cookie: string }, payload: unknown, cookie = session.cookie) {
    return fetch(session.url + '/api/v1/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(payload) });
}
describe('owner-approved local CLI capability bridge', () => {
    it('rejects ordinary IPC/MCP-style input before creating a listener', async () => {
        await expect(createRecoveryCliSession({ ownerVerified: true, source: 'p2p' }, async () => ({}), () => true))
            .rejects.toThrow('nondelegated_local_owner_required');
    });
    it('runs only the exact owner operation, limits use, and retains current private owner provenance', async () => {
        let live = true; let captured: unknown;
        const session = await createRecoveryCliSession(ownerArgs(() => live), async args => {
            captured = args; expect(isNondelegatedLocalOwnerIngress(args)).toBe(true); return { success: true };
        }, () => true);
        expect(session.expiresInMs).toBe(30000); expect(session.maxRequests).toBe(2);
        expect((await send(session, { type: 'operator_recovery', payload: { action: 'enroll' } }, 'forged')).status).toBe(401);
        expect((await send(session, { type: 'operator_recovery', payload: { action: 'enroll' } })).status).toBe(200);
        expect((await send(session, { type: 'operator_recovery', payload: { action: 'execute' } })).status).toBe(200);
        expect((await send(session, { type: 'operator_recovery', payload: { action: 'execute' } })).status).toBe(403);
        live = false;
        expect(isNondelegatedLocalOwnerIngress(captured)).toBe(false);
    });
    it('rejects generic commands and owner-epoch revocation', async () => {
        let epoch = true; let calls = 0;
        const session = await createRecoveryCliSession(ownerArgs(() => true), async () => { calls++; return {}; }, () => epoch);
        expect((await send(session, { type: 'stop_cli', payload: { action: 'fence' } })).status).toBe(403);
        epoch = false;
        expect((await send(session, { type: 'operator_recovery', payload: { action: 'execute' } })).status).toBe(403);
        expect(calls).toBe(0);
    });
});
