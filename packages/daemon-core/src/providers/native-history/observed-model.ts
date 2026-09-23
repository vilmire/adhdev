/**
 * observed-model — the model a provider's own transcript says it ran.
 *
 * Wiring-unification Phase E: native-history readers already stamp the model
 * on every usage record (claude `message.model`, codex / hermes / spec
 * executors likewise) and fold them into `result.usage` — `model` is the LAST
 * record's model, `lastUsageAt` its time. That is the provider reporting what
 * it actually runs, i.e. an OBSERVATION for the session's launch record
 * (`SessionRegistry.observeLaunchAxis`).
 *
 * Pure: reads a native-history result, returns data. The caller — the read_chat
 * path that has already attributed the transcript to a session — does the
 * registry write, and only for a transcript it selected as that session's own.
 */

export interface ObservedModel {
    value: string;
    /** When the provider reported it (usage record time, else transcript mtime). */
    at: number;
}

export function nativeHistoryObservedModel(result: unknown): ObservedModel | null {
    if (!result || typeof result !== 'object') return null;
    const record = result as { usage?: { model?: unknown; lastUsageAt?: unknown }; sourceMtimeMs?: unknown };
    const model = typeof record.usage?.model === 'string' ? record.usage.model.trim() : '';
    if (!model) return null;
    const lastUsageAt = typeof record.usage?.lastUsageAt === 'number' && Number.isFinite(record.usage.lastUsageAt) && record.usage.lastUsageAt > 0
        ? record.usage.lastUsageAt
        : undefined;
    const mtime = typeof record.sourceMtimeMs === 'number' && Number.isFinite(record.sourceMtimeMs) && record.sourceMtimeMs > 0
        ? record.sourceMtimeMs
        : undefined;
    const at = lastUsageAt ?? mtime;
    return at === undefined ? null : { value: model, at };
}
