/** Driver commands are local. Credentials, policy and mailbox authority live here. */
import { defineCommandSpecs } from '../command-registry.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import type { CommandRouterDeps } from '../router.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import { resolveWorkerIdentity } from '../../mesh/worker-report.js';
import { depositWorkerMailboxMessage } from '../../mesh/worker-mailbox.js';
import { DriverService } from '../../drivers/driver-service.js';
import { DriverActionStaging } from '../../drivers/staged-action.js';
import { readInstalledDriver } from '../../drivers/installed-driver.js';

type DriverContext = Pick<MedFamilyContext, 'deps' | 'getMeshForCommand'>;
const services = new WeakMap<CommandRouterDeps, DriverService>();
export function getDriverService(ctx: DriverContext): DriverService {
    const existing = services.get(ctx.deps);
    if (existing) return existing;
    const assistant = getAssistantServices();
    if (!assistant.driverActivations || !assistant.driverStaging) throw new Error('Driver activation services unavailable');
    const service = new DriverService({ registry: ctx.deps.providerLoader,
        activations: assistant.driverActivations, activationStaging: assistant.driverStaging,
        actions: new DriverActionStaging(), bus: ctx.deps.bus,
        readCurrent: type => {
            const current = readInstalledDriver(ctx.deps.providerLoader, type);
            const cwd = ctx.deps.providerLoader.findProviderDir(type);
            return current && cwd ? { ...current, cwd } : null;
        },
        policy: async meshId => (await ctx.getMeshForCommand(meshId))?.mesh?.policy?.drivers,
        relay: (identity, result) => {
            // Mailbox text is capped by its existing transport. Full output stays in the ring.
            const text = JSON.stringify({ kind: 'driver_action_result', ...result });
            return depositWorkerMailboxMessage({ meshId: identity.meshId, taskId: identity.taskId,
                text: text.length <= 2000 ? text : JSON.stringify({ kind: 'driver_action_result', stagedId: result.stagedId,
                    invocationId: result.invocationId, success: result.success, code: result.code, truncated: true }) });
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
        const identity = resolveWorkerIdentity({ token: args?.token, bind: args?.bind });
        if (!identity) return { success: false, code: 'worker_credential_required' };
        return getDriverService(ctx).invoke(identity, { type: String(args?.type ?? ''), action: String(args?.action ?? ''),
            args: args?.args, resourceKey: args?.resourceKey, target: args?.target });
    },
    driver_set_enabled: async (ctx, args) => {
        if (typeof args?.enabled !== 'boolean' || typeof args?.type !== 'string') return { success: false, code: 'invalid_arguments' };
        return getDriverService(ctx).setEnabled(args.type, args.enabled);
    },
};
export const driverSpecs = defineCommandSpecs('med', driverHandlers, {
    driver_set_enabled: { sources: ['p2p', 'ws', 'standalone'] },
}, { sources: ['ipc', 'standalone'], meshSender: 'authenticated_peer' });
