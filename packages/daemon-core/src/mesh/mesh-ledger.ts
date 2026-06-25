/**
 * Mesh Task Ledger — GasTown-inspired append-only JSONL task history
 *
 * Records all mesh orchestration events (task dispatch, completion, failure,
 * checkpoint, node lifecycle) as an append-only JSONL file per mesh.
 *
 * Inspired by GasTown's "Beads" pattern: every action is a versioned record
 * that persists across agent sessions, enabling recovery, auditing, and
 * continuity when individual sessions fail or context windows are exhausted.
 *
 * Storage: ~/.adhdev/mesh-ledger/<meshId>.jsonl
 * Format:  One JSON object per line, newest entries appended at end
 * Safety:  mode 0o600, atomic append via appendFileSync
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getConfigDir } from '../config/config.js';
import { EventEmitter } from 'events';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
// ─── Types ──────────────────────────────────────

export type MeshLedgerKind =
    | 'task_dispatched'
    | 'task_completed'
    | 'task_failed'
    | 'task_stalled'
    | 'task_approval_needed'
    | 'p2p_dispatch_failed'
    | 'session_launched'
    | 'session_auto_launch'
    | 'session_stopped'
    | 'checkpoint_created'
    | 'node_cloned'
    | 'node_joined'
    | 'node_removed'
    | 'coordinator_started'
    | 'recovery_attempted'
    | 'ledger_replicated'
    | 'ledger_reconciled'
    | 'direct_fast_forward'
    | 'delivery_unroutable'
    | 'direct_dispatch_pruned'
    | 'event_held'
    | 'task_reclaimed'
    // Gap2-A: a coordinator-recorded operating note — a runtime-accumulated
    // lesson (provider quirk, pattern to avoid, recovery lesson) persisted in
    // the ledger so it survives coordinator restarts and is provider-neutral.
    // payload: { text, category?, createdAt?, sourceCoordinator? }
    | 'coordinator_operating_note'
    ;

export interface MeshLedgerEntry {
    id: string;
    meshId: string;
    timestamp: string;
    kind: MeshLedgerKind;
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    payload: Record<string, unknown>;
}

export function isIntentionalCleanupStopEntry(entry: Pick<MeshLedgerEntry, 'kind' | 'payload'>): boolean {
    if (entry.kind !== 'session_stopped' && entry.kind !== 'task_failed' && entry.kind !== 'task_stalled') return false;
    const payload = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
        ? entry.payload as Record<string, unknown>
        : {};
    return payload.intentional === true
        && (payload.reason === 'operator_cleanup'
            || payload.intentionalStopReason === 'operator_cleanup'
            || payload.source === 'mesh_cleanup_sessions'
            || payload.source === 'mesh_remove_node');
}

export type MeshWorkerResultStatus = 'completed' | 'failed' | 'blocked' | 'partial' | 'unknown';
export type MeshProcessArtifactKind = 'process' | 'log' | 'port' | 'window' | 'session' | 'file' | 'url' | 'other';

export interface MeshValidationResultArtifact {
    command?: string;
    status: 'passed' | 'failed' | 'skipped' | 'unknown';
    durationMs?: number;
    outputPath?: string;
    summary?: string;
}

export interface MeshProcessArtifact {
    kind: MeshProcessArtifactKind;
    id?: string;
    label?: string;
    locator?: string;
    pid?: number;
    port?: number;
    url?: string;
    path?: string;
    sessionId?: string;
    keepRunning?: boolean;
    metadata?: Record<string, unknown>;
}

export interface MeshWorkerResultArtifact {
    status: MeshWorkerResultStatus;
    classification?: string;
    changedFiles: string[];
    validationResults: MeshValidationResultArtifact[];
    gitStatus?: Record<string, unknown>;
    processArtifacts: MeshProcessArtifact[];
    errors: string[];
    nextAction?: string;
    requiresUserAction: boolean;
    source: 'explicit_metadata' | 'final_summary_json' | 'default';
}

export interface MeshTaskCompletionEvidence {
    source: 'agent_status_event';
    event: 'agent:generating_completed' | 'agent:ready';
    nodeId: string;
    sessionId: string;
    providerType?: string;
    completedAt: string;
    transcriptHandle: {
        kind: 'provider_session' | 'runtime_session';
        sessionId: string;
        providerSessionId?: string;
        finalSummaryAvailable: boolean;
    };
    workerResult: MeshWorkerResultArtifact;
    git: {
        status: 'deferred';
        reason: string;
    };
    validation: {
        status: 'deferred';
        commandsRun: string[];
        reason: string;
    };
    checkpoint: {
        attempted: false;
        reason: 'not_attempted_for_ordinary_completion';
    };
}

export interface BuildTaskCompletionEvidenceOptions {
    event: MeshTaskCompletionEvidence['event'];
    nodeId: string;
    sessionId: string;
    providerType?: string;
    providerSessionId?: string;
    finalSummary?: string;
    workerResult?: Record<string, unknown>;
    completedAt?: string;
}

export interface MeshLedgerSummary {
    meshId: string;
    totalEntries: number;
    taskDispatched: number;
    taskCompleted: number;
    taskFailed: number;
    taskStalled: number;
    sessionLaunched: number;
    checkpointCreated: number;
    lastActivityAt: string | null;
    recentFailures: number; // failures in last 30 minutes
}

export interface ReadLedgerOptions {
    tail?: number;
    since?: string;
    kind?: MeshLedgerKind[];
}

export interface ReadLedgerSliceOptions {
    /** Return entries strictly after this entry id. If not found, starts from the beginning of the filtered set. */
    afterId?: string;
    /** Return entries at or after this timestamp. */
    since?: string;
    /** Optional event kind filter. */
    kind?: MeshLedgerKind[];
    /** Maximum entries to return. Clamped to a bounded protocol maximum. */
    limit?: number;
}

