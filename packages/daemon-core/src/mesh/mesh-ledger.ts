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

// ─── Constants ──────────────────────────────────

const LEDGER_DIR_NAME = 'mesh-ledger';
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const RECENT_FAILURE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

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

/**
 * Append entries received from the cloud to the local ledger.
 * This skips deduplicated entries and just writes new ones.
 */
export function appendRemoteLedgerEntries(meshId: string, entries: MeshLedgerEntry[]): void {
    if (entries.length === 0) return;
    const ledgerPath = getLedgerPath(meshId);

    // Read existing to deduplicate by ID
    const existing = new Set(readLedgerEntries(meshId).map(e => e.id));
    const newEntries = entries.filter(e => !existing.has(e.id));

    if (newEntries.length === 0) return;

    try {
        const lines = newEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
        appendFileSync(ledgerPath, lines, { encoding: 'utf-8', mode: 0o600 });
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
