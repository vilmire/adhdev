/**
 * Shared fixture for `test/mesh/*` files that drive `setupMeshEventForwarding`
 * with a synthetic provider event.
 *
 * Before wiring-unification B (residue cleanup), `setupMeshEventForwarding`
 * fell back to `instanceManager.onEvent(listener)` when `components.bus` was
 * absent, so these tests built a fake `instanceManager.onEvent` that captured
 * the listener and called it directly. That fallback is gone — the function
 * now requires `components.bus` — so this fixture gives each test a real
 * `SessionLifecycleBus` and an `emit` helper with the SAME call shape
 * (`emit(event)`), just routed through `bus.emit({kind:'provider_event', ...})`
 * instead of a captured callback.
 */
import { createSessionLifecycleBus } from '../../../src/sessions/lifecycle-bus.js';

/**
 * Attaches a real bus to `components` IN PLACE (mirrors `withMeshRouter` —
 * `mesh-router-stub.ts` — deliberately, not a copy): several existing tests
 * assign `components.cliManager = {...}` on the SAME object AFTER calling this
 * helper, so returning a shallow copy would silently detach that later
 * mutation from the object `setupMeshEventForwarding`/the router stub actually
 * reads. Returns an `emit(event)` helper that publishes the event as a
 * `provider_event` — exactly what `setupMeshEventForwarding`'s bus branch
 * subscribes to.
 *
 * `sessionId` defaults to `event.targetSessionId ?? event.instanceId`, mirroring
 * how `ProviderInstanceManager.dispatchProviderEvent` derives it in production.
 */
export function withMeshForwardingBus<T extends Record<string, any>>(components: T): T & { bus: ReturnType<typeof createSessionLifecycleBus>; emit(event: any): void } {
    const bus = createSessionLifecycleBus();
    (components as any).bus = bus;
    const emit = (event: any): void => {
        const sessionId = typeof event?.targetSessionId === 'string' && event.targetSessionId
            ? event.targetSessionId
            : String(event?.instanceId ?? '');
        bus.emit({ kind: 'provider_event', sessionId, at: Date.now(), event });
    };
    (components as any).emit = emit;
    return components as T & { bus: ReturnType<typeof createSessionLifecycleBus>; emit(event: any): void };
}
