/**
 * Mission reads on a daemon that is not the mesh host.
 *
 * Missions live in the host's store. A member — and in particular a former host that handed the role away, whose
 * local store still holds the missions as they were at the handoff — used to answer `mission_query` /
 * `mission_list_query` from its own store, so an MCP client on that machine silently read a stale copy (writes were
 * already fenced, reads were not; live 2026-11-07 after a host move). A non-host now forwards the
 * read to the host over the mesh relay and returns the host's answer; when the host cannot be reached it fails
 * loudly instead of serving the stale copy.
 */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import { defineCommandSpecs } from '../command-registry.js';
import type { CommandRouterResult } from '../router.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

/** The mesh-relay command a non-host sends to the host. Mission reads only; the IPC commands stay local-only. */
export const MISSION_READ_RELAY_COMMAND = 'mission_read_relay';
const RELAYABLE = new Set(['mission_query', 'mission_list_query']);
const relayTargets = new Map<string, LowFamilyHandler>();

/** Marks a read that already crossed the relay, so a host that also believes it is a member never bounces it. */
export const MISSION_READ_FORWARDED_KEY = 'missionReadForwarded';

async function forwardTarget(ctx: LowFamilyContext, meshId: string): Promise<string | undefined> {
    if (!meshId || !ctx?.deps?.dispatchMeshCommand) return undefined;
    let mesh: unknown;
    try { mesh = (await ctx.getMeshForCommand?.(meshId, undefined, { preferInline: true }))?.mesh; } catch { return undefined; }
    if (!mesh) return undefined;
    const self = ctx.deps.statusInstanceId;
    const status = resolveMeshHostStatus(mesh, self ? { localDaemonId: self } : undefined);
    if (status.role === 'host') return undefined;
    const target = status.handedOffTo?.daemonId ?? status.hostDaemonId;
    if (!target || (self && daemonIdsEquivalent(target, self))) return undefined;
    return target;
}

/** Wrap a mission read handler: forward to the host when this daemon is not it, else run locally. */
export function withMissionReadForward(command: string, run: LowFamilyHandler): LowFamilyHandler {
    const wrapped: LowFamilyHandler = async (ctx, args) => {
        const { [MISSION_READ_FORWARDED_KEY]: forwarded, ...rest } = (args ?? {}) as Record<string, unknown>;
        if (forwarded !== true) {
            const meshId = typeof rest.meshId === 'string' ? rest.meshId.trim() : '';
            const target = await forwardTarget(ctx, meshId);
            if (target) {
                try {
                    // meshId at the TOP level: the any_member_mesh sender gate checks the roster of exactly this mesh.
                    const raw = await ctx.deps.dispatchMeshCommand!(target, MISSION_READ_RELAY_COMMAND, { meshId, command, args: rest });
                    return unwrapMeshRelayResult(raw, { command, peerDaemonId: target }) as CommandRouterResult;
                } catch (e: any) {
                    return { success: false, code: 'mesh_host_unreachable', error: `${command}: missions live on the mesh host (${target}), which could not be reached: ${e?.message ?? String(e)}. This daemon's local copy may be stale, so it is not served.` };
                }
            }
        }
        return run(ctx, rest);
    };
    if (RELAYABLE.has(command)) relayTargets.set(command, wrapped);
    return wrapped;
}

/**
 * Host side of the relay: runs the named mission read locally (never forwards again). Accepts only the mesh relay
 * source and only the two read commands — a write or any other command name is refused.
 */
const missionReadRelay: LowFamilyHandler = async (ctx, args) => {
    const refuse = (why: string) => ({ success: false, code: 'mission_read_relay_refused', error: `mission_read_relay: ${why}` });
    const command = typeof args?.command === 'string' ? args.command : '';
    const run = relayTargets.get(command);
    if (!RELAYABLE.has(command) || !run) return refuse(`'${command}' is not a relayable mission read`);
    const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
    const inner = args?.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args as Record<string, unknown> : null;
    // The sender gate authorised the TOP-level mesh; the read must be for that same mesh and no other.
    if (!meshId || !inner || inner.meshId !== meshId) return refuse('the read must name the same mesh as the relay request');
    // Only the host answers for a mesh's missions (a member or fenced former host holds a stale copy).
    let mesh: unknown;
    try { mesh = (await ctx.getMeshForCommand?.(meshId, undefined, { preferInline: true }))?.mesh; } catch { mesh = undefined; }
    const self = ctx.deps.statusInstanceId;
    if (!mesh || resolveMeshHostStatus(mesh, self ? { localDaemonId: self } : undefined).role !== 'host') return refuse('this daemon is not the host of that mesh');
    return run(ctx, { ...inner, [MISSION_READ_FORWARDED_KEY]: true });
};

export const missionReadRelaySpecs = defineCommandSpecs('low', { [MISSION_READ_RELAY_COMMAND]: missionReadRelay }, {
    [MISSION_READ_RELAY_COMMAND]: { sources: ['mesh'], meshSender: 'any_member_mesh' },
});
