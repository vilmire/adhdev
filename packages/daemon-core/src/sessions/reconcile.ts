import type { SessionRegistry, SessionRuntimeTarget } from './registry.js';

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

function upsertSessionTarget(sessionRegistry: SessionRegistry, target: SessionRuntimeTarget): void {
    const existing = sessionRegistry.get(target.sessionId);
    if (
        existing
        && existing.parentSessionId === target.parentSessionId
        && existing.providerType === target.providerType
        && existing.transport === target.transport
        && existing.cdpManagerKey === target.cdpManagerKey
        && existing.instanceKey === target.instanceKey
    ) {
        return;
    }
    sessionRegistry.register(target);
}

/**
 * Rebuild missing IDE/runtime session registry entries from live ProviderInstance objects.
 *
 * This is a defensive repair path for cases where an IDE extension instance still exists
 * in InstanceManager/status, but its runtime session entry has been dropped from SessionRegistry.
 */
export function reconcileIdeRuntimeSessions(
    instanceManager: InstanceManagerLike | undefined,
    sessionRegistry: SessionRegistry | undefined,
): void {
    if (!instanceManager || !sessionRegistry) return;

    for (const instanceKey of instanceManager.listInstanceIds()) {
        if (!instanceKey.startsWith('ide:')) continue;

        const ideInstance = instanceManager.getInstance(instanceKey);
        if (!ideInstance || ideInstance.category !== 'ide' || typeof ideInstance.getInstanceId !== 'function') {
            continue;
        }

        const managerKey = instanceKey.slice(4);
        const ideType = typeof ideInstance.type === 'string' && ideInstance.type.trim()
            ? ideInstance.type.trim()
            : managerKey.split('_')[0];
        const parentSessionId = ideInstance.getInstanceId();
        if (!parentSessionId) continue;

        upsertSessionTarget(sessionRegistry, {
            sessionId: parentSessionId,
            parentSessionId: null,
            providerType: ideType,
            transport: 'cdp-page',
            cdpManagerKey: managerKey,
            instanceKey,
        });

        const extensions = ideInstance.getExtensionInstances?.() || [];
        for (const ext of extensions) {
            const extType = typeof ext?.type === 'string' ? ext.type.trim() : '';
            const extSessionId = ext?.getInstanceId?.();
            if (!extType || !extSessionId) continue;

            upsertSessionTarget(sessionRegistry, {
                sessionId: extSessionId,
                parentSessionId,
                providerType: extType,
                transport: 'cdp-webview',
                cdpManagerKey: managerKey,
                instanceKey,
            });
        }
    }
}
