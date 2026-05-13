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

import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getConfigDir } from '../config/config.js';
import { EventEmitter } from 'events';
// ─── Types ──────────────────────────────────────

export type MeshLedgerKind =
    | 'task_dispatched'
    | 'task_completed'
    | 'task_failed'
    | 'task_stalled'
    | 'task_approval_needed'
    | 'session_launched'
    | 'session_auto_launch'
    | 'session_stopped'
    | 'checkpoint_created'
    | 'node_cloned'
    | 'node_removed'
    | 'coordinator_started'
    | 'recovery_attempted'
    | 'ledger_replicated'
    | 'ledger_reconciled'
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
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const RECENT_FAILURE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
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

// ─── Core API ───────────────────────────────────

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

    // Rotate if file exceeds max size
    if (existsSync(filePath)) {
        try {
            const stat = statSync(filePath);
            if (stat.size >= MAX_FILE_SIZE_BYTES) {
                rotateLedgerFile(meshId, filePath);
            }
        } catch {
            // stat failed — proceed with append anyway
        }
    }

    try {
        const line = JSON.stringify(entry) + '\n';
        appendFileSync(filePath, line, { encoding: 'utf-8', mode: 0o600 });
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

    // Read existing to deduplicate by ID
    const existing = new Set(readLedgerEntries(meshId).map(e => e.id));
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

    try {
        const lines = validEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
        appendFileSync(ledgerPath, lines, { encoding: 'utf-8', mode: 0o600 });
        for (const entry of validEntries) {
            meshLedgerEvents.emit('append', meshId, entry);
        }
        return { accepted: validEntries.length, skippedDuplicate, rejectedInvalid, entries: validEntries };
    } catch (e: any) {
        throw new Error(`Failed to append remote ledger entries for mesh ${meshId}: ${e.message}`);
    }
}

/**
 * Read ledger entries with optional filtering.
 */
export function readLedgerEntries(meshId: string, opts?: ReadLedgerOptions): MeshLedgerEntry[] {
    const filePath = getLedgerPath(meshId);
    if (!existsSync(filePath)) return [];

    let content: string;
    try {
        content = readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }

    const lines = content.split('\n').filter(line => line.trim());
    let entries: MeshLedgerEntry[] = [];

    for (const line of lines) {
        try {
            const entry = JSON.parse(line) as MeshLedgerEntry;
            if (!entry.id || !entry.kind) continue;
            entries.push(entry);
        } catch {
            // Skip malformed lines
        }
    }

    // Apply filters
    if (opts?.since) {
        const sinceDate = new Date(opts.since).getTime();
        if (!isNaN(sinceDate)) {
            entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceDate);
        }
    }

    if (opts?.kind?.length) {
        const kindSet = new Set(opts.kind);
        entries = entries.filter(e => kindSet.has(e.kind));
    }

    // Apply tail (return last N entries)
    if (opts?.tail && opts.tail > 0 && entries.length > opts.tail) {
        entries = entries.slice(-opts.tail);
    }

    return entries;
}

/**
 * Read a bounded, cursor-addressable ledger slice for local-first/P2P replication.
 * The result is intentionally small and self-describing so coordinators can query
 * remote daemons on demand without Cloud/D1 becoming a ledger data-plane.
 */
export function readLedgerSlice(meshId: string, opts?: ReadLedgerSliceOptions): MeshLedgerSlice {
    const limit = clampLedgerSliceLimit(opts?.limit);
    let entries = readLedgerEntries(meshId, { since: opts?.since, kind: opts?.kind });
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
        summary: getLedgerSummary(meshId),
        sourceOfTruth: {
            kind: 'local_jsonl',
            path: getLedgerPath(meshId),
            bounded: true,
            maxLimit: MAX_LEDGER_SLICE_LIMIT,
        },
    };
}

/**
 * Get a summary of mesh activity from the ledger.
 */
export function getLedgerSummary(meshId: string): MeshLedgerSummary {
    const entries = readLedgerEntries(meshId);
    const now = Date.now();
    const recentFailureCutoff = now - RECENT_FAILURE_WINDOW_MS;

    const summary: MeshLedgerSummary = {
        meshId,
        totalEntries: entries.length,
        taskDispatched: 0,
        taskCompleted: 0,
        taskFailed: 0,
        taskStalled: 0,
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
                summary.taskFailed++;
                if (new Date(entry.timestamp).getTime() >= recentFailureCutoff) {
                    summary.recentFailures++;
                }
                break;
            }
            case 'task_stalled': summary.taskStalled++; break;
            case 'session_launched': summary.sessionLaunched++; break;
            case 'checkpoint_created': summary.checkpointCreated++; break;
        }
    }

    if (entries.length > 0) {
        summary.lastActivityAt = entries[entries.length - 1].timestamp;
    }

    return summary;
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
    const entries = readLedgerEntries(meshId);

    // Find the last task_dispatched for this session or node
    let lastDispatch: MeshLedgerEntry | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind !== 'task_dispatched') continue;
        if (opts.sessionId && e.sessionId === opts.sessionId) { lastDispatch = e; break; }
        if (opts.nodeId && e.nodeId === opts.nodeId) { lastDispatch = e; break; }
    }

    const lastTaskMessage = typeof lastDispatch?.payload?.message === 'string'
        ? lastDispatch.payload.message
        : null;

    // Count consecutive recent failures for this node (within 30 min window)
    const now = Date.now();
    const recentWindow = now - RECENT_FAILURE_WINDOW_MS;
    let consecutiveNodeFailures = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (new Date(e.timestamp).getTime() < recentWindow) break;
        if (opts.nodeId && e.nodeId !== opts.nodeId) continue;
        if (e.kind === 'task_failed') {
            consecutiveNodeFailures++;
        } else if (e.kind === 'task_completed' || e.kind === 'task_dispatched') {
            // A completion or new dispatch breaks the consecutive failure chain
            break;
        }
    }

    // Count how many times the same task was attempted (match by message prefix)
    let taskAttemptCount = 0;
    if (lastTaskMessage) {
        const prefix = lastTaskMessage.slice(0, 200);
        for (const e of entries) {
            if (e.kind === 'task_dispatched' && typeof e.payload?.message === 'string') {
                if (e.payload.message.startsWith(prefix)) {
                    taskAttemptCount++;
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
    } catch {
        // Rotation failed — the next append will just grow the file
    }
}
