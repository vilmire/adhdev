/** Driver commands are local. Credentials, policy and mailbox authority live here. */
import { defineCommandSpecs } from '../command-registry.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import type { CommandRouterDeps } from '../router.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import { resolveDriverWorkerIdentity, driverIdentityHandlers, DRIVER_IDENTITY_VERIFY_COMMAND } from './driver-worker-identity.js';
import { depositWorkerMailboxMessage } from '../../mesh/worker-mailbox.js';
import { dirname } from 'node:path';
import { DriverGrantStore } from '../../drivers/grant-store.js';
import { DriverService } from '../../drivers/driver-service.js';
import { DriverActionStaging } from '../../drivers/staged-action.js';
import { readInstalledDriver } from '../../drivers/installed-driver.js';
import { createDriverArtifactPort } from './driver-artifact-port.js';

type DriverContext = Pick<MedFamilyContext, 'deps' | 'getMeshForCommand' | 'getCachedInlineMesh'>;
const services = new WeakMap<CommandRouterDeps, DriverService>();
export function getDriverService(ctx: DriverContext): DriverService {
    const existing = services.get(ctx.deps);
    if (existing) return existing;
    const assistant = getAssistantServices();
    if (!assistant.driverActivations || !assistant.driverStaging) throw new Error('Driver activation services unavailable');
    const service = new DriverService({ registry: ctx.deps.providerLoader,
        activations: assistant.driverActivations, activationStaging: assistant.driverStaging,
        actions: new DriverActionStaging(), grants: new DriverGrantStore({ configDir: dirname(dirname(assistant.driverActivations.path)) }), bus: ctx.deps.bus, artifacts: createDriverArtifactPort(ctx),
        readCurrent: type => {
            const current = readInstalledDriver(ctx.deps.providerLoader, type);
            const cwd = ctx.deps.providerLoader.findProviderDir(type);
            return current && cwd ? { ...current, cwd } : null;
        },
        policy: async meshId => {
            const mesh = (await ctx.getMeshForCommand(meshId))?.mesh;
            if (mesh) return mesh.policy?.drivers ?? {};
            // A member without a local record of the mesh: the owner's policy, returned with the verified identity.
            const { ownerDriverPolicy } = await import('./driver-worker-identity.js');
            return ownerDriverPolicy(meshId);
        },
        relay: (identity, result) => {
            // Mailbox text is capped by its existing transport. Full output stays in the ring.
            const text = JSON.stringify({ kind: 'driver_action_result', ...result });
            return depositWorkerMailboxMessage({ meshId: identity.meshId, taskId: identity.taskId,
                text: text.length <= 2000 ? text : JSON.stringify({ kind: 'driver_action_result', stagedId: result.stagedId,
                    invocationId: result.invocationId, success: result.success, code: result.code, truncated: true,
                    ...(Array.isArray(result.artifacts) ? { artifacts: result.artifacts } : {}) }) });
        },
    });
    services.set(ctx.deps, service);
    return service;
}
export async function closeDriverService(deps: CommandRouterDeps): Promise<void> {
    const service = services.get(deps); services.delete(deps); await service?.close();
}
export const driverHandlers: Record<string, MedFamilyHandler> = {
    driver_list: async ctx => getDriverService(ctx).list(),
    driver_describe: async (ctx, args) => getDriverService(ctx).describe(String(args?.type ?? '')),
    driver_invoke: async (ctx, args) => {
        const resolved = await resolveDriverWorkerIdentity(ctx, args);
        if ('error' in resolved) return { success: false, code: resolved.error, ...(resolved.detail ? { detail: resolved.detail } : {}) };
        const identity = resolved.identity;
        return getDriverService(ctx).invoke(identity, { type: String(args?.type ?? ''), action: String(args?.action ?? ''),
            args: args?.args, resourceKey: args?.resourceKey, target: args?.target });
    },
    driver_set_enabled: async (ctx, args) => {
        if (typeof args?.enabled !== 'boolean' || typeof args?.type !== 'string') return { success: false, code: 'invalid_arguments' };
        return getDriverService(ctx).setEnabled(args.type, args.enabled);
    },
    // Owner-only permission checkboxes. Read has no side effects; write may activate or stage the driver.
    driver_grants_get: async ctx => getDriverService(ctx).getGrants(),
    driver_grants_set: async (ctx, args) => {
        if (typeof args?.type !== 'string') return { success: false, code: 'invalid_arguments' };
        return getDriverService(ctx).setGrants(args.type, args.grants);
    },
    ...driverIdentityHandlers,
};
export const driverSpecs = defineCommandSpecs('med', driverHandlers, {
    driver_set_enabled: { sources: ['p2p', 'ws', 'standalone'] },
    // No 'ws': a compromised server must not be able to turn on desktop control.
    driver_grants_get: { sources: ['p2p', 'standalone'] },
    driver_grants_set: { sources: ['p2p', 'standalone'] },
    // Owner-side verify-only relay of a member's driver call (no execution here).
    [DRIVER_IDENTITY_VERIFY_COMMAND]: { sources: ['mesh'], meshSender: 'roster' },
}, { sources: ['ipc', 'standalone'] });
