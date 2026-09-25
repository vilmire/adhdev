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

// WTDISPATCH-LEDGER-DRAIN: every ledger this fixture hands out, so a test's
// cleanup can await their in-flight publishes before resetting the store.
// `observe()` fires `void flushPublish()` (autoFlush, ledger.ts) on a
// committed evidence write — fire-and-forget, and `drain()` always yields the
// event loop at least once (`await publisher.publish(...)`, true even for the
// in-memory `fakePublisher`). A test whose cleanup calls
// `MeshRuntimeStore.resetForTests()` synchronously right after a successful
// claim can close the db before that queued continuation resumes, so the
// continuation's next `store.pendingPublish()` throws "database connection is
// not open" as an unhandled rejection (observed in
// mesh-wtdispatch-claim-node-scope.test.ts). Draining here closes that race.
const liveTestLedgers = new Set<TurnLedger>();

export function testTurnLedger(selfDaemonId = 'test-daemon'): TurnLedger {
    let cached: { store: MeshRuntimeStore; ledger: TurnLedger } | null = null;
    const current = (): TurnLedger => {
        const store = MeshRuntimeStore.getInstance();
        if (!cached || cached.store !== store) {
            const ledger = createMeshRuntimeTurnLedger({ selfDaemonId, publisher: fakePublisher() });
            cached = { store, ledger };
            liveTestLedgers.add(ledger);
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

/**
 * Await every in-flight `flushPublish()` fired by a ledger this fixture
 * created. Call this BEFORE `__resetMeshRuntimeStoreForTests()` (or any other
 * `MeshRuntimeStore.resetForTests()`) in a test that used
 * `withMeshRouter`/`withTurnLedger`, or the store's `.close()` can race a
 * still-pending async publish — see the WTDISPATCH-LEDGER-DRAIN note above.
 * Safe to call unconditionally: `flushPublish()` is a no-op when there is
 * nothing pending, and this clears the tracked set before awaiting so an
 * already-drained ledger from an earlier test is never re-flushed.
 */
export async function __drainTestTurnLedgersForTests(): Promise<void> {
    const ledgers = [...liveTestLedgers];
    liveTestLedgers.clear();
    await Promise.allSettled(ledgers.map((l) => l.flushPublish()));
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
