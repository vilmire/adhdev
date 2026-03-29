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
import { LOG } from '../logging/logger.js';

export class ProviderInstanceManager {
    private instances = new Map<string, ProviderInstance>();
    private tickTimer: NodeJS.Timeout | null = null;
    private tickInterval = 5_000; // default 5seconds
    private eventListeners: ((event: ProviderEvent & { providerType: string }) => void)[] = [];

 // ─── Instance manage ──────────────────────────────

 /**
 * Instance add and initialize
 */
    async addInstance(id: string, instance: ProviderInstance, context: InstanceContext): Promise<void> {
        if (this.instances.has(id)) {
            LOG.warn('InstanceMgr', `[InstanceManager] Instance ${id} already exists, disposing old one`);
            this.instances.get(id)!.dispose();
        }
        this.instances.set(id, instance);
        await instance.init(context);
    }

 /**
 * Instance remove
 */
    removeInstance(id: string): void {
        const instance = this.instances.get(id);
        if (instance) {
            instance.dispose();
            this.instances.delete(id);
        }
    }

 /**
 * Import by Instance ID
 */
    getInstance(id: string): ProviderInstance | undefined {
        return this.instances.get(id);
    }

 /**
 * Per-category Instance list
 */
    getByCategory(category: 'cli' | 'ide' | 'extension' | 'acp'): ProviderInstance[] {
        return [...this.instances.values()].filter(i => i.category === category);
    }

 /**
 * All Instance count
 */
    get size(): number {
        return this.instances.size;
    }

 // ─── State collect ────────────────────────────────

 /**
 * all Instance's current status collect
 * + Propagate pending events to event listeners
 */
    collectAllStates(): ProviderState[] {
        const states: ProviderState[] = [];
        for (const [id, instance] of this.instances) {
            try {
                const state = instance.getState();
                states.push(state);

 // pending events propagation
                for (const event of state.pendingEvents) {
                    for (const listener of this.eventListeners) {
                        listener({
                            ...event,
                            providerType: instance.type,
                            instanceId: state.instanceId,
                            providerCategory: state.category,
                        });
                    }
                }
            } catch (e) {
                LOG.warn('InstanceMgr', `[InstanceManager] Failed to collect state from ${id}: ${(e as Error).message}`);
            }
        }
        return states;
    }

 /**
 * Per-category status collect
 */
    collectStatesByCategory(category: 'cli' | 'ide' | 'extension' | 'acp'): ProviderState[] {
        return this.collectAllStates().filter(s => s.category === category);
    }

 // ─── Tick engine ─────────────────────────────────

 /**
 * Start tick — periodically call all Instance.onTick() call
 */
    startTicking(intervalMs?: number): void {
        if (this.tickTimer) return;
        this.tickInterval = intervalMs || this.tickInterval;

        this.tickTimer = setInterval(async () => {
            for (const [id, instance] of this.instances) {
                try {
                    await instance.onTick();
                } catch (e) {
                    LOG.warn('InstanceMgr', `[InstanceManager] Tick failed for ${id}: ${(e as Error).message}`);
                }
            }
        }, this.tickInterval);
    }

 /**
 * Stop tick
 */
    stopTicking(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

 // ─── event ────────────────────────────────────

 /**
 * Register event listener (used for daemon status_event transmission)
 */
    onEvent(listener: (event: ProviderEvent & { providerType: string }) => void): void {
        this.eventListeners.push(listener);
    }

 /**
 * Forward event to specific Instance
 */
    sendEvent(id: string, event: string, data?: any): void {
        this.instances.get(id)?.onEvent(event, data);
    }

 /**
 * Broadcast event to all Instances
 */
    broadcast(event: string, data?: any): void {
        for (const instance of this.instances.values()) {
            instance.onEvent(event, data);
        }
    }

 /**
  * Update settings for all instances of a given provider type.
  * Called when user changes settings from dashboard.
  */
    updateInstanceSettings(providerType: string, settings: Record<string, any>): number {
        let updated = 0;
        for (const instance of this.instances.values()) {
            if (instance.type === providerType && typeof instance.updateSettings === 'function') {
                instance.updateSettings(settings);
                updated++;
            }
        }
        return updated;
    }

 // ─── cleanup ──────────────────────────────────────

 /**
 * All terminate
 */
    disposeAll(): void {
        this.stopTicking();
        for (const [id, instance] of this.instances) {
            try { instance.dispose(); } catch { }
        }
        this.instances.clear();
        this.eventListeners = [];
    }
}
