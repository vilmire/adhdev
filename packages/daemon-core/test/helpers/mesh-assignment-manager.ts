import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';

/** Owned in-memory provider instances for dispatch unit tests. Run the real
 * assignment manager and attachment transaction, rather than a boolean stamp. */
export function assignmentFixtureManager(entries: Array<{
    id: string; adapter: any; settings?: Record<string, unknown>; instance?: Record<string, unknown>;
}>): ProviderInstanceManager {
    const manager = Object.create(ProviderInstanceManager.prototype) as ProviderInstanceManager;
    const instances = new Map(entries.map(({ id, adapter, settings = {}, instance = {} }) => {
        const owned = Object.assign(Object.create(CliProviderInstance.prototype), {
            instanceId: id, type: adapter.cliType, category: 'cli', workingDir: adapter.workingDir,
            settings, adapter, meshTaskInjectedAt: 0, meshTaskAttachmentHistory: [], generatingStartedAt: 0,
            ...instance,
        });
        owned.getState = () => ({ instanceId: id, category: 'cli', type: adapter.cliType,
            status: adapter.getStatus?.().status ?? 'idle', settings: owned.settings });
        return [id, owned] as const;
    }));
    Object.assign(manager, { instances });
    return manager;
}
