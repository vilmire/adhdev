import { NativeScanCheckpoints } from './native-scan-checkpoint.js';
import { createHash } from 'node:crypto';
import { renderNativeReplies } from './assistant-native-window.js';
import { reportBodyId } from './report-continuation.js';
/**
 * List native coordinator finals for the relay's missing-reply detector.
 * Classification (no_attempt / inside_attempt / restart_closed) stays in
 * `AssistantRelay.tick` — this module only pairs bubbles with attempt windows.
 */
import type { Database } from 'better-sqlite3';
import type { AuditedCoordinatorReply } from './assistant-native-window.js';
import { isTimestampedNativeProvider, readNativeWindow } from './attempt-report-recovery.js';
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
    generation: number;
    relayed_at: number | null;
    coverage_at: number | null;
}

const TERMINAL = new Set(['completed', 'blocked', 'failed', 'cancelled']);
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
    isAuthorized?: (meshId: string | undefined, sessionId: string) => boolean;
    coordinatorSessions?: readonly { sessionId: string; cliType?: string; meshId?: string }[];
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
    const checkpoints = new NativeScanCheckpoints(opts.db);
    const scans = await Promise.all(sessions.map(async ({ sessionId, cliType, meshId }) => {
        if (opts.isAuthorized?.(meshId, sessionId) === false) return { sessionId, skipped: true } as const;
        if (!sessionId) return { sessionId, skipped: true } as const;
        // Providers outside TIMESTAMPED_PROVIDERS have no wall-clock native
        // record boundary contract; skip them instead of failing native audit.
        if (cliType && !isTimestampedNativeProvider(cliType)) return { sessionId, skipped: true } as const;
        const attempts = opts.db.prepare(`
            SELECT a.attempt_id, a.accepted_at, a.terminal_at, a.terminal_reason, a.terminal_source, a.state, a.generation,
                r.relayed_at, c.rendered_at AS coverage_at
            FROM turn_attempts a
            LEFT JOIN assistant_relays r ON r.attempt_id=a.attempt_id AND r.coordinator_session_id=a.session_id
            LEFT JOIN assistant_relay_coverage c ON c.attempt_id=a.attempt_id AND c.coordinator_session_id=a.session_id
            WHERE a.session_id=? AND a.scope='plain'
        `).all(sessionId) as AttemptSpan[];
        const anchor = () => opts.db.prepare("SELECT attempt_id,generation,accepted_at FROM turn_attempts WHERE session_id=? AND scope='plain' ORDER BY accepted_at,attempt_id").all(sessionId);
        const scope = JSON.stringify([meshId, cliType, createHash('sha256').update(JSON.stringify(anchor())).digest('hex')]);
        const window = await readNativeWindow(opts.execute, sessionId, since, opts.now, { checkpoints, scope });
        const currentScope = JSON.stringify([meshId, cliType, createHash('sha256').update(JSON.stringify(anchor())).digest('hex')]);
        if (opts.isAuthorized?.(meshId, sessionId) === false || scope !== currentScope) { checkpoints.reset(sessionId); return { sessionId, skipped: true } as const; }
        if (window.unsupportedProvider) return { sessionId, skipped: true } as const;
        return { sessionId, meshId, attempts, window };
    }));
    let complete = true;
    let successful = 0;
    let failed = false;
    for (const scan of scans) {
        if ('skipped' in scan) { complete = false; continue; }
        const { sessionId, meshId, attempts, window } = scan;
        if (window.ambiguous || (!window.complete && !window.closedTurns.size)) { complete = false; failed = true; continue; }
        if (!window.complete) complete = false;
        successful += 1;
        const reportIds = new Map<string, string>();
        for (const bubble of window.bubbles) {
            const messageId = window.targets.get(bubble.at);
            const proof = messageId ? window.closedTurns.get(messageId) : undefined;
            if (!window.complete && !proof) continue;
            const containing = attempts.filter((a) => bubble.at >= a.accepted_at && bubble.at <= (a.terminal_at ?? opts.now));
            containing.sort((a, b) => b.accepted_at - a.accepted_at);
            const attempt = containing[0];
            if (attempt && !reportIds.has(attempt.attempt_id)) reportIds.set(attempt.attempt_id,
                reportBodyId(renderNativeReplies(window.bubbles.filter(b => b.at >= attempt.accepted_at && b.at <= (attempt.terminal_at ?? opts.now)))));
            // A pre-upgrade (or capacity-pruned) delivered row has no complete
            // delivery manifest. Its captured body cannot prove which parts were
            // shown. Keep this uncertainty rather than emit a false missing claim.
            if (attempt?.relayed_at != null && (attempt.coverage_at === null || attempt.coverage_at <= since)) {
                complete = false;
                continue;
            }
            const open = !!attempt && (!TERMINAL.has(attempt.state)
                || attempt.terminal_at === null || opts.now < attempt.terminal_at + RELAY_QUIET_MS);
            out.push({
                sessionId, meshId, messageId,
                ...(attempt && window.complete && !open ? { attemptReportId: reportIds.get(attempt.attempt_id) } : {}),
                ...(proof ? { nativeTurnProof: { ...proof, sessionId, contentHash: createHash('sha256').update(bubble.text.replace(/\r\n?/g, '\n').trim()).digest('hex'), generation: null } } : {}),
                messageAt: bubble.at,
                chars: Array.from(bubble.text).length,
                text: bubble.text,
                attemptId: attempt?.attempt_id ?? null,
                ...(open ? { attemptOpen: true } : {}),
                ...(attempt && restartClosed(attempt) ? { restartClosed: true } : {}),
            });
        }
    }
    if (failed && !successful) throw new Error('coordinator native audit unavailable');
    return complete ? out : Object.assign(out, { complete: false });
}
