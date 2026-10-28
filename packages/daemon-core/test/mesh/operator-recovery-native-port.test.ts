import { describe, it, expect, vi } from 'vitest';
// Only namespace derivation is a fixture. This is not the original instance
// and cannot provide historical physical proof. The kernel lock and signed
// owner/socket/fence path are real components in a disposable directory.
vi.mock('@adhdev/session-host-core', async original => ({ ...await original<object>(), resolveSessionHostIpcKey: () => '6a2ef3162182' }));
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { OPERATOR_RECOVERY_TARGET as t } from '@adhdev/session-host-core';
import { SessionHostServer } from '../../../session-host-daemon/src/server.js';
import { provisionRecoveryHostChannel, installRecoveryHostFence } from '../../src/session-host/recovery-owner-channel.js';
import { applyRouterCommandIngressProvenance, issueTrustedOwnerIngressProof } from '../../src/commands/command-args.js';

describe.skipIf(process.platform !== 'darwin')('actual signed native fence owner port', () => {
    it('uses parent-held signing key, current owner provenance, native exclusion and durable socket installation', async () => {
        const root = realpathSync(mkdtempSync('/tmp/or-'));
        const helper = join(root, 'guardian');
        execFileSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', resolve('../session-host-daemon/native/instance-lock.c'), '-o', helper], { windowsHide: true });
        const endpoint = { kind: 'unix' as const, path: join(root, `adhdev-preview-session-host-${t.namespace}.sock`) };
        const publicKey = provisionRecoveryHostChannel(endpoint);
        const stateDir = join(root, 'state');
        const host = new SessionHostServer({ endpoint, instanceConfigDir: root, workerDaemonId: t.workerDaemonId,
            recoveryOwnerPublicKey: publicKey, storageRootDir: join(stateDir, 'records'),
            // Conservatively use legacy capability mode for this pinned fixture;
            // it must NOT enumerate processes on the author host.
            upgradeBinding: { helperPath: helper, helperSha256: createHash('sha256').update(readFileSync(helper)).digest('hex'), stateDir } });
        await host.start(); await new Promise(r => setTimeout(r, 20));
        try {
            await expect(installRecoveryHostFence(endpoint, { ownerVerified: true })).rejects.toThrow('nondelegated_owner_required');
            const args = {};
            const proof = issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true,
                nondelegatedLocalOwner: true, verifyCurrent: () => true });
            applyRouterCommandIngressProvenance({}, args, 'standalone', undefined, { ownerProof: proof }, false, 'operator_recovery');
            const digest = await installRecoveryHostFence(endpoint, args);
            expect(digest).toMatch(/^[a-f0-9]{64}$/);
            expect(readFileSync(join(stateDir, 'records', 'operator-recovery-v1.json'), 'utf8')).toContain(t.providerSessionId);
            expect(host.collectRecoveryCensus('a'.repeat(64), digest).verdict).toBe('UNKNOWN');
            await expect(installRecoveryHostFence(endpoint, args)).rejects.toThrow();
        } finally { await host.stop(); }
    });
});