export interface MeshLedgerCursor {
    afterId: string | null;
    nextAfterId: string | null;
    limit: number;
    hasMore: boolean;
}

export interface MeshLedgerSlice {
    protocol: 'adhdev.mesh.ledger.slice.v1';
    meshId: string;
    entries: MeshLedgerEntry[];
    cursor: MeshLedgerCursor;
    summary: MeshLedgerSummary;
    sourceOfTruth: {
        kind: 'local_jsonl';
        path: string;
        bounded: true;
        maxLimit: number;
    };
}

export interface AppendRemoteLedgerResult {
    accepted: number;
    skippedDuplicate: number;
    rejectedInvalid: number;
    entries: MeshLedgerEntry[];
}

// ─── Constants ──────────────────────────────────

const LEDGER_DIR_NAME = 'mesh-ledger';
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB — full rotation threshold
const COMPACT_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MB — compaction threshold
const ARCHIVE_TERMINAL_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RECENT_FAILURE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Kinds that accumulate indefinitely and are safe to archive after ARCHIVE_TERMINAL_OLDER_THAN_MS.
// Non-terminal kinds (dispatched, sessions, nodes, checkpoints) are always kept in the active file.
const ARCHIVABLE_KINDS: ReadonlySet<MeshLedgerKind> = new Set([
    'task_completed',
    'task_failed',
    'task_stalled',
    'recovery_attempted',
] as MeshLedgerKind[]);
const DEFAULT_LEDGER_SLICE_LIMIT = 100;
export const MAX_LEDGER_SLICE_LIMIT = 500;

// ─── Path Helpers ───────────────────────────────

export function getLedgerDir(): string {
    const dir = join(getConfigDir(), LEDGER_DIR_NAME);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
}

function getLedgerPath(meshId: string): string {
    // Sanitize meshId to prevent path traversal
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.jsonl`);
}

function getRotatedPath(meshId: string, index: number): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.${index}.jsonl`);
}

function getArchivePath(meshId: string): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.archive.jsonl`);
}

function getRotatedArchivePath(meshId: string, index: number): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.archive.${index}.jsonl`);
}

function getArchivedCountsPath(meshId: string): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.archived-counts.json`);
}

function rotateArchiveFile(meshId: string, archivePath: string): void {
    let index = 1;
    while (existsSync(getRotatedArchivePath(meshId, index))) {
        index++;
        if (index > 5) break;
    }
    if (index > 5) index = 5;
    try {
        renameSync(archivePath, getRotatedArchivePath(meshId, index));
    } catch (e: any) {
        process.stderr.write(`[adhdev-mesh] Archive rotation failed for mesh ${meshId}: ${e?.message || e}\n`);
    }
}

interface LedgerArchivedCounts {
    taskCompleted: number;
    taskFailed: number;
    taskStalled: number;
    recoveryAttempted: number;
    totalArchived: number;
    lastArchivedAt: string;
}

function readArchivedCounts(meshId: string): LedgerArchivedCounts {
    const path = getArchivedCountsPath(meshId);
    if (!existsSync(path)) return { taskCompleted: 0, taskFailed: 0, taskStalled: 0, recoveryAttempted: 0, totalArchived: 0, lastArchivedAt: '' };
    try { return JSON.parse(readFileSync(path, 'utf-8')) as LedgerArchivedCounts; } catch { return { taskCompleted: 0, taskFailed: 0, taskStalled: 0, recoveryAttempted: 0, totalArchived: 0, lastArchivedAt: '' }; }
}

function updateArchivedCounts(meshId: string, archived: MeshLedgerEntry[]): void {
    const counts = readArchivedCounts(meshId);
    for (const e of archived) {
        if (e.kind === 'task_completed') counts.taskCompleted++;
        else if (e.kind === 'task_failed') counts.taskFailed++;
        else if (e.kind === 'task_stalled') counts.taskStalled++;
        else if (e.kind === 'recovery_attempted') counts.recoveryAttempted++;
    }
    counts.totalArchived += archived.length;
    counts.lastArchivedAt = new Date().toISOString();
    try { writeFileSync(getArchivedCountsPath(meshId), JSON.stringify(counts), { encoding: 'utf-8', mode: 0o600 }); } catch { /* best-effort */ }
}

// ─── Worker Result Footer ───────────────────────

/**
 * Footer to append to worker task messages so workers output structured results
 * that the daemon parses via extractJsonObjectFromSummary / normalizeMeshWorkerResult.
 *
 * Usage: append buildWorkerTaskFooter() to the task message in mesh_send_task /
 * mesh_enqueue_task. The coordinator prompt rules instruct coordinators to do this.
 */
export function buildWorkerTaskFooter(): string {
    return `

