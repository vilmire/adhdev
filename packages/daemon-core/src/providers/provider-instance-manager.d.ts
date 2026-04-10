/**
 * ProviderInstanceManager — lifecycle management for all ProviderInstances
 *
 * Role:
 * 1. Instance create/delete
 * 2. Tick engine (periodic onTick calls)
 * 3. Collect overall state
 * 4. Event collection and propagation
 */
import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext } from './provider-instance.js';
export declare class ProviderInstanceManager {
    private instances;
    private tickTimer;
    private tickInterval;
    private eventListeners;
    /**
    * Instance add and initialize
    */
    addInstance(id: string, instance: ProviderInstance, context: InstanceContext): Promise<void>;
    /**
    * Instance remove
    */
    removeInstance(id: string): void;
    removeByCategory(category: 'cli' | 'ide' | 'extension' | 'acp', options?: {
        dispose?: boolean;
    }): number;
    /**
    * Import by Instance ID
    */
    getInstance(id: string): ProviderInstance | undefined;
    /**
    * Per-category Instance list
    */
    getByCategory(category: 'cli' | 'ide' | 'extension' | 'acp'): ProviderInstance[];
    /**
    * All Instance count
    */
    get size(): number;
    /**
    * All Instance IDs (for iteration without exposing the private Map)
    */
    listInstanceIds(): string[];
    /**
    * all Instance's current status collect
    * + Propagate pending events to event listeners
    */
    collectAllStates(): ProviderState[];
    /**
    * Per-category status collect
    */
    collectStatesByCategory(category: 'cli' | 'ide' | 'extension' | 'acp'): ProviderState[];
    /**
    * Start tick — periodically call all Instance.onTick() call
    */
    startTicking(intervalMs?: number): void;
    /**
    * Stop tick
    */
    stopTicking(): void;
    /**
    * Register event listener (used for daemon status_event transmission)
    */
    onEvent(listener: (event: ProviderEvent & {
        providerType: string;
    }) => void): void;
    private emitPendingEvents;
    /**
    * Forward event to specific Instance
    */
    sendEvent(id: string, event: string, data?: any): void;
    /**
    * Broadcast event to all Instances
    */
    broadcast(event: string, data?: any): void;
    /**
     * Update settings for all instances of a given provider type.
     * Called when user changes settings from dashboard.
     */
    updateInstanceSettings(providerType: string, settings: Record<string, any>): number;
    /**
    * All terminate
    */
    disposeAll(): void;
}
