// Only declarative executor snapshots are immutable. Provider scripts may reuse
// and mutate their own arrays, so their normalization must not be memoized.
const snapshots = new WeakSet<object>();
export function markNativeHistorySnapshot<T extends object>(records: T): T {
    snapshots.add(records);
    return records;
}
export function isNativeHistorySnapshot(records: object): boolean {
    return snapshots.has(records);
}