---
When your task is done, end your final response with a JSON code block in this exact format (omit fields that don't apply):
\`\`\`json
{
  "status": "completed",
  "changedFiles": ["src/foo.ts", "tests/foo.test.ts"],
  "gitStatus": { "branch": "feat/your-branch", "committed": true, "pushed": false },
  "validationResults": [{ "command": "npm test", "status": "passed" }],
  "errors": [],
  "nextAction": "optional guidance for the coordinator"
}
\`\`\`
Valid status values: \`completed\` | \`failed\` | \`blocked\` | \`partial\`.`;
}

// ─── Ledger Compaction ──────────────────────────

/**
 * Compact the active ledger file for a mesh by moving old terminal entries
 * (task_completed, task_failed, task_stalled, recovery_attempted older than 7 days)
 * to <meshId>.archive.jsonl, keeping the active file lean.
 *
 * Non-terminal entries (dispatch, sessions, node lifecycle) are always retained.
 * Called automatically from appendLedgerEntry when the file exceeds COMPACT_THRESHOLD_BYTES.
 */
export function compactLedger(meshId: string): { archivedCount: number; retainedCount: number } {
    const filePath = getLedgerPath(meshId);
    if (!existsSync(filePath)) return { archivedCount: 0, retainedCount: 0 };

    const cutoff = Date.now() - ARCHIVE_TERMINAL_OLDER_THAN_MS;
    const entries = readLedgerEntries(meshId);

    const keep: MeshLedgerEntry[] = [];
    const archive: MeshLedgerEntry[] = [];
    for (const entry of entries) {
        if (ARCHIVABLE_KINDS.has(entry.kind) && new Date(entry.timestamp).getTime() < cutoff) {
            archive.push(entry);
        } else {
            keep.push(entry);
        }
    }

    if (archive.length === 0) return { archivedCount: 0, retainedCount: keep.length };

    // Append archived entries to the archive file, rotate if it exceeds 50MB
    const archivePath = getArchivePath(meshId);
    try {
        if (existsSync(archivePath) && statSync(archivePath).size > 50 * 1024 * 1024) {
            rotateArchiveFile(meshId, archivePath);
        }
        const archiveLines = archive.map(e => JSON.stringify(e)).join('\n') + '\n';
        appendFileSync(archivePath, archiveLines, { encoding: 'utf-8', mode: 0o600 });
        updateArchivedCounts(meshId, archive);
    } catch (e: any) {
        process.stderr.write(`[adhdev-mesh] Ledger archive write failed for mesh ${meshId}: ${e?.message || e}\n`);
        return { archivedCount: 0, retainedCount: entries.length };
    }

    // Rewrite active file with retained entries only
    try {
        const keepLines = keep.length ? keep.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
        writeFileSync(filePath, keepLines, { encoding: 'utf-8', mode: 0o600 });
        invalidateLedgerCache(meshId);
    } catch (e: any) {
        process.stderr.write(`[adhdev-mesh] Ledger compaction rewrite failed for mesh ${meshId}: ${e?.message || e}\n`);
        return { archivedCount: archive.length, retainedCount: keep.length };
    }

    // G2: mirror the compaction in SQLite so the runtime store matches the active
    // ledger set. Archived entries live on in the JSONL archive files (export/debug).
    try {
        MeshRuntimeStore.getInstance().deleteLedgerEntries(meshId, archive.map(e => e.id));
        invalidateLedgerCache(meshId);
    } catch { /* best-effort; summary counts absorb the difference via archived counts */ }

    return { archivedCount: archive.length, retainedCount: keep.length };
}

// ─── Core API ───────────────────────────────────

function readNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => readNonEmptyString(item)).filter(Boolean) as string[];
}

