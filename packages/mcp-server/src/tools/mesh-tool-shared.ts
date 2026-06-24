/**
 * Shared low-level helpers and constants for the mesh_* tool family.
 *
 * Leaf module: depends only on daemon-core/mesh-shared (never on mesh-tools.ts or
 * any of the split-out cluster files), so the cluster files (mesh-compact.ts,
 * mesh-queue-helpers.ts, mesh-node-identity.ts) and mesh-tools.ts can all import
 * from here without a runtime import cycle. Physically split out of mesh-tools.ts
 * (RF-SURVEY candidate C1) with no behavior change — same function bodies, same
 * constant values.
 */

export function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readNumeric(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

// ─── Large-value / ledger-field compaction (shared by queue + compact + ledger) ───

export const LARGE_LEDGER_FIELD_KEYS = new Set(['plan', 'validationPlan', 'suggestedConfig', 'payload']);
const LARGE_LEDGER_OBJECT_THRESHOLD = 800;
// Any nested object/array in a compact payload whose serialized size exceeds this
// is replaced with an elided placeholder. This is the PRIMARY defense: it covers
// arbitrary evidence keys (validationSummary, result, patchEquivalence,
// submoduleReachability, plus any future key) without a hardcoded allowlist. The
// specific per-key rules below are just tuning on top of this general guard.
const LARGE_LEDGER_NESTED_BYTES_THRESHOLD = 2000;

export function summarizeLargeLedgerField(key: string, value: unknown): unknown {
    if (typeof value === 'string') {
        return value.length > 500 ? value.slice(0, 500) + '…' : value;
    }
    if (Array.isArray(value)) {
        const serialized = JSON.stringify(value);
        if (serialized && serialized.length > LARGE_LEDGER_OBJECT_THRESHOLD) {
            return `[${key} summarized: ${value.length} items — use verbose=true or mesh_reconcile_ledger]`;
        }
        return value;
    }
    if (value && typeof value === 'object') {
        const serialized = JSON.stringify(value);
        if (serialized && serialized.length > LARGE_LEDGER_OBJECT_THRESHOLD) {
            return `[${key} summarized: ${Object.keys(value as Record<string, unknown>).length} keys — use verbose=true or mesh_reconcile_ledger]`;
        }
        return value;
    }
    return value;
}

// Generic nested-value guard. Replaces any object/array (or oversized string) whose
// serialized size exceeds LARGE_LEDGER_NESTED_BYTES_THRESHOLD with a compact
// placeholder that records the original key, byte size, and a recovery hint. Small
// scalars and short fields (source, success, async, into, mergedBranch, …) pass
// through untouched.
export function elideLargeNestedValue(key: string, value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        // Long bare strings (not one of the explicitly-capped fields) get a hard cap
        // so a single multi-KB string blob can't blow the payload either.
        return value.length > 1000 ? value.slice(0, 1000) + '…' : value;
    }
    if (typeof value !== 'object') return value; // number / boolean
    const serialized = JSON.stringify(value);
    const bytes = serialized ? serialized.length : 0;
    if (bytes <= LARGE_LEDGER_NESTED_BYTES_THRESHOLD) return value;
    return {
        _elided: true,
        _kind: key,
        _bytes: bytes,
        _hint: 'full evidence via mesh_reconcile_ledger',
    };
}
