/**
 * DaemonCdpSetup — Shared CDP initialization helpers
 *
 * Common CDP setup logic for consistent
 * CDP → ProviderInstance registration.
 */

import { DaemonCdpManager } from './manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { IdeProviderInstance } from '../providers/ide-provider-instance.js';
import type { ProviderModule } from '../providers/contracts.js';

export interface CdpSetupContext {
  providerLoader: ProviderLoader;
  instanceManager: ProviderInstanceManager;
  cdpManagers: Map<string, DaemonCdpManager>;
  /** UUID instanceId → CDP manager key mapping */
  instanceIdMap: Map<string, string>;
  /** Server connection (optional) */
  serverConn?: any;
}

export interface SetupIdeInstanceOptions {
  /** Provider-based IDE type (e.g., 'antigravity', 'cursor') */
  ideType: string;
  /** Connected CDP manager */
  manager: DaemonCdpManager;
  /** CDP manager key (for multi-window: 'antigravity_remote_vs', single: 'antigravity') */
  managerKey?: string;
  /** Provider settings override */
  settings?: Record<string, any>;
}

/**
 * Register extension providers on a CDP manager.
 * Common pattern used during CDP init and periodic scans.
 */
export function registerExtensionProviders(
  providerLoader: ProviderLoader,
  manager: DaemonCdpManager,
  ideType: string,
): void {
  const enabledExtProviders = providerLoader.getEnabledExtensionProviders(ideType)
    .map((p: any) => ({
      agentType: p.type,
      extensionId: p.extensionId || '',
      extensionIdPattern: p.extensionIdPattern!,
    }));
  manager.setExtensionProviders(enabledExtProviders);
}

/**
 * Setup a CDP-connected IDE as a ProviderInstance.
 *
 * Performs:
 * 1. providerLoader.resolve() to get scripts
 * 2. Create IdeProviderInstance
 * 3. Register in InstanceManager
 * 4. Register enabled extensions
 * 5. Update instanceIdMap (IDE + extension UUIDs)
 *
 * @returns The created IdeProviderInstance, or null if provider not found
 */
export async function setupIdeInstance(
  ctx: CdpSetupContext,
  opts: SetupIdeInstanceOptions,
): Promise<IdeProviderInstance | null> {
  const { providerLoader, instanceManager, instanceIdMap } = ctx;
  const { ideType, manager, settings } = opts;
  const managerKey = opts.managerKey || ideType;

  // 1. Register extension providers on CDP manager
  registerExtensionProviders(providerLoader, manager, ideType);

  // 2. Resolve provider with scripts
  const ideProvider = providerLoader.resolve(ideType);
  if (!ideProvider) return null;

  // 3. Create IdeProviderInstance
  const ideInstance = new IdeProviderInstance(
    ideProvider,
    managerKey !== ideType ? managerKey : undefined,
  );

  // 4. Register in InstanceManager
  const resolvedSettings = settings || providerLoader.getSettings(ideType);
  await instanceManager.addInstance(`ide:${managerKey}`, ideInstance, {
    cdp: manager,
    serverConn: ctx.serverConn,
    settings: resolvedSettings,
  });

  // 5. Map IDE instance UUID → manager key
  instanceIdMap.set(ideInstance.getInstanceId(), managerKey);

  // 6. Register enabled extensions
  const extensionProviders = providerLoader.getEnabledByCategory('extension', ideType);
  for (const extProvider of extensionProviders) {
    const extSettings = providerLoader.getSettings(extProvider.type);
    await ideInstance.addExtension(extProvider, extSettings);
    // Map extension UUIDs too (CDP uses parent IDE)
    for (const ext of ideInstance.getExtensionInstances()) {
      instanceIdMap.set(ext.getInstanceId(), managerKey);
    }
  }

  return ideInstance;
}

/**
 * Create and connect a DaemonCdpManager for a given port.
 *
 * @returns Connected manager or null if connection failed
 */
export async function connectCdpManager(
  port: number,
  ideType: string,
  logFn: (msg: string) => void,
  providerLoader: ProviderLoader,
  targetId?: string,
): Promise<DaemonCdpManager | null> {
  const provider = providerLoader.getMeta(ideType);
  const manager = new DaemonCdpManager(
    port,
    logFn,
    targetId,
    (provider as any)?.targetFilter,
  );
  const connected = await manager.connect();
  return connected ? manager : null;
}

/**
 * Probe a CDP port to check if it's listening.
 * @returns true if CDP is available on this port
 */
export async function probeCdpPort(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const probe = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    }).then(r => r.json()).catch(() => null);
    return !!probe;
  } catch {
    return false;
  }
}