function extractJsonObjectFromSummary(summary?: string): Record<string, unknown> | undefined {
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

function normalizeValidationResults(value: unknown): MeshValidationResultArtifact[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map((item: any) => {
            const status = ['passed', 'failed', 'skipped', 'unknown'].includes(item.status) ? item.status : 'unknown';
            return {
                ...(readNonEmptyString(item.command) ? { command: readNonEmptyString(item.command) } : {}),
                status,
                ...(Number.isFinite(Number(item.durationMs)) ? { durationMs: Number(item.durationMs) } : {}),
                ...(readNonEmptyString(item.outputPath) ? { outputPath: readNonEmptyString(item.outputPath) } : {}),
                ...(readNonEmptyString(item.summary) ? { summary: readNonEmptyString(item.summary) } : {}),
            };
        });
}

function normalizeProcessArtifacts(value: unknown): MeshProcessArtifact[] {
    if (!Array.isArray(value)) return [];
    const kinds = new Set(['process', 'log', 'port', 'window', 'session', 'file', 'url', 'other']);
    return value
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map((item: any) => ({
            kind: kinds.has(item.kind) ? item.kind : 'other',
            ...(readNonEmptyString(item.id) ? { id: readNonEmptyString(item.id) } : {}),
            ...(readNonEmptyString(item.label) ? { label: readNonEmptyString(item.label) } : {}),
            ...(readNonEmptyString(item.locator) ? { locator: readNonEmptyString(item.locator) } : {}),
            ...(Number.isFinite(Number(item.pid)) ? { pid: Number(item.pid) } : {}),
            ...(Number.isFinite(Number(item.port)) ? { port: Number(item.port) } : {}),
            ...(readNonEmptyString(item.url) ? { url: readNonEmptyString(item.url) } : {}),
            ...(readNonEmptyString(item.path) ? { path: readNonEmptyString(item.path) } : {}),
            ...(readNonEmptyString(item.sessionId) ? { sessionId: readNonEmptyString(item.sessionId) } : {}),
            ...(typeof item.keepRunning === 'boolean' ? { keepRunning: item.keepRunning } : {}),
            ...(item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? { metadata: item.metadata as Record<string, unknown> } : {}),
        }));
}

export function normalizeMeshWorkerResult(input?: Record<string, unknown>, source: MeshWorkerResultArtifact['source'] = 'explicit_metadata'): MeshWorkerResultArtifact {
    const raw = input && typeof input === 'object' ? input : {};
    const status = ['completed', 'failed', 'blocked', 'partial', 'unknown'].includes(String(raw.status))
        ? raw.status as MeshWorkerResultStatus
        : 'unknown';
    const gitStatus = raw.gitStatus && typeof raw.gitStatus === 'object' && !Array.isArray(raw.gitStatus)
        ? raw.gitStatus as Record<string, unknown>
        : undefined;
    return {
        status,
        ...(readNonEmptyString(raw.classification) ? { classification: readNonEmptyString(raw.classification) } : {}),
        changedFiles: readStringArray(raw.changedFiles),
        validationResults: normalizeValidationResults(raw.validationResults),
        ...(gitStatus ? { gitStatus } : {}),
        processArtifacts: normalizeProcessArtifacts(raw.processArtifacts),
        errors: readStringArray(raw.errors),
        ...(readNonEmptyString(raw.nextAction) ? { nextAction: readNonEmptyString(raw.nextAction) } : {}),
        requiresUserAction: raw.requiresUserAction === true,
        source,
    };
}

function resolveWorkerResult(opts: BuildTaskCompletionEvidenceOptions): MeshWorkerResultArtifact {
    if (opts.workerResult && typeof opts.workerResult === 'object') {
        return normalizeMeshWorkerResult(opts.workerResult, 'explicit_metadata');
    }
    const parsed = extractJsonObjectFromSummary(opts.finalSummary);
    if (parsed) {
        return normalizeMeshWorkerResult(parsed, 'final_summary_json');
    }
    return normalizeMeshWorkerResult(undefined, 'default');
}

export function buildTaskCompletionEvidence(opts: BuildTaskCompletionEvidenceOptions): MeshTaskCompletionEvidence {
    const providerSessionId = opts.providerSessionId?.trim() || undefined;
    const providerType = opts.providerType?.trim() || undefined;
    return {
        source: 'agent_status_event',
        event: opts.event,
        nodeId: opts.nodeId,
        sessionId: opts.sessionId,
        providerType,
        completedAt: opts.completedAt || new Date().toISOString(),
        transcriptHandle: {
            kind: providerSessionId ? 'provider_session' : 'runtime_session',
            sessionId: opts.sessionId,
            providerSessionId,
            finalSummaryAvailable: typeof opts.finalSummary === 'string' && opts.finalSummary.trim().length > 0,
        },
        workerResult: resolveWorkerResult(opts),
        git: {
            status: 'deferred',
            reason: 'ordinary_completion_git_status_not_checked',
        },
        validation: {
            status: 'deferred',
            commandsRun: [],
            reason: 'ordinary_completion_validation_not_run',
        },
        checkpoint: {
            attempted: false,
            reason: 'not_attempted_for_ordinary_completion',
        },
    };
}

/**
 * Append a new entry to the mesh ledger.
 * Handles file creation, rotation on size overflow, and atomic writes.
 */
export const meshLedgerEvents = new EventEmitter();

export function appendLedgerEntry(
    meshId: string,
    partial: Omit<MeshLedgerEntry, 'id' | 'meshId' | 'timestamp'>,
): MeshLedgerEntry {
    const entry: MeshLedgerEntry = {
        id: randomUUID(),
        meshId,
        timestamp: new Date().toISOString(),
        ...partial,
    };

    const filePath = getLedgerPath(meshId);

    // Compact or rotate based on file size
    if (existsSync(filePath)) {
        try {
            const stat = statSync(filePath);
            if (stat.size >= MAX_FILE_SIZE_BYTES) {
                rotateLedgerFile(meshId, filePath);
            } else if (stat.size >= COMPACT_THRESHOLD_BYTES) {
                compactLedger(meshId);
            }
        } catch {
            // stat failed — proceed with append anyway
        }
    }

    // Write to SQLite (G2: primary runtime read/write path)
    try {
        MeshRuntimeStore.getInstance().appendLedgerEntry({
            id: entry.id,
            meshId: entry.meshId,
            timestamp: entry.timestamp,
            kind: entry.kind,
            nodeId: entry.nodeId ?? null,
            sessionId: entry.sessionId ?? null,
            providerType: entry.providerType ?? null,
            payload: entry.payload,
        });
    } catch {
        // SQLite write failed but the JSONL append below still records the entry.
        // Reset the one-time import flag so the next read re-imports from JSONL
        // and the store self-heals instead of silently missing this entry.
        ledgerImportDone.delete(meshId);
    }

    // Also write to JSONL (retained as export/import/debug/legacy artifact)
    try {
        const line = JSON.stringify(entry) + '\n';
        appendFileSync(filePath, line, { encoding: 'utf-8', mode: 0o600 });
        invalidateLedgerCache(meshId);
        meshLedgerEvents.emit('append', meshId, entry);
        return entry;
    } catch (e: any) {
        throw new Error(`Failed to append to ledger for mesh ${meshId}: ${e.message}`);
    }
}

function clampLedgerSliceLimit(limit: unknown): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LEDGER_SLICE_LIMIT;
    return Math.max(1, Math.min(MAX_LEDGER_SLICE_LIMIT, Math.floor(limit)));
}

