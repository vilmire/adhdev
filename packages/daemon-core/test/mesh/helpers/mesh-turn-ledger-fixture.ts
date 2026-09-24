/**
 * A real turn ledger for `test/mesh/*` component fixtures.
 *
 * Production `DaemonComponents` always carry the ledger S7 builds, and since
 * rc.39 `tryAssignQueueTask` REFUSES a claim without one (a queue dispatch with
 * no attempt can never be closed — the ledger-less IPC claim defect). Claim
 * tests therefore need a ledger just like production has one.
 *
 * The ledger is `createMeshRuntimeTurnLedger` over the CURRENT
 * `MeshRuntimeStore` — resolved lazily and rebuilt whenever the store instance
 * changes, because many tests reset the store (`__resetMeshRuntimeStoreForTests`)
 * after building their components. Publishing goes to an in-memory fake.
 */
import { MeshRuntimeStore } from '../../../src/mesh/mesh-runtime-store.js';
import { createMeshRuntimeTurnLedger } from '../../../src/mesh/turn-ledger/runtime-ledger.js';
import type { TurnLedger } from '../../../src/mesh/turn-ledger/ledger.js';
import { fakePublisher } from '../../turn-ledger/ledger-harness.js';

export function testTurnLedger(selfDaemonId = 'test-daemon'): TurnLedger {
    let cached: { store: MeshRuntimeStore; ledger: TurnLedger } | null = null;
    const current = (): TurnLedger => {
        const store = MeshRuntimeStore.getInstance();
        if (!cached || cached.store !== store) {
            cached = { store, ledger: createMeshRuntimeTurnLedger({ selfDaemonId, publisher: fakePublisher() }) };
        }
        return cached.ledger;
    };
    return new Proxy({} as TurnLedger, {
        get(_target, prop) {
            const ledger = current() as unknown as Record<PropertyKey, unknown>;
            const value = ledger[prop];
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(ledger) : value;
        },
    });
}

/** Attach a test ledger IN PLACE (like `withMeshRouter`) unless the fixture already set `turnLedger` (incl. an explicit null). */
export function withTurnLedger<T extends Record<string, any>>(components: T, selfDaemonId?: string): T {
    if (!('turnLedger' in components)) (components as any).turnLedger = testTurnLedger(selfDaemonId);
    return components;
}

/**
 * Drop every turn-ledger row from the CURRENT store. The store FILE survives
 * `__resetMeshRuntimeStoreForTests`, so files whose cases reuse session ids
 * (`runtime-session-1`, `auto-session-1`) must wipe between cases — otherwise
 * the previous case's still-open attempt for that session makes the next
 * claim's `dispatch_accepted` an illegal transition (correct production
 * behavior: one open attempt per session).
 */
export function wipeTurnTablesForTests(): void {
    const db = MeshRuntimeStore.getInstance().db;
    db.exec('DELETE FROM turn_holds; DELETE FROM turn_events; DELETE FROM turn_attempts;');
}
