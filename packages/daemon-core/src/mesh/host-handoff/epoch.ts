/**
 * Host epoch rules (design §7.4 "쓰기 경합", invariant ①): every host-owned
 * write is judged by `checkHostOwnedWrite`. After a committed handoff the OLD host
 * is a member that refuses with `mesh_host_handed_off`; a client holding an
 * older epoch gets `stale_host_epoch` (and re-resolves the host); a "host" that
 * sees a request carrying a HIGHER epoch knows it is itself stale.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { resolveMeshHostStatus } from '../mesh-host-ownership.js';

export type HostWriteVerdict =
    | { ok: true; epoch: number }
    | { ok: false; code: 'mesh_host_handed_off' | 'stale_host_epoch' | 'mesh_host_required'; epoch: number; newHostDaemonId?: string; direction?: 'client_stale' | 'local_stale' };

export function readHostEpoch(mesh: unknown): number {
    return resolveMeshHostStatus(mesh).hostEpoch ?? 0;
}

export function checkHostOwnedWrite(mesh: unknown, opts: { localDaemonId: string; requestEpoch?: number }): HostWriteVerdict {
    const status = resolveMeshHostStatus(mesh);
    const epoch = status.hostEpoch ?? 0;
    if (status.handedOffTo) {
        return { ok: false, code: 'mesh_host_handed_off', epoch: Math.max(epoch, status.handedOffTo.epoch), newHostDaemonId: status.handedOffTo.daemonId };
    }
    if (status.role !== 'host' || (status.hostDaemonId && !daemonIdsEquivalent(status.hostDaemonId, opts.localDaemonId))) {
        return { ok: false, code: 'mesh_host_required', epoch, ...(status.hostDaemonId ? { newHostDaemonId: status.hostDaemonId } : {}) };
    }
    if (opts.requestEpoch !== undefined) {
        if (opts.requestEpoch < epoch) return { ok: false, code: 'stale_host_epoch', epoch, direction: 'client_stale' };
        if (opts.requestEpoch > epoch) return { ok: false, code: 'stale_host_epoch', epoch, direction: 'local_stale' };
    }
    return { ok: true, epoch };
}
