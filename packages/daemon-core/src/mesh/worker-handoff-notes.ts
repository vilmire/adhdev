/**
 * Worker handoff notes — storage, relevance selection, and prompt enclosure.
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §5 (decision C), §9.1 (F),
 * §9.2 (G — retention), §12-4 (retention = 30 days).
 *
 * ─── Why PUSH and not PULL ──────────────────────────────────────────────
 *
 * The obvious design is a tool a worker calls to ask "did anyone leave me a
 * note?". That design fails on its own premise: a worker does not know what it
 * does not know. A conflict resolver only benefits from `peer_context_pull` if
 * it thinks to call it, and the workers most in need of the context are exactly
 * the ones who will not think to ask.
 *
 * So the note is delivered where it CANNOT be missed — inside the task prompt
 * itself. The worker reads it because reading the prompt is the one thing every
 * worker does. (A pull tool is still useful as a supplement — that is decision
 * D, a later step, and it reads what this module stores.)
 *
 * ─── One store ─────────────────────────────────────────────────────────
 *
 * A note lives in `mesh-runtime.db` (SQLite) only, in two rows of one
 * retention window (30 days, `pruneExpiredHandoffNotes`):
 *
 *   - `turn_events` holds the META row: which task, which files, when, how
 *     long. It is queryable, and it is what relevance matching runs against.
 *     It holds NO authored prose.
 *   - `mesh_handoff_note_text` holds the TEXT.
 *
 * Until 2026-09-29 the text was ALSO kept in an in-memory Map and appended to
 * the `mesh.<id>.handoff` seqscribe topic. Neither had a reader: the Map was a
 * read cache in front of the table, and nothing ever read a `worker.handoff`
 * entry back from the topic (a peer-originated note is skipped at selection
 * for want of local text — see selectRelevantHandoffNotes). Three copies of one
 * fact, one of them unbounded and full-sync replicated, were removed; the
 * topic remains only for turn summaries (`appendMeshHandoff`).
 */

import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { WORKER_HANDOFF_EVENT_KIND } from './worker-report.js';
import { type WorkerHandoffNotes } from './worker-report-validation.js';

/** Owner decision §12-4: notes live 30 days past their mission's close. */
export const HANDOFF_RETENTION_DAYS = 30;
export const HANDOFF_RETENTION_MS = HANDOFF_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** How many notes may ride along on one task prompt. */
export const HANDOFF_ENCLOSE_MAX_NOTES = 5;
/** Byte budget for the whole enclosed block. Well under the coordinator prompt's 96KB. */
export const HANDOFF_ENCLOSE_MAX_BYTES = 8 * 1024;

// ─── Note text store ────────────────────────────────────────────────────

interface StoredHandoffNote {
    meshId: string;
    taskId: string;
    attemptId?: string;
    nodeId?: string;
    notes: WorkerHandoffNotes;
    recordedAtIso: string;
}

/**
 * Read a note's text from the durable table.
 *
 * Returns null only when this daemon never held the note (it was recorded on
 * a peer machine).
 */
function loadNoteText(meshId: string, taskId: string): StoredHandoffNote | null {
    let row: ReturnType<MeshRuntimeStore['getHandoffNoteText']>;
    try {
        row = MeshRuntimeStore.getInstance().getHandoffNoteText(meshId, taskId);
    } catch (e: any) {
        LOG.warn('HandoffNotes', `Handoff note text lookup failed for task ${taskId}: ${e?.message || e}`);
        return null;
    }
    if (!row) return null;
    let notes: WorkerHandoffNotes;
    try {
        notes = JSON.parse(row.notesJson) as WorkerHandoffNotes;
    } catch (e: any) {
        LOG.warn('HandoffNotes', `Handoff note text for task ${taskId} is unparseable: ${e?.message || e}`);
        return null;
    }
    if (!notes?.intent || !Array.isArray(notes.touchedFiles)) return null;
    return {
        meshId: row.meshId,
        taskId: row.taskId,
        ...(row.attemptId ? { attemptId: row.attemptId } : {}),
        ...(row.nodeId ? { nodeId: row.nodeId } : {}),
        notes,
        recordedAtIso: row.recordedAt,
    };
}

/**
 * Persist one handoff note's TEXT. Called from the report path's sink.
 *
 * The ledger META row is written by the report path itself (it owns the
 * attemptId and the turn-event write); this function owns the text row.
 * A throw propagates to recordHandoffNote, which reports the note as NOT
 * recorded — the note text is the whole payload, so failing to persist it must
 * not be dressed up as success.
 */
export function storeHandoffNote(note: StoredHandoffNote): void {
    MeshRuntimeStore.getInstance().upsertHandoffNoteText({
        meshId: note.meshId,
        taskId: note.taskId,
        ...(note.attemptId ? { attemptId: note.attemptId } : {}),
        ...(note.nodeId ? { nodeId: note.nodeId } : {}),
        notesJson: JSON.stringify(note.notes),
        recordedAt: note.recordedAtIso,
    });
}

