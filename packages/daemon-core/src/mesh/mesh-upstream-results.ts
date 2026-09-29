/**
 * D4 — "Upstream results" dispatch appendix.
 *
 * A task with predecessors (queue-level `dependsOn`) receives, at dispatch, each predecessor's accepted
 * completion summary (the `final_summary` of its latest `completed` output
 * version in mesh_task_outputs, i.e. what `report_completion` delivered). Before
 * this, a `depends_on` chain carried ordering only: the downstream worker had to
 * be told by the coordinator what upstream found, which is why coordinators
 * re-stated results by hand.
 *
 * Body order is fixed by the caller (worker-handoff-dispatch.ts):
 *   authored message → Upstream results → Handoff notes → worker protocol footer.
 *
 * ★ Security posture: summaries are worker-authored and therefore UNTRUSTED.
 * They are rendered through the one shared envelope renderer
 * (`renderUntrustedEvidenceEnvelopes`, mesh-untrusted-evidence.ts):
 * fixed preamble, `trust="untrusted"` envelopes, secret redaction, envelope
 * defanging. The text lands ONLY in this appendix of the DISPATCHED body — it is
 * never persisted onto the queue row and never touches any other task field.
 *
 * Limits: each summary ≤ {@link UPSTREAM_RESULT_MAX_CHARS} chars; the whole
 * appendix ≤ {@link UPSTREAM_RESULTS_MAX_BYTES} bytes. Predecessors render
 * oldest-first; when the budget is exceeded the OLDEST are dropped (the nearest
 * upstream is the most relevant) and the omission is announced, never silent.
 */

import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { renderUntrustedEvidenceEnvelopes, type MeshUntrustedEvidenceBlock } from './mesh-untrusted-evidence.js';
import { sha256Hex } from '../system/hash.js';

/** Per-predecessor summary cap (characters, before envelope framing). */
export const UPSTREAM_RESULT_MAX_CHARS = 600;
/** Whole-appendix cap (UTF-8 bytes, including header, preamble and framing). */
export const UPSTREAM_RESULTS_MAX_BYTES = 4 * 1024;
/** The appendix heading — also the idempotency marker. */
export const UPSTREAM_RESULTS_HEADING = '## Upstream results';
/** The line a predecessor without an accepted report contributes. */
export const UPSTREAM_RESULT_NO_REPORT = '(no report)';

interface PredecessorResult {
    taskId: string;
    /** Sort key: completion time, else the queue row's creation. */
    atMs: number;
    summary?: string;
    outputVersion?: number;
}

interface UpstreamResultsTask {
    id: string;
    dependsOn?: unknown;
}

function readIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim());
}

/** Queue `dependsOn`, deduped (the task itself excluded). */
export function collectPredecessorTaskIds(task: UpstreamResultsTask): string[] {
    const ids = new Set(readIds(task.dependsOn));
    ids.delete(task.id);
    return [...ids];
}

function loadPredecessor(meshId: string, taskId: string): PredecessorResult {
    const store = MeshRuntimeStore.getInstance();
    let atMs = Number.MAX_SAFE_INTEGER;
    try {
        const entry = store.findQueueEntryById(meshId, taskId);
        const created = entry ? Date.parse(entry.createdAt) : NaN;
        if (Number.isFinite(created)) atMs = created;
    } catch { /* ordering falls back to "newest" */ }
    try {
        const output = store.getLatestTaskOutput(taskId);
        if (output) {
            // Any terminal output orders the predecessor by when it settled; only
            // an accepted (`completed`) one contributes its summary.
            const envelope = JSON.parse(output.envelopeJson) as Record<string, unknown>;
            const completedAt = typeof envelope.completed_at === 'string' ? Date.parse(envelope.completed_at) : NaN;
            const at = Number.isFinite(completedAt) ? completedAt : Date.parse(output.createdAt);
            if (Number.isFinite(at)) atMs = at;
            const summary = typeof envelope.final_summary === 'string' ? envelope.final_summary.trim() : '';
            if (output.status === 'completed' && summary) return { taskId, atMs, summary, outputVersion: output.version };
        }
    } catch { /* unreadable output ⇒ "(no report)" */ }
    return { taskId, atMs };
}

function truncateChars(text: string, max: number): { text: string; truncated: boolean } {
    const chars = Array.from(text);
    if (chars.length <= max) return { text, truncated: false };
    return { text: `${chars.slice(0, max - 1).join('')}…`, truncated: true };
}

function render(taskId: string, items: readonly PredecessorResult[], omitted: number): string {
    // Rendered in oldest-first order; envelopes and "(no report)" lines interleave
    // so the worker sees the chain in the order it ran.
    const segments: string[] = [];
    const blocks: MeshUntrustedEvidenceBlock[] = [];
    const segmentKinds: Array<'block' | 'line'> = [];
    for (const item of items) {
        if (item.summary) {
            const { text, truncated } = truncateChars(item.summary, UPSTREAM_RESULT_MAX_CHARS);
            blocks.push({
                attributes: {
                    kind: 'upstream_result',
                    source_task_id: item.taskId,
                    output_version: item.outputVersion ?? 0,
                    format: 'text',
                    sha256: sha256Hex(item.summary),
                    ...(truncated ? { truncated: true } : {}),
                },
                text,
            });
            segmentKinds.push('block');
        } else {
            segmentKinds.push('line');
        }
    }
    const envelopes = blocks.length > 0
        ? renderUntrustedEvidenceEnvelopes(blocks, { kind: 'upstream_results', taskId })
        : null;
    const preamble = envelopes?.preamble ?? '';
    const renderedBlocks = envelopes?.envelopes ?? [];
    let blockIndex = 0;
    items.forEach((item, i) => {
        if (segmentKinds[i] === 'block') segments.push(renderedBlocks[blockIndex++]);
        else segments.push(`- Upstream task ${item.taskId}: ${UPSTREAM_RESULT_NO_REPORT}`);
    });
    const omissionLine = omitted > 0
        ? `\n\n_${omitted} older upstream result(s) omitted to fit the ${UPSTREAM_RESULTS_MAX_BYTES}-byte budget — the nearest predecessors are shown._`
        : '';
    return `${UPSTREAM_RESULTS_HEADING}\n\n${preamble ? `${preamble}\n\n` : ''}${segments.join('\n\n')}${omissionLine}`;
}

/**
 * The appendix for `task`, or `null` when it has no predecessors. Never throws
 * past its own lookups (a store fault degrades to "(no report)" lines).
 */
export function buildUpstreamResultsAppendix(meshId: string, task: UpstreamResultsTask): string | null {
    const predecessorIds = collectPredecessorTaskIds(task);
    if (predecessorIds.length === 0) return null;
    const all = predecessorIds.map(id => loadPredecessor(meshId, id))
        .sort((a, b) => a.atMs - b.atMs || a.taskId.localeCompare(b.taskId));
    // Drop OLDEST first until the rendered appendix fits; always keep the newest one.
    for (let drop = 0; drop < all.length; drop += 1) {
        const kept = all.slice(drop);
        const text = render(task.id, kept, drop);
        if (Buffer.byteLength(text, 'utf8') <= UPSTREAM_RESULTS_MAX_BYTES || kept.length === 1) return text;
    }
    return null;
}
