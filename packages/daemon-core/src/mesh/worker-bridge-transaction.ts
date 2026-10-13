import type { Database } from 'better-sqlite3';
// Bridge receipts add an OUTER transaction around existing nested ledger writes.
// Their post-commit effects must wait for the outer commit, not a savepoint.
const scopes = new WeakMap<Database, Array<() => void>>();
export function inBridgeReceiptTransaction(db: Database): boolean { return scopes.has(db); }
export function afterBridgeCommit(db: Database, action: () => void): void {
    const pending = scopes.get(db);
    if (pending) pending.push(action);
    else action();
}
export function bridgeReceiptTransaction<T>(db: Database, apply: () => T): T {
    if (db.inTransaction && !scopes.has(db)) throw new Error('bridge_receipt_requires_outermost_transaction');
    if (scopes.has(db)) return db.transaction(apply).immediate();
    const pending: Array<() => void> = [];
    scopes.set(db, pending);
    let result: T;
    try { result = db.transaction(apply).immediate(); }
    catch (error) { scopes.delete(db); throw error; }
    scopes.delete(db);
    for (const action of pending) {
        // Acceptance is already durable. Existing ledger publish-state and
        // boot reconciliation recover post-commit effects; never undo receipts.
        try { action(); } catch { /* retry through existing ledger recovery */ }
    }
    return result;
}