/** Read one stored note's text, if this daemon holds it. */
export function getStoredHandoffNote(meshId: string, taskId: string): StoredHandoffNote | null {
    return loadNoteText(meshId, taskId);
}

// ─── Relevance ──────────────────────────────────────────────────────────

export interface HandoffNoteCandidate extends StoredHandoffNote {
    /** Why this note was selected — surfaced in the rendered block. */
    reason: 'touched_files' | 'same_mission' | 'same_branch';
    /** Files shared with the incoming task, when the match was file-based. */
    overlap?: string[];
}

interface HandoffRelevanceInput {
    meshId: string;
    /** The task about to be dispatched. Its own note (if any) is never enclosed. */
    taskId: string;
    /** Files the incoming task is expected to touch, when known. */
    touchedFiles?: string[];
    missionId?: string;
    branch?: string;
    /** Resolve a note's task to its mission id — injected to avoid a queue import cycle. */
    lookupMissionId?: (taskId: string) => string | undefined;
    /** Resolve a note's task to the branch it ran on. */
    lookupBranch?: (taskId: string) => string | undefined;
    nowMs?: number;
}

/**
 * Select the notes worth enclosing with a task, strongest signal first.
 *
 * Ordering follows design §5: touched-file intersection (the strongest — two
 * agents editing one file is the case notes exist for), then same mission, then
 * same branch. Within a tier, newest first.
 *
 * ★A task never receives its OWN note. It would be circular and it would waste
 * the budget on the one thing the worker already knows.
 */
export function selectRelevantHandoffNotes(input: HandoffRelevanceInput): HandoffNoteCandidate[] {
    const store = MeshRuntimeStore.getInstance();
    let rows: ReturnType<ReturnType<typeof store.turnStore>['listWorkerEventsByKind']>;
    try {
        rows = store.turnStore().listWorkerEventsByKind(input.meshId, WORKER_HANDOFF_EVENT_KIND, 200);
    } catch (e: any) {
        LOG.warn('HandoffNotes', `Handoff note lookup failed for mesh ${input.meshId}: ${e?.message || e}`);
        return [];
    }

    const wantedFiles = new Set((input.touchedFiles || []).map(normalizeFilePath).filter(Boolean));
    const cutoffMs = (input.nowMs ?? Date.now()) - HANDOFF_RETENTION_MS;

    const byFiles: HandoffNoteCandidate[] = [];
    const byMission: HandoffNoteCandidate[] = [];
    const byBranch: HandoffNoteCandidate[] = [];
    const seenTasks = new Set<string>([input.taskId]);

    for (const row of rows) {
        if (seenTasks.has(row.taskId)) continue;
        // A note past its retention window is not enclosed even if the sweep has
        // not run yet — otherwise the effective lifetime would be "30 days, or
        // longer if the daemon happened not to sweep", which is not a policy.
        const recordedMs = row.atMs;
        if (Number.isFinite(recordedMs) && recordedMs < cutoffMs) continue;

        const stored = loadNoteText(input.meshId, row.taskId);
        // ★No text on this daemon. After F2 this means the note genuinely
        // originated on a PEER machine (its text rode the content topic, which
        // only a fleet-secret holder can read back) — it no longer means "this
        // daemon restarted", which used to silently disqualify every note ever
        // recorded here. Logged rather than dropped in silence: an index row
        // with no text is now unexpected, and a silent `continue` is what hid
        // the original defect for as long as it did.
        if (!stored) {
            LOG.debug('HandoffNotes', `Handoff note index row for task ${row.taskId} has no local text — peer-originated note, skipping enclosure.`);
            continue;
        }

        const meta = row.payload as { touchedFiles?: unknown };
        const noteFiles = Array.isArray(meta.touchedFiles)
            ? (meta.touchedFiles as unknown[]).filter((f): f is string => typeof f === 'string')
            : stored.notes.touchedFiles;

        const overlap = wantedFiles.size
            ? noteFiles.filter((f) => wantedFiles.has(normalizeFilePath(f)))
            : [];
        if (overlap.length) {
            seenTasks.add(row.taskId);
            byFiles.push({ ...stored, reason: 'touched_files', overlap });
            continue;
        }
        if (input.missionId && input.lookupMissionId?.(row.taskId) === input.missionId) {
            seenTasks.add(row.taskId);
            byMission.push({ ...stored, reason: 'same_mission' });
            continue;
        }
        if (input.branch && input.lookupBranch?.(row.taskId) === input.branch) {
            seenTasks.add(row.taskId);
            byBranch.push({ ...stored, reason: 'same_branch' });
        }
    }

    return [...byFiles, ...byMission, ...byBranch];
}