function isValidRemoteLedgerEntry(meshId: string, value: unknown): value is MeshLedgerEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entry = value as Partial<MeshLedgerEntry>;
    if (typeof entry.id !== 'string' || !entry.id.trim()) return false;
    if (entry.meshId !== meshId) return false;
    if (typeof entry.timestamp !== 'string' || Number.isNaN(new Date(entry.timestamp).getTime())) return false;
    if (typeof entry.kind !== 'string' || !entry.kind.trim()) return false;
    if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) return false;
    return true;
}

/**
 * Append entries received over local-first/P2P ledger replication to the local ledger.
 * This skips deduplicated entries and rejects malformed/cross-mesh entries.
 */
export function appendRemoteLedgerEntries(meshId: string, entries: MeshLedgerEntry[]): AppendRemoteLedgerResult {
    if (entries.length === 0) return { accepted: 0, skippedDuplicate: 0, rejectedInvalid: 0, entries: [] };
    const ledgerPath = getLedgerPath(meshId);

    // Dedup against recent entries only — P2P replication is incremental (cursor-based),
    // so duplicates appear in the recent tail, not deep history.
    const existing = new Set(readLedgerEntries(meshId, { tail: 1000 }).map(e => e.id));
    const validEntries: MeshLedgerEntry[] = [];
    let rejectedInvalid = 0;
    let skippedDuplicate = 0;
    for (const entry of entries) {
        if (!isValidRemoteLedgerEntry(meshId, entry)) {
            rejectedInvalid++;
            continue;
        }
        if (existing.has(entry.id)) {
            skippedDuplicate++;
            continue;
        }
        existing.add(entry.id);
        validEntries.push(entry);
    }

    if (validEntries.length === 0) {
        return { accepted: 0, skippedDuplicate, rejectedInvalid, entries: [] };
    }

    // G2: write to SQLite (primary runtime store); INSERT OR IGNORE dedups by id.
    try {
        MeshRuntimeStore.getInstance().importLedgerEntries(validEntries.map(e => ({
            id: e.id,
            meshId: e.meshId,
            timestamp: e.timestamp,
            kind: e.kind,
            nodeId: e.nodeId ?? null,
            sessionId: e.sessionId ?? null,
            providerType: e.providerType ?? null,
            payload: e.payload ?? {},
        })));
    } catch { /* best-effort; JSONL append below still records the entries */ }

    try {
        const lines = validEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
        appendFileSync(ledgerPath, lines, { encoding: 'utf-8', mode: 0o600 });
        invalidateLedgerCache(meshId);
        for (const entry of validEntries) {
            meshLedgerEvents.emit('append', meshId, entry);
        }
        return { accepted: validEntries.length, skippedDuplicate, rejectedInvalid, entries: validEntries };
    } catch (e: any) {
        throw new Error(`Failed to append remote ledger entries for mesh ${meshId}: ${e.message}`);
    }
}

// ─── Ledger Read Cache ─────────────────────────
// Absorbs repeated reads within a single event-processing burst (e.g. agent:stopped
// triggers shouldSuppressIntentionalCleanupStop, findRecentTerminalLedgerEvidence,
// hasDispatchAfterTerminal, and getSessionRecoveryContext — all reading the same store).
// TTL is 100ms: short enough to stay current, long enough to cover one event cycle.
// Cache is invalidated on every write (append, remote import, compaction).

