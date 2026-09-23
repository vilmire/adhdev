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
import type { ProviderCategory } from './contracts.js';
import { LOG } from '../logging/logger.js';
import type { SessionLifecycleBus } from '../sessions/lifecycle-bus.js';
import type { SessionEventPort } from '../sessions/session-port.js';

export type ProviderEventListener = (event: ProviderEvent & { providerType: string }) => void;

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
    private bus: SessionLifecycleBus | null = null;
    private sessionEventPort: SessionEventPort | null = null;

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
            ...(this.sessionEventPort ? { lifecycle: this.sessionEventPort } : {}),
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
        category: ProviderCategory,
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
    getByCategory(category: ProviderCategory): ProviderInstance[] {
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
 * all Instance's current status collect. Provider events do not ride this
 * drain any more: every instance delivers them through its lifecycle port at
 * push time (wiring-unification B5).
 */
    collectAllStates(): ProviderState[] {
        const states: ProviderState[] = [];
        for (const [id, instance] of this.instances) {
            try {
                const state = instance.getState();
                // Phase E: the registry-owned launch record rides the state (CLI / ACP only).
                if (state.category === 'cli' || state.category === 'acp') {
                    const launch = this.sessionEventPort?.launchRecord?.(state.instanceId);
                    if (launch) state.launch = launch;
                }
                states.push(state);
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
    collectStatesByCategory(category: ProviderCategory): ProviderState[] {
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
            const now = Date.now();
            for (const [id, instance] of this.instances) {
                // MESH-STALL-WATCH (feature 1: STALL detection): a status-agnostic
                // watchdog for coordinator-spawned mesh worker sessions, driven by
                // THIS existing 5s tick (no separate timer). Cheap (reads the
                // adapter's raw-output clock only) and a no-op for non-mesh /
                // non-CLI instances, so it runs before the per-instance onTick.
                try {
                    instance.checkMeshWorkerStall?.(now);
                } catch (e) {
                    LOG.warn('InstanceMgr', `[InstanceManager] Mesh stall check failed for ${id}: ${(e as Error).message}`);
                }
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
     * @deprecated Wiring-unification B5 — every provider event consumer is a bus
     * subscriber (`provider_event`). Kept only as a thin adapter over the bus for
     * mesh-event-forwarding's bus-less test fallback; there is no listener array
     * and no buffer drain behind it any more.
     */
    onEvent(listener: ProviderEventListener): () => void {
        if (!this.bus) return () => {};
        return this.bus.on('provider_event', (e) => listener(e.event), { name: 'instance-manager.onEvent' });
    }

    /**
     * Forward every provider event to the lifecycle bus as the transitional
     * `provider_event` (wiring-unification B1). Pass null to detach.
     */
    attachBus(bus: SessionLifecycleBus | null): void {
        this.bus = bus;
    }

    /**
     * Port injected as `InstanceContext.lifecycle` into instances added from now
     * on, and handed to already-live instances through their optional setter.
     */
    setSessionEventPort(port: SessionEventPort | null): void {
        this.sessionEventPort = port;
        for (const [id, instance] of this.instances) {
            try {
                instance.setSessionEventPort?.(port);
            } catch (e) {
                LOG.warn('InstanceMgr', `[InstanceManager] setSessionEventPort failed for ${id}: ${(e as Error)?.message ?? e}`);
            }
        }
    }

    /**
     * Publish one enriched provider event on the bus (the transitional
     * `provider_event`). Every consumer is a bus subscriber since B5 — the
     * status-event emitter, mesh forwarding, quota refresh, dev SSE — each
     * isolated in its own try/catch by the bus itself.
     */
    private dispatchProviderEvent(payload: ProviderEvent & { providerType: string }): void {
        if (!this.bus) return;
        const sessionId = typeof payload.targetSessionId === 'string' && payload.targetSessionId
            ? payload.targetSessionId
            : String(payload.instanceId ?? '');
        this.bus.emit({ kind: 'provider_event', sessionId, at: Date.now(), event: payload });
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
        this.dispatchProviderEvent(payload);
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
     *  fired (the same task is already running on another live session here).
     *
     *  DUP-CLAIM-REBIND: when the guard fires, the id of the live session that already
     *  holds the task is returned as `holderSessionId`. The coordinator needs it to
     *  REBIND its turn-ledger attempt onto the real worker instead of cancelling the
     *  attempt — the guard already resolved that instance, so surfacing it here keeps
     *  the caller from having to parse it back out of an error string. */
    attachMeshAssignmentToInstance(instanceId: string, assignment: { meshId: string; nodeId?: string; taskId?: string; dispatchNonce?: number; attemptId?: string; coordinatorDaemonId?: string; coordinatorSessionId?: string }): { stamped: boolean; reason?: string; holderSessionId?: string } {
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
                return { stamped: false, reason: 'task_already_stamped_on_live_instance', holderSessionId: conflict };
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
    }
}