function normalizeFilePath(value: string): string {
    return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

// ─── Rendering ──────────────────────────────────────────────────────────

interface RenderedHandoffBlock {
    text: string;
    included: number;
    omitted: number;
}

/**
 * Render selected notes as a prompt section.
 *
 * ★Truncation is ANNOUNCED, never silent (gate checklist ②'s principle applied
 * to prompt text): a worker that reads three notes and is not told two were
 * dropped will reason as though it saw everything. The omission line is what
 * turns an incomplete view into a known-incomplete one.
 */
export function renderHandoffNotesBlock(
    notes: readonly HandoffNoteCandidate[],
    opts: { maxNotes?: number; maxBytes?: number } = {},
): RenderedHandoffBlock | null {
    if (!notes.length) return null;
    const maxNotes = opts.maxNotes ?? HANDOFF_ENCLOSE_MAX_NOTES;
    const maxBytes = opts.maxBytes ?? HANDOFF_ENCLOSE_MAX_BYTES;

    const header = '## Handoff notes from related work\n\n'
        + '_Left by earlier agents whose changes overlap yours. They cannot be asked follow-up questions._\n';
    const parts: string[] = [];
    let used = Buffer.byteLength(header, 'utf8');
    let included = 0;

    for (const note of notes) {
        if (included >= maxNotes) break;
        const rendered = renderOneNote(note);
        const cost = Buffer.byteLength(rendered, 'utf8');
        // Always admit the first note even if it alone exceeds the budget — a
        // block that renders nothing because the strongest match was long is
        // worse than a block slightly over budget.
        if (included > 0 && used + cost > maxBytes) break;
        parts.push(rendered);
        used += cost;
        included += 1;
    }

    const omitted = notes.length - included;
    const omissionLine = omitted > 0
        ? `\n_${omitted} further related note(s) omitted to fit the enclosure budget — the most relevant are shown first._\n`
        : '';

    return { text: `${header}${parts.join('')}${omissionLine}`, included, omitted };
}

function renderOneNote(note: HandoffNoteCandidate): string {
    const why = note.reason === 'touched_files'
        ? `overlapping files: ${(note.overlap || []).join(', ')}`
        : note.reason === 'same_mission'
            ? 'same mission'
            : 'same branch';
    const lines = [`\n### From task ${note.taskId} (${why})\n`];
    lines.push(`- **Intent:** ${note.notes.intent}\n`);
    if (note.notes.conflictGuidance) {
        lines.push(`- **If you conflict with this:** ${note.notes.conflictGuidance}\n`);
    }
    if (note.notes.touchedFiles.length) {
        lines.push(`- **Touched:** ${note.notes.touchedFiles.join(', ')}\n`);
    }
    if (note.notes.followUps?.length) {
        lines.push(`- **Left undone:** ${note.notes.followUps.join('; ')}\n`);
    }
    return lines.join('');
}

/**
 * Compose the dispatch body for a task: its own message plus any relevant
 * handoff notes.
 *
 * Returns the message UNCHANGED when nothing is relevant, so the ordinary case
 * is byte-identical to the pre-feature dispatch.
 */
export function composeTaskDispatchBody(
    message: string,
    input: HandoffRelevanceInput,
): { body: string; enclosedNotes: number; omittedNotes: number } {
    let selected: HandoffNoteCandidate[] = [];
    try {
        selected = selectRelevantHandoffNotes(input);
    } catch (e: any) {
        // Enclosure is an enhancement — it must never be the reason a dispatch
        // fails. A lookup error degrades to the plain message.
        LOG.warn('HandoffNotes', `Handoff selection failed for task ${input.taskId}: ${e?.message || e}`);
        return { body: message, enclosedNotes: 0, omittedNotes: 0 };
    }
    const block = renderHandoffNotesBlock(selected);
    if (!block) return { body: message, enclosedNotes: 0, omittedNotes: 0 };
    return {
        body: `${message}\n\n---\n\n${block.text}`,
        enclosedNotes: block.included,
        omittedNotes: block.omitted,
    };
}

// ─── Retention ──────────────────────────────────────────────────────────

/**
 * Drop handoff notes older than the retention window.
 *
 * ★Anchored on the note's own `recordedAt` rather than on a mission close
 * timestamp, and that is a deliberate simplification of §12-4's "mission close
 * + 30 days": `MeshMissionRecord` carries no `closedAt` field today, and adding
 * one would put a schema change on the critical path of a feature that does not
 * otherwise need it. Note age is a strictly MORE conservative anchor — a note
 * recorded during a mission is always at least as old as that mission's close —
 * so this can only expire a note later than the mission-anchored rule would,
 * never earlier. If a `closedAt` lands later, tighten this to use it.
 *
 * Returns the number of ledger rows removed, so the caller can log a count
 * rather than sweeping silently.
 */
export function pruneExpiredHandoffNotes(nowMs = Date.now()): number {
    const cutoffIso = new Date(nowMs - HANDOFF_RETENTION_MS).toISOString();
    let removed = 0;
    try {
        const store = MeshRuntimeStore.getInstance();
        removed = store.turnStore().deleteWorkerEventsOlderThan(WORKER_HANDOFF_EVENT_KIND, nowMs - HANDOFF_RETENTION_MS);
        // The text table shares the index row's retention anchor. Sweeping only
        // the index would leave orphan text rows accumulating forever.
        store.deleteHandoffNoteTextOlderThan(cutoffIso);
    } catch (e: any) {
        LOG.warn('HandoffNotes', `Handoff retention sweep failed: ${e?.message || e}`);
    }
    return removed;
}