const ledgerReadCache = new Map<string, { entries: MeshLedgerEntry[]; cachedAt: number }>();
const LEDGER_CACHE_TTL_MS = 100;

function readLedgerFile(meshId: string): MeshLedgerEntry[] {
    const filePath = getLedgerPath(meshId);
    if (!existsSync(filePath)) return [];
    let content: string;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return []; }
    const entries: MeshLedgerEntry[] = [];
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line) as MeshLedgerEntry;
            if (entry.id && entry.kind) entries.push(entry);
        } catch { /* skip malformed lines */ }
    }
    return entries;
}

// ─── G2: One-Time JSONL → SQLite Import ─────────
// On the first SQLite read for a mesh (per store instance), import any legacy
// JSONL entries into mesh_event_ledger. INSERT OR IGNORE makes this idempotent:
// dual-written entries are skipped, only pre-cutover legacy entries are added.
// Keyed by the store instance so MeshRuntimeStore.resetForTests() (fresh DB)
// naturally re-imports.

let ledgerImportStoreRef: MeshRuntimeStore | undefined;
const ledgerImportDone = new Set<string>();

function ensureLedgerImported(store: MeshRuntimeStore, meshId: string): void {
    if (ledgerImportStoreRef !== store) {
        ledgerImportDone.clear();
        ledgerImportStoreRef = store;
    }
    if (ledgerImportDone.has(meshId)) return;
    ledgerImportDone.add(meshId);
    const fileEntries = readLedgerFile(meshId);
    if (fileEntries.length === 0) return;
    try {
        store.importLedgerEntries(fileEntries.map(e => ({
            id: e.id,
            meshId: e.meshId,
            timestamp: e.timestamp,
            kind: e.kind,
            nodeId: e.nodeId ?? null,
            sessionId: e.sessionId ?? null,
            providerType: e.providerType ?? null,
            payload: e.payload ?? {},
        })));
    } catch { /* import is best-effort; reads fall back to JSONL on store failure */ }
}

function readLedgerFromStore(meshId: string): MeshLedgerEntry[] {
    const store = MeshRuntimeStore.getInstance();
    ensureLedgerImported(store, meshId);
    return store.readLedgerEntriesOrdered(meshId).map(r => ({
        id: r.id,
        meshId: r.meshId,
        timestamp: r.timestamp,
        kind: r.kind as MeshLedgerKind,
        ...(r.nodeId ? { nodeId: r.nodeId } : {}),
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        ...(r.providerType ? { providerType: r.providerType } : {}),
        payload: (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, unknown>,
    }));
}

function getCachedRawEntries(meshId: string): MeshLedgerEntry[] {
    const now = Date.now();
    const cached = ledgerReadCache.get(meshId);
    if (cached && now - cached.cachedAt < LEDGER_CACHE_TTL_MS) return cached.entries;
    let entries: MeshLedgerEntry[];
    try {
        // G2: SQLite mesh_event_ledger is the primary runtime read path.
        entries = readLedgerFromStore(meshId);
    } catch {
        // Store unavailable — fall back to the JSONL export artifact.
        entries = readLedgerFile(meshId);
    }
    ledgerReadCache.set(meshId, { entries, cachedAt: now });
    return entries;
}

function invalidateLedgerCache(meshId: string): void {
    ledgerReadCache.delete(meshId);
}

/**
 * Test helper: clear all runtime ledger state for a mesh — SQLite rows, read
 * cache, and the one-time import flag. JSONL files are the caller's concern.
 */
export function __clearMeshLedgerForTests(meshId: string): void {
    try {
        MeshRuntimeStore.getInstance().clearLedgerForMesh(meshId);
    } catch { /* store unavailable — nothing to clear */ }
    ledgerReadCache.delete(meshId);
    ledgerImportDone.delete(meshId);
}

/**
 * Read ledger entries with optional filtering.
 * G2: SQLite (mesh_event_ledger) is the primary read path; legacy JSONL is
 * imported once per store instance and otherwise retained as an
 * export/import/debug artifact only.
 */
export function readLedgerEntries(meshId: string, opts?: ReadLedgerOptions): MeshLedgerEntry[] {
    let entries = getCachedRawEntries(meshId);

    if (opts?.since) {
        const sinceDate = new Date(opts.since).getTime();
        if (!isNaN(sinceDate)) entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceDate);
    }
    if (opts?.kind?.length) {
        const kindSet = new Set(opts.kind);
        entries = entries.filter(e => kindSet.has(e.kind));
    }
    if (opts?.tail && opts.tail > 0 && entries.length > opts.tail) {
        entries = entries.slice(-opts.tail);
    }
    return entries;
}

/**
 * Build a ledger summary from pre-loaded entries. Used by both getLedgerSummary
 * and readLedgerSlice so they share a single getCachedRawEntries() call.
 */
