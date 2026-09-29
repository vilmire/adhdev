

/**
 * A worker's trailing report block, parsed out of its final summary text —
 * either fenced (```json {...}```) or the whole summary being the object.
 * Requires at least one mesh worker-report field (`status` plus one of
 * `changedFiles`/`errors`/`gitStatus`/`nextAction`/`validationResults`) to
 * avoid false positives on unrelated JSON in a summary (tool output, log
 * lines). Returns `undefined` for prose-only, malformed, or non-worker-shaped
 * JSON — never throws.
 */
import { readString } from '@adhdev/mesh-shared';
export function extractJsonObjectFromSummary(summary?: string): Record<string, unknown> | undefined {
    const text = readString(summary);
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
