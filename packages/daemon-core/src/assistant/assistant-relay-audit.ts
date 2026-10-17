/**
 * List native coordinator finals for the relay's missing-reply detector.
 * Classification (no_attempt / inside_attempt / restart_closed) stays in
 * `AssistantRelay.tick` — this module only pairs bubbles with attempt windows.
 */
import type { Database } from 'better-sqlite3';
import type { AuditedCoordinatorReply } from './assistant-native-window.js';
import { readNativeWindow } from './attempt-report-recovery.js';
import { listMeshesReadOnly } from '../config/mesh-config.js';
import { listCoordinatorsForMesh } from '../mesh/coordinator-registry.js';
import { RELAY_QUIET_MS } from './assistant-relay-format.js';

type Execute = (command: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface AttemptSpan {
    attempt_id: string;
    accepted_at: number;
    terminal_at: number | null;
    terminal_reason: string | null;
    terminal_source: string | null;
    state: string;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const SESSION_CAP = 20;
export const RELAY_AUDIT_RETENTION_MS = 24 * 60 * 60_000;

function restartClosed(row: AttemptSpan): boolean {
    return row.terminal_reason === 'session_error' && row.terminal_source === 'session_registry';
}

export async function collectCoordinatorReplies(opts: {
    db: Database;
    execute: Execute;
    sinceMs: number;
    now: number;
    coordinatorSessions?: readonly { sessionId: string; cliType?: string }[];
}): Promise<AuditedCoordinatorReply[] & { complete?: boolean }> {
    // Replay bounded history, rather than discarding a bubble first observed
    // while open or before this process started. Delivery hashes deduplicate it.
    const since = opts.now - RELAY_AUDIT_RETENTION_MS;
    // Plain attempts are daemon-wide, including private owner chats. Only the
    // persisted coordinator registry authorizes a read; it also finds sessions
    // whose missing turn-start produced no attempt/relay row at all.
    const inventory = [...new Map((opts.coordinatorSessions ?? listMeshesReadOnly().flatMap(mesh => listCoordinatorsForMesh(mesh.id)))
        .map(entry => [entry.sessionId, entry] as const)).values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    // Rotate capped inventories so busy projects cannot starve another session.
    const first = inventory.length ? (Math.floor(opts.now / 60_000) * SESSION_CAP) % inventory.length : 0;
    const sessions = [...inventory.slice(first), ...inventory.slice(0, first)].slice(0, SESSION_CAP);
    const out: AuditedCoordinatorReply[] = [];
    const scans = await Promise.all(sessions.map(async ({ sessionId, cliType }) => {
        if (!sessionId) return { sessionId, skipped: true } as const;
        // These timestamps cannot classify attempt membership. Until Grok has a
        // native record boundary contract, no exact missing-attempt claim is made.
        if (cliType === 'grok-cli') return { sessionId, skipped: true } as const;
        const attempts = opts.db.prepare(`
            SELECT attempt_id, accepted_at, terminal_at, terminal_reason, terminal_source, state
            FROM turn_attempts WHERE session_id=? AND scope='plain'
        `).all(sessionId) as AttemptSpan[];
        const window = await readNativeWindow(opts.execute, sessionId, since, opts.now);
        return { sessionId, attempts, window };
    }));
    let complete = true;
    let successful = 0;
    for (const scan of scans) {
        if ('skipped' in scan) continue;
        const { sessionId, attempts, window } = scan;
        if (!window.complete || window.ambiguous) { complete = false; continue; }
        successful += 1;
        for (const bubble of window.bubbles) {
            const containing = attempts.filter((a) => bubble.at >= a.accepted_at && bubble.at <= (a.terminal_at ?? opts.now));
            containing.sort((a, b) => b.accepted_at - a.accepted_at);
            const attempt = containing[0];
            const open = !!attempt && (!TERMINAL.has(attempt.state)
                || attempt.terminal_at === null || opts.now < attempt.terminal_at + RELAY_QUIET_MS);
            out.push({
                sessionId,
                messageAt: bubble.at,
                chars: Array.from(bubble.text).length,
                text: bubble.text,
                attemptId: attempt?.attempt_id ?? null,
                ...(open ? { attemptOpen: true } : {}),
                ...(attempt && restartClosed(attempt) ? { restartClosed: true } : {}),
            });
        }
    }
    if (!complete && !successful) throw new Error('coordinator native audit unavailable');
    return complete ? out : Object.assign(out, { complete: false });
}
