import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { SessionHostClient, type SessionHostEndpoint } from '@adhdev/session-host-core';
import { isNondelegatedLocalOwnerIngress } from '../commands/command-args.js';

const keys = new Map<string, { key: KeyObject; publicKey: string }>();
/** Called only at real managed-host spawn. Public bootstrap is sent through
 * inherited fd 3, never an environment secret, config file or provider argv. */
export function provisionRecoveryHostChannel(endpoint: SessionHostEndpoint): string {
    const pair = generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    keys.set(endpoint.path, { key: pair.privateKey, publicKey });
    return publicKey;
}
export function forgetRecoveryHostChannel(endpoint: SessionHostEndpoint, expectedPublicKey: string): void {
    if (keys.get(endpoint.path)?.publicKey === expectedPublicKey) keys.delete(endpoint.path);
}
export async function installRecoveryHostFence(endpoint: SessionHostEndpoint, ownerArgs: unknown): Promise<string> {
    if (!isNondelegatedLocalOwnerIngress(ownerArgs)) throw new Error('recovery_nondelegated_owner_required');
    const key = keys.get(endpoint.path);
    if (!key) throw new Error('recovery_host_bootstrap_unavailable');
    const client = new SessionHostClient({ endpoint, requestTimeoutMs: 5000 });
    try {
        // Connect to this retained endpoint only. Never ensureReady/spawn/restart.
        const c = await client.request<{ message: string }>({ type: 'prepare_operator_recovery_fence_v1' });
        if (!c.success || !c.result || typeof c.result.message !== 'string') throw new Error('recovery_host_challenge_unavailable');
        if (!isNondelegatedLocalOwnerIngress(ownerArgs) || keys.get(endpoint.path) !== key) throw new Error('recovery_owner_or_boot_revoked');
        const signature = sign(null, Buffer.from(c.result.message), key.key).toString('hex');
        const r = await client.request<{ fenceDigest: string }>({ type: 'install_operator_recovery_fence_v1',
            payload: { message: c.result.message, signature } });
        if (!r.success || !r.result || !/^[a-f0-9]{64}$/.test(r.result.fenceDigest)) throw new Error(r.error || 'recovery_fence_install_refused');
        return r.result.fenceDigest;
    } finally { client.disconnect(); }
}
