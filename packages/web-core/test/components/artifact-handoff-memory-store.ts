import type { ArtifactHandoffRecord, ArtifactHandoffStore } from '../../src/components/attachments/artifact-handoff'

/** In-memory stand-in for the IndexedDB store (web-core has no IndexedDB shim). */
export function memoryStore(): ArtifactHandoffStore & { records: Map<string, ArtifactHandoffRecord> } {
    const records = new Map<string, ArtifactHandoffRecord>()
    return {
        records,
        async put(record) { records.set(record.handle, record) },
        async take(handle) { const r = records.get(handle) ?? null; records.delete(handle); return r },
        async sweep(cutoff) { for (const [k, r] of records) if (r.createdAt < cutoff) records.delete(k) },
    }
}
