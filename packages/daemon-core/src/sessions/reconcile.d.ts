import type { SessionRegistry } from './registry.js';
interface IdeLikeInstance {
    category?: string;
    type?: string;
    getInstanceId?: () => string;
    getExtensionInstances?: () => Array<{
        type?: string;
        getInstanceId?: () => string;
    }>;
}
interface InstanceManagerLike {
    listInstanceIds(): string[];
    getInstance(id: string): IdeLikeInstance | undefined;
}
/**
 * Rebuild missing IDE/runtime session registry entries from live ProviderInstance objects.
 *
 * This is a defensive repair path for cases where an IDE extension instance still exists
 * in InstanceManager/status, but its runtime session entry has been dropped from SessionRegistry.
 */
export declare function reconcileIdeRuntimeSessions(instanceManager: InstanceManagerLike | undefined, sessionRegistry: SessionRegistry | undefined): void;
export {};