function buildLedgerSummary(meshId: string, entries: MeshLedgerEntry[]): MeshLedgerSummary {
    const archived = readArchivedCounts(meshId);
    const now = Date.now();
    const recentFailureCutoff = now - RECENT_FAILURE_WINDOW_MS;

    const summary: MeshLedgerSummary = {
        meshId,
        totalEntries: entries.length + archived.totalArchived,
        taskDispatched: 0,
        taskCompleted: archived.taskCompleted,
        taskFailed: archived.taskFailed,
        taskStalled: archived.taskStalled,
        sessionLaunched: 0,
        checkpointCreated: 0,
        lastActivityAt: null,
        recentFailures: 0,
    };

    for (const entry of entries) {
        switch (entry.kind) {
            case 'task_dispatched': summary.taskDispatched++; break;
            case 'task_completed': summary.taskCompleted++; break;
            case 'task_failed': {
                if (isIntentionalCleanupStopEntry(entry)) break;
                summary.taskFailed++;
                if (new Date(entry.timestamp).getTime() >= recentFailureCutoff) {
                    summary.recentFailures++;
                }
                break;
            }
            case 'task_stalled': {
                if (!isIntentionalCleanupStopEntry(entry)) summary.taskStalled++;
                break;
            }
            case 'session_launched': summary.sessionLaunched++; break;
            case 'checkpoint_created': summary.checkpointCreated++; break;
        }
    }

    if (entries.length > 0) {
        summary.lastActivityAt = entries[entries.length - 1].timestamp;
    }

    return summary;
}

/**
 * Read a bounded, cursor-addressable ledger slice for local-first/P2P replication.
 * The result is intentionally small and self-describing so coordinators can query
 * remote daemons on demand without Cloud/D1 becoming a ledger data-plane.
 */
export function readLedgerSlice(meshId: string, opts?: ReadLedgerSliceOptions): MeshLedgerSlice {
    const limit = clampLedgerSliceLimit(opts?.limit);
    // Load raw entries once and share between filtering, pagination, and summary.
    const rawEntries = getCachedRawEntries(meshId);

    let entries: MeshLedgerEntry[] = rawEntries;
    if (opts?.since) {
        const sinceDate = new Date(opts.since).getTime();
        if (!isNaN(sinceDate)) entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceDate);
    }
    if (opts?.kind?.length) {
        const kindSet = new Set(opts.kind);
        entries = entries.filter(e => kindSet.has(e.kind));
    }

    const afterId = typeof opts?.afterId === 'string' && opts.afterId.trim() ? opts.afterId.trim() : null;
    if (afterId) {
        const index = entries.findIndex(entry => entry.id === afterId);
        entries = index >= 0 ? entries.slice(index + 1) : entries;
    }
    const bounded = entries.slice(0, limit);
    return {
        protocol: 'adhdev.mesh.ledger.slice.v1',
        meshId,
        entries: bounded,
        cursor: {
            afterId,
            nextAfterId: bounded.length ? bounded[bounded.length - 1].id : afterId,
            limit,
            hasMore: entries.length > bounded.length,
        },
        summary: buildLedgerSummary(meshId, rawEntries),
        sourceOfTruth: {
            kind: 'local_jsonl',
            path: getLedgerPath(meshId),
            bounded: true,
            maxLimit: MAX_LEDGER_SLICE_LIMIT,
        },
    };
}

/**
 * G4: Read a bounded ledger slice from the SQLite mesh_event_ledger table.
 * This is the preferred P2P reconcile read path; JSONL files are retained as
 * export/import/debug/legacy artifacts only.
 *
 * Returns a shape structurally compatible with MeshLedgerSlice (minus the
 * JSONL-specific `summary` and `sourceOfTruth.path` fields) so callers can
 * pass it to buildMeshLedgerReplicaEvidence without modification.
 */
export function readLedgerSliceFromStore(meshId: string, opts?: ReadLedgerSliceOptions): ReturnType<typeof MeshRuntimeStore.prototype.readLedgerSlice> {
    return MeshRuntimeStore.getInstance().readLedgerSlice(meshId, {
        afterId: opts?.afterId,
        since: opts?.since,
        // ReadLedgerSliceOptions allows kind as array; SQLite path takes a single kind string.
        // Pass first kind value if provided; callers needing multi-kind filtering should use readLedgerSlice (JSONL).
        kind: opts?.kind?.length ? opts.kind[0] : undefined,
        limit: opts?.limit,
    });
}

/**
 * Get a summary of mesh activity from the ledger.
 */
export function getLedgerSummary(meshId: string): MeshLedgerSummary {
    return buildLedgerSummary(meshId, getCachedRawEntries(meshId));
}

// ─── Recovery Context ───────────────────────────

export interface SessionRecoveryContext {
    /** The original task message that was dispatched to this session/node */
    lastTaskMessage: string | null;
    /** The node that was running the failed task */
    failedNodeId: string | null;
    /** Session ID of the failed session */
    failedSessionId: string | null;
    /** Provider used for the failed session */
    failedProviderType: string | null;
    /** Number of consecutive failures for this node (within recent window) */
    consecutiveNodeFailures: number;
    /** Number of times this specific task was attempted (matched by truncated message prefix) */
    taskAttemptCount: number;
    /** Whether a retry is recommended based on maxRetries policy */
    retryRecommended: boolean;
    /** Human-readable recovery advice for the coordinator */
    advice: string;
}

