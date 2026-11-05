/**
 * Keep the project host's artifact signing key without asking the owner for anything.
 *
 * A machine needs that key to verify the host's read grants. It takes the key from the
 * host the first time one is needed and keeps it: a later different key is refused by
 * recordAuthenticatedPeerOriginGrantPublicKey unless a rotation proof vouches for it.
 * The first answer is trusted on the strength of the authenticated mesh channel to the
 * host this machine already recognises. That host id never comes from the request.
 */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { loadMeshConfig } from '../../config/mesh-config-store.js';
import { LOG } from '../../logging/logger.js';
import { readMeshHostRecord, recordAuthenticatedPeerOriginGrantPublicKey } from '../../mesh/mesh-host-memory.js';
import { isValidOriginGrantPublicKey } from '../../mesh/origin-grant-keypair.js';
import { maskDaemonId } from '../../mesh/transport/mask-daemon-id.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import type { MedFamilyContext } from './types.js';
import { resolveTrustedHostOriginGrantPublicKey } from './artifact-origin-grant.js';

const KEY_REQUEST_TIMEOUT_MS = 8_000;
const RETRY_AFTER_FAILURE_MS = 30_000;

const inFlight = new Map<string, Promise<void>>();
const retryNotBefore = new Map<string, number>();

function recognisedHost(meshId: string): string {
    const recorded = readMeshHostRecord(meshId)?.hostDaemonId?.trim();
    if (recorded) return recorded;
    try {
        const local = (loadMeshConfig().meshes as Array<{ id?: string; meshHost?: { hostDaemonId?: string } }> | undefined)
            ?.find((mesh) => mesh?.id === meshId);
        return local?.meshHost?.hostDaemonId?.trim() || '';
    } catch {
        return '';
    }
}

async function fetchAndKeepHostKey(ctx: MedFamilyContext, meshId: string, hostDaemonId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raw = await Promise.race([
        ctx.deps.dispatchMeshCommand!(hostDaemonId, 'get_mesh_host_grant_key', { meshId }),
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('host_key_request_timeout')), KEY_REQUEST_TIMEOUT_MS);
        }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    const answer = unwrapMeshRelayResult(raw, { command: 'get_mesh_host_grant_key', peerDaemonId: hostDaemonId }) as Record<string, unknown>;
    const key = typeof answer?.originGrantPublicKey === 'string' ? answer.originGrantPublicKey : '';
    if (answer?.success !== true || !isValidOriginGrantPublicKey(key)) {
        throw new Error(String(answer?.code || answer?.error || 'host_key_unavailable'));
    }
    if (!recordAuthenticatedPeerOriginGrantPublicKey(meshId, hostDaemonId, key)) {
        throw new Error('host_key_conflicts_with_kept_key');
    }
    LOG.info('MeshPairing', `kept host signing key mesh=${meshId} host=${maskDaemonId(hostDaemonId)}`);
}

/** Never throws: when it cannot get the key, grant verification reports host_pin_missing. */
export async function ensureHostGrantKeyKept(ctx: MedFamilyContext, meshId: string, hostDaemonId: string): Promise<void> {
    if (!ctx.deps.dispatchMeshCommand || !hostDaemonId) return;
    if (resolveTrustedHostOriginGrantPublicKey({ meshId, hostDaemonId })) return;
    if (!daemonIdsEquivalent(recognisedHost(meshId), hostDaemonId)) return;
    const key = `${meshId}\0${hostDaemonId}`;
    if ((retryNotBefore.get(key) ?? 0) > Date.now()) return;
    let pending = inFlight.get(key);
    if (!pending) {
        pending = fetchAndKeepHostKey(ctx, meshId, hostDaemonId)
            .then(() => { retryNotBefore.delete(key); })
            .catch((error: unknown) => {
                retryNotBefore.set(key, Date.now() + RETRY_AFTER_FAILURE_MS);
                LOG.warn('MeshPairing', `could not get host signing key mesh=${meshId} host=${maskDaemonId(hostDaemonId)}: ${error instanceof Error ? error.message : String(error)}`);
            })
            .finally(() => { inFlight.delete(key); });
        inFlight.set(key, pending);
    }
    await pending;
}

/** Test seam: forget failures and pending requests between cases. */
export function resetHostGrantKeyAutopinForTest(): void {
    inFlight.clear();
    retryNotBefore.clear();
}
