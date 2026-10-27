import { describe, it, expect } from 'vitest';
import { OPERATOR_RECOVERY_TARGET as t } from '@adhdev/session-host-core';
import { startSession } from '../../src/commands/cli-manager-launch.js';
import { markVerifiedMeshSender } from '../../src/commands/mesh-sender.js';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { restoreHostedSessions } from '../../src/commands/cli-manager-restore.js';
import { applyRouterCommandIngressProvenance, issueTrustedOwnerIngressProof, isNondelegatedLocalOwnerIngress } from '../../src/commands/command-args.js';
import { operatorRecoveryCommand, operatorRecoveryCensusCommand } from '../../src/commands/low-family/operator-recovery.js';

function ownerArgs(nondelegated: boolean, live = () => true) {
    const proof = issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true,
        nondelegatedLocalOwner: nondelegated, verifyCurrent: live });
    const args = { action: 'enroll' };
    applyRouterCommandIngressProvenance({}, args, 'standalone', undefined, { ownerProof: proof }, false, 'operator_recovery');
    return args;
}
describe('actual recovery command and saved-resume entry points', () => {
    it('refuses normal IPC, forged flags, MCP-like input and generic owner token authority before touching deps', async () => {
        for (const args of [{}, { action: 'enroll', ownerVerified: true, nondelegatedLocalOwner: true },
            { action: 'execute', source: 'standalone' }, ownerArgs(false)]) {
            const result = await operatorRecoveryCommand({ deps: new Proxy({}, { get() { throw Error('deps touched'); } }) } as any, args);
            expect(result.error).toBe('recovery_nondelegated_local_owner_required');
        }
    });
    it('keeps nondelegated authority in private provenance, revalidates logout and rejects serialization', () => {
        let live = true; const args = ownerArgs(true, () => live);
        expect(isNondelegatedLocalOwnerIngress(args)).toBe(true);
        expect(isNondelegatedLocalOwnerIngress(JSON.parse(JSON.stringify(args)))).toBe(false);
        live = false; expect(isNondelegatedLocalOwnerIngress(args)).toBe(false);
    });
    for (const options of [{ resumeSessionId: t.providerSessionId }, { presetSessionKey: t.sessionId },
        { restartBinding: { providerSessionId: t.providerSessionId } }]) {
        it(`fences saved launch before provider/detection/ensureReady: ${Object.keys(options)[0]}`, async () => {
            const host = new Proxy({}, { get() { throw Error('provider touched before fence'); } });
            await expect(startSession(host as any, 'fixture-cli', '/fixture', [], undefined, options as any)).rejects.toThrow('operator_recovery_fenced');
        });
    }
    it('fences actual createAdapter for a new runtime alias with the original provider UUID', async () => {
        expect(() => DaemonCliManager.prototype.createAdapter.call({} as any, 'fixture-cli', '/fixture', [], 'new-runtime',
            t.providerSessionId)).toThrow('operator_recovery_fenced');
    });
    it('refuses original provider restore before assistant registry/instance registration', async () => {
        const host = { deps: { getInstanceManager: () => ({}), getHostedBindingOwner: () => { throw Error('owner/registry touched'); } },
            providerLoader: {}, adapters: new Map(), registerCliInstance: () => { throw Error('registered'); } };
        await expect(restoreHostedSessions(host as any, [{ runtimeId: 'fresh-alias', providerSessionId: t.providerSessionId }] as any)).rejects.toThrow('operator_recovery_fenced');
    });
});

it('does not treat unrelated prompt or audit text as a provider identity', async () => {
    const { assertRecoveryLaunchIdentity } = await import('@adhdev/session-host-core');
    expect(() => assertRecoveryLaunchIdentity({ runtimeId: 'unrelated', options: { initialPrompt: t.sessionId },
        meta: { note: t.providerSessionId } })).not.toThrow();
});

it('refuses default READY labels without a verified successful full restore before opening any host socket', async () => {
    const manager = { hostedRestoreState: 'ready', hostedFullRestoreState: 'ready', hostedPartialRestoreCount: 0,
        hostedFullRestoreVerified: false, hostedRestoreEpoch: 0, adapters: new Map(),
        operatorRecoveryReadiness: DaemonCliManager.prototype.operatorRecoveryReadiness };
    const args = { nonce: 'a'.repeat(64), fenceDigest: 'b'.repeat(64) };
    markVerifiedMeshSender(args, t.ownerDaemonId);
    await expect(operatorRecoveryCensusCommand({ deps: { statusInstanceId: t.workerDaemonId, cliManager: manager } } as any, args))
        .rejects.toThrow('full_restore_and_adapter_closure_required');
});