/**
 * Build recovery context for a failed session.
 * Looks up the ledger to find the original task, count failures, and advise on retry.
 */
export function getSessionRecoveryContext(
    meshId: string,
    opts: {
        sessionId?: string;
        nodeId?: string;
        maxRetries?: number;
    },
): SessionRecoveryContext {
    const maxRetries = opts.maxRetries ?? 1;
    // tail:500 is sufficient — task_dispatched is never archived (only terminal kinds are),
    // so dispatch history is always present. The 30-min failure window means we never need
    // more than a few dozen recent entries for consecutiveNodeFailures. Bounding to 500
    // avoids a full O(n) scan for meshes with many historical entries.
    const entries = readLedgerEntries(meshId, { tail: 500 });

    // Single backward pass: find last task_dispatched AND count consecutive recent failures.
    const now = Date.now();
    const recentWindow = now - RECENT_FAILURE_WINDOW_MS;
    let lastDispatch: MeshLedgerEntry | null = null;
    let consecutiveNodeFailures = 0;
    let failureCountDone = false;
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const ts = new Date(e.timestamp).getTime();

        // Failure counting: scan until we exit the recent window or hit a chain-breaker
        if (!failureCountDone) {
            if (ts < recentWindow) {
                failureCountDone = true;
            } else if (opts.nodeId && e.nodeId !== opts.nodeId) {
                // Entry for a different node — skip for failure counting but continue scanning for dispatch
            } else if (e.kind === 'task_failed') {
                if (!isIntentionalCleanupStopEntry(e)) consecutiveNodeFailures++;
            } else if (e.kind === 'task_completed' || e.kind === 'task_dispatched') {
                // A completion or new dispatch breaks the consecutive failure chain
                failureCountDone = true;
            }
        }

        // Dispatch search: find the last dispatch matching this session or node
        if (lastDispatch === null && e.kind === 'task_dispatched') {
            if (opts.sessionId && e.sessionId === opts.sessionId) { lastDispatch = e; }
            else if (!opts.sessionId && opts.nodeId && e.nodeId === opts.nodeId) { lastDispatch = e; }
        }

        // Stop once both tasks are done
        if (lastDispatch !== null && failureCountDone) break;
    }

    const lastTaskMessage = typeof lastDispatch?.payload?.message === 'string'
        ? lastDispatch.payload.message
        : null;

    // Count how many times the same task was attempted.
    // Prefer exact taskId match (payload.taskId) to avoid 200-char prefix collisions.
    let taskAttemptCount = 0;
    if (lastDispatch) {
        const taskId = typeof lastDispatch.payload?.taskId === 'string' ? lastDispatch.payload.taskId : null;
        if (taskId) {
            for (const e of entries) {
                if (e.kind === 'task_dispatched' && e.payload?.taskId === taskId) taskAttemptCount++;
            }
        } else if (lastTaskMessage) {
            const prefix = lastTaskMessage.slice(0, 200);
            for (const e of entries) {
                if (e.kind === 'task_dispatched' && typeof e.payload?.message === 'string') {
                    if (e.payload.message.startsWith(prefix)) taskAttemptCount++;
                }
            }
        }
    }

    const retryRecommended = consecutiveNodeFailures <= maxRetries;

    // Build advice string
    let advice: string;
    if (consecutiveNodeFailures === 0) {
        advice = 'No recent failures detected. This may be a normal stop.';
    } else if (retryRecommended) {
        const remaining = maxRetries - consecutiveNodeFailures + 1;
        advice = `Retry recommended (${consecutiveNodeFailures}/${maxRetries + 1} attempts used, ${remaining} remaining). `
            + (lastTaskMessage
                ? `Re-launch the session and resend the original task.`
                : `Re-launch the session. Original task message not found in ledger.`);
    } else {
        advice = `Max retries exceeded (${consecutiveNodeFailures} consecutive failures). `
            + `Consider: (1) reassigning to a different node, (2) simplifying the task, or (3) escalating to the user.`;
    }

    return {
        lastTaskMessage,
        failedNodeId: opts.nodeId || null,
        failedSessionId: opts.sessionId || null,
        failedProviderType: null, // filled by caller if available
        consecutiveNodeFailures,
        taskAttemptCount,
        retryRecommended,
        advice,
    };
}

// ─── File Rotation ──────────────────────────────

function rotateLedgerFile(meshId: string, currentPath: string): void {
    // Find next rotation index
    let index = 1;
    while (existsSync(getRotatedPath(meshId, index))) {
        index++;
        if (index > 10) break; // Max 10 rotations
    }

    // If all slots full, overwrite the oldest
    if (index > 10) index = 10;

    try {
        renameSync(currentPath, getRotatedPath(meshId, index));
    } catch (e: any) {
        // Rotation failed — the next append will just grow the file
        process.stderr.write(`[adhdev-mesh] Ledger rotation failed for mesh ${meshId}: ${e?.message || e}. File will continue to grow.\n`);
    }
}
