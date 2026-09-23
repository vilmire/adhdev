// ---------------------------------------------------------------------------
// shared/worker-result-parse — pure JSON-object extraction from a final
// summary string (worker-report shaped only).
// ---------------------------------------------------------------------------
// Moved out of `mesh/mesh-ledger.ts` (wiring-unification C-W5c) so a
// `providers/**` producer (`completion/completion-flush.ts`) can compute the
// graph output envelope's `workerResult` field WITHOUT importing `mesh/**`
// (`check:boundaries` forbids `providers -> mesh` value imports). This file
// has zero mesh dependency — it is a pure string/JSON parse — so it belongs
// in the producer-neutral `shared/` directory alongside
// `mesh-event-trace.ts`/`usage-normalize.ts`, the same pattern other
// providers<->mesh shared pieces already use.
//
// `mesh/mesh-ledger.ts` still needs it (the ledger evidence record's own
// final-summary parse) and re-exports it for its existing callers so nothing
// downstream breaks.
// ---------------------------------------------------------------------------

function readNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * A worker's trailing report block, parsed out of its final summary text —
 * either fenced (```json {...}```) or the whole summary being the object.
 * Requires at least one mesh worker-report field (`status` plus one of
 * `changedFiles`/`errors`/`gitStatus`/`nextAction`/`validationResults`) to
 * avoid false positives on unrelated JSON in a summary (tool output, log
 * lines). Returns `undefined` for prose-only, malformed, or non-worker-shaped
 * JSON — never throws.
 */
export function extractJsonObjectFromSummary(summary?: string): Record<string, unknown> | undefined {
    const text = readNonEmptyString(summary);
    if (!text) return undefined;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [fenced?.[1], text].filter(Boolean) as string[];
    for (const candidate of candidates) {
        const trimmed = candidate.trim();
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                // Require at least one mesh worker result field to avoid false positives
                // (e.g. JSON from tool call outputs or log lines in the final summary).
                const hasWorkerShape = 'status' in parsed && (
                    'changedFiles' in parsed || 'errors' in parsed
                    || 'gitStatus' in parsed || 'nextAction' in parsed
                    || 'validationResults' in parsed
                );
                if (hasWorkerShape) return parsed;
            }
        } catch { /* try next candidate */ }
    }
    return undefined;
}
