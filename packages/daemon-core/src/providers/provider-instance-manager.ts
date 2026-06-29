/**
 * ProviderInstanceManager — lifecycle management for all ProviderInstances
 *
 * Role:
 * 1. Instance create/delete
 * 2. Tick engine (periodic onTick calls)
 * 3. Collect overall state
 * 4. Event collection and propagation
 */

import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext, HotChatSessionState, SessionModalState } from './provider-instance.js';
import { LOG } from '../logging/logger.js';

function projectHotChatSessionStatesFromProviderState(state: ProviderState): HotChatSessionState[] {
    const project = (item: ProviderState): HotChatSessionState => ({
        id: item.instanceId,
        status: item.activeChat?.status || item.status,
        unread: (item as any).unread,
        inboxBucket: (item as any).inboxBucket,
        lastMessageAt: (item as any).lastMessageAt ?? (item.activeChat as any)?.lastMessageAt,
        runtimeLifecycle: item.runtime?.lifecycle ?? null,
        runtimeSurfaceKind: item.runtime?.surfaceKind,
        runtimeRestoredFromStorage: item.runtime?.restoredFromStorage === true,
        runtimeRecoveryState: item.runtime?.recoveryState ?? null,
    });

    if (state.category === 'ide') {
        return [project(state), ...state.extensions.map(project)];
    }
    return [project(state)];
}

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
        await instance.init({
            ...context,
            emitProviderEvent: (event) => this.emitProviderEvent(instance.type, id, event),
        });
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

    removeByCategory(
        category: 'cli' | 'ide' | 'extension' | 'acp',
        options: { dispose?: boolean } = {},
    ): number {
        const dispose = options.dispose !== false;
        let removed = 0;
        for (const [id, instance] of this.instances) {
            if (instance.category !== category) continue;
            if (dispose) {
                try {
                    instance.dispose();
                } catch {
                    // noop
                }
            }
            this.instances.delete(id);
            removed += 1;
        }
        return removed;
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

 /**
 * All Instance IDs (for iteration without exposing the private Map)
 */
    listInstanceIds(): string[] {
        return [...this.instances.keys()];
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
                this.emitPendingEvents(instance.type, state);
                if (state.category === 'ide') {
                    for (const childState of state.extensions) {
                        this.emitPendingEvents(childState.type, childState, {
                            targetSessionId: childState.instanceId,
                            workspaceName: state.workspace || undefined,
                            parentSessionId: state.instanceId,
                        });
                    }
                }
            } catch (e) {
                LOG.warn('InstanceMgr', `[InstanceManager] Failed to collect state from ${id}: ${(e as Error).message}`);
            }
        }
        return states;
    }

    collectHotChatSessionStates(): HotChatSessionState[] {
        const sessions: HotChatSessionState[] = [];
        for (const [id, instance] of this.instances) {
            try {
                const projected = instance.getHotChatSessionState?.();
                if (Array.isArray(projected)) {
                    sessions.push(...projected.filter((session): session is HotChatSessionState => !!session?.id));
                    continue;
                }
                if (projected?.id) {
                    sessions.push(projected);
                    continue;
                }

                // Fallback for provider types that have not implemented the cheap
                // projection yet. CLI implements getHotChatSessionState() because
                // its full getState() may run rich transcript parsing.
                const state = instance.getState();
                sessions.push(...projectHotChatSessionStatesFromProviderState(state));
            } catch (e) {
                LOG.warn('InstanceMgr', `[InstanceManager] Failed to collect hot chat metadata from ${id}: ${(e as Error).message}`);
            }
        }
        return sessions;
    }

    getSessionModalState(sessionId: string, options: { instanceKey?: string | null } = {}): SessionModalState | null {
        if (!sessionId) return null;
        const candidates = [sessionId];
        if (options.instanceKey && options.instanceKey !== sessionId) {
            candidates.push(options.instanceKey);
        }

        for (const id of candidates) {
            const instance = this.instances.get(id);
            if (!instance?.getSessionModalState) continue;
            try {
                const projected = instance.getSessionModalState(sessionId);
                if (!projected?.id) continue;
                if (projected.id !== sessionId) {
                    LOG.warn('InstanceMgr', `[InstanceManager] Ignoring mismatched session modal projection from ${id}: requested=${sessionId} projected=${projected.id}`);
                    continue;
                }
                return projected;
            } catch (e) {
                LOG.warn('InstanceMgr', `[InstanceManager] Failed to project session modal metadata from ${id}: ${(e as Error).message}`);
            }
        }

        return null;
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

    emitProviderEvent(providerType: string, instanceId: string, event: ProviderEvent): void {
        const payload = {
            ...event,
            providerType,
            instanceId: typeof event.instanceId === 'string' && event.instanceId.trim()
                ? event.instanceId
                : instanceId,
            targetSessionId: typeof event.targetSessionId === 'string' && event.targetSessionId.trim()
                ? event.targetSessionId
                : instanceId,
        } as ProviderEvent & { providerType: string };
        for (const listener of this.eventListeners) {
            listener(payload);
        }
    }

    private emitPendingEvents(
        providerType: string,
        state: ProviderState,
        extra: Record<string, unknown> = {},
    ): void {
        for (const event of state.pendingEvents) {
            for (const listener of this.eventListeners) {
                listener({
                    ...event,
                    providerType,
                    instanceId: state.instanceId,
                    targetSessionId: state.instanceId,
                    workspaceName: state.workspace || undefined,
                    ...extra,
                });
            }
        }
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

    /** Stamp a mesh assignment on a single instance (used by mesh_send_task
     *  --direct so the worker's completion event has a coordinator routing
     *  marker in state.settings). Returns `{ stamped: true }` when the stamp was
     *  applied, or `{ stamped: false, reason }` when it was refused — the instance
     *  was missing / has no attach method, or the DOUBLE-DISPATCH idempotence guard
     *  fired (the same task is already running on another live session here). */
    attachMeshAssignmentToInstance(instanceId: string, assignment: { meshId: string; nodeId?: string; taskId?: string; coordinatorDaemonId?: string; coordinatorSessionId?: string }): { stamped: boolean; reason?: string } {
        const inst = this.instances.get(instanceId);
        if (!inst || typeof inst.attachMeshAssignment !== 'function') {
            LOG.warn('MeshDispatch', `attachMeshAssignment skipped: instance ${instanceId} ${inst ? 'has no attach method' : 'not found'}`);
            return { stamped: false, reason: inst ? 'instance_has_no_attach_method' : 'instance_not_found' };
        }
        // DOUBLE-DISPATCH stamp idempotence guard (defense in depth): refuse to stamp this
        // (meshId, taskId) onto a SECOND instance when a DIFFERENT, still-live and actively
        // working instance already holds the exact same task. Two sessions carrying one taskId
        // double-execute the work (the auto-launch race RCA: a delayed claim by the original
        // session plus the new session's post-boot claim sequentially stamp the same task —
        // the atomic claim only blocks SIMULTANEOUS claims). A stale/dead/idle prior holder is
        // NOT a conflict — a legitimate re-dispatch after a dispatch failure must still stamp.
        if (assignment.taskId) {
            const conflict = this.findLiveWorkingTaskHolder(assignment.meshId, assignment.taskId, instanceId);
            if (conflict) {
                LOG.warn('MeshDispatch', `attachMeshAssignment refused: task ${assignment.taskId} (mesh ${assignment.meshId}) is already being worked by live session ${conflict} — skipping duplicate stamp on ${instanceId}`);
                return { stamped: false, reason: 'task_already_stamped_on_live_instance' };
            }
        }
        inst.attachMeshAssignment(assignment);
        LOG.info('MeshDispatch', `stamped mesh assignment on ${instanceId}: mesh=${assignment.meshId} node=${assignment.nodeId || ''} task=${assignment.taskId || ''} coordinator=${assignment.coordinatorDaemonId || ''}`);
        return { stamped: true };
    }

    /**
     * DOUBLE-DISPATCH support: the id of another LIVE, actively-working instance that already
     * holds (meshId, taskId), or null. "Live working" = stamped with this exact mesh+task AND
     * currently mid-turn / booting toward it (generating / waiting on approval-or-choice /
     * starting) — NOT idle, stopped, or errored. A stale/dead/idle holder is deliberately
     * ignored so a legitimate re-dispatch (e.g. after a dispatch failure) is never blocked.
     * The instance being stamped (excludeInstanceId) is skipped so re-stamping the same
     * session stays idempotent. O(n) over instances — the count is small.
     */
    private findLiveWorkingTaskHolder(meshId: string, taskId: string, excludeInstanceId: string): string | null {
        // Mid-turn / booting statuses (top-level or activeChat). Anything else — idle, stopped,
        // error — is not a live worker actively holding the task.
        const working = new Set(['generating', 'waiting_approval', 'waiting_choice', 'starting', 'streaming', 'working', 'no_progress', 'long_generating']);
        for (const [id, inst] of this.instances) {
            if (id === excludeInstanceId) continue;
            let state: ProviderState;
            try {
                state = inst.getState();
            } catch {
                continue;
            }
            const settings = (state.settings as Record<string, unknown>) || {};
            if (settings.meshNodeFor !== meshId) continue;
            if (settings.meshActiveTaskId !== taskId) continue;
            const status = (typeof state.status === 'string' ? state.status : '').toLowerCase();
            const chatStatus = (typeof state.activeChat?.status === 'string' ? state.activeChat.status : '').toLowerCase();
            if (working.has(status) || working.has(chatStatus)) return id;
        }
        return null;
    }

    /** Clear a mesh assignment after the dispatched task reaches a terminal
     *  state (generating_completed / stopped / failed). */
    detachMeshAssignmentFromInstance(instanceId: string): boolean {
        const inst = this.instances.get(instanceId);
        if (!inst || typeof inst.detachMeshAssignment !== 'function') return false;
        inst.detachMeshAssignment();
        return true;
    }

    refreshProviderDefinitions(resolveProvider: (providerType: string) => unknown): number {
        let refreshed = 0;
        for (const instance of this.instances.values()) {
            if (typeof instance.refreshProviderDefinition !== 'function') continue;
            const provider = resolveProvider(instance.type);
            if (!provider || typeof provider !== 'object') continue;
            instance.refreshProviderDefinition(provider as any);
            refreshed += 1;
        }
        return refreshed;
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
