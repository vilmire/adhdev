import type { TaskReportCursor } from './task-report-continuation.js';
import { createHash } from 'crypto';
import { isVisible, messageText, reportMessageId, PROJECT_READ_MESSAGE_MAX_CHARS } from './project-views.js';
import type { Execute } from './assistant-project-ports.js';

export interface ReportContinuation { messageId: string; offset: number; coordinatorSessionId: string }

export interface ReportAttemptContinuation { attemptId: string; reportId?: string; offset: number; coordinatorSessionId: string }
export type ReportCursor = ReportContinuation | ReportAttemptContinuation | TaskReportCursor;
export const reportBodyId = (body: string): string => createHash('sha256').update(body).digest('hex');
export function pageAttemptReport(body: string, cursor: ReportAttemptContinuation, source: string, completeness: 'final_native' | 'envelope_unverified' = 'final_native') {
    const reportId = reportBodyId(body);
    if (cursor.reportId && cursor.reportId !== reportId) return { success: false as const, code: 'original_report_unavailable', reason: 'original_report_identity_mismatch' };
    if (cursor.offset > body.length) return { success: false as const, code: 'invalid_report_offset' };
    const end = Math.min(body.length, cursor.offset + PROJECT_READ_MESSAGE_MAX_CHARS);
    const pageComplete = end === body.length;
    // Omitted completeness stays final_native so existing callers keep `complete: end === length`.
    // `success` stays a literal so callers can narrow. A conditional spread widens it to boolean.
    const sourceComplete = completeness === 'final_native';
    const page = { success: true as const, attemptId: cursor.attemptId, coordinatorSessionId: cursor.coordinatorSessionId, reportId, source,
        text: body.slice(cursor.offset, end), offset: cursor.offset, totalChars: body.length,
        sourceComplete, complete: pageComplete && sourceComplete, truncated: end < body.length, nextOffset: end < body.length ? end : null };
    if (sourceComplete) return page;
    return { ...page, originalCompleteness: completeness === 'envelope_unverified' ? 'envelope_unverified' as const : 'unknown' as const };
}

export function parseReportContinuation(args: Record<string, unknown>): ReportCursor | null | string {
    if (args.taskId !== undefined) {
        if (typeof args.taskId !== 'string' || !args.taskId || args.taskId.length > 200 || args.attemptId !== undefined || args.messageId !== undefined
            || !Number.isSafeInteger(args.offset ?? 0) || Number(args.offset ?? 0) < 0
            || (args.outputVersion !== undefined && (!Number.isSafeInteger(args.outputVersion) || Number(args.outputVersion) < 1))
            || (Number(args.offset ?? 0) > 0 && args.outputVersion === undefined)
            || (args.reportId !== undefined && (typeof args.reportId !== 'string' || !/^[a-f0-9]{64}$/.test(args.reportId)))) return 'taskId, non-negative offset and stable outputVersion for continuation required';
        return { taskId: args.taskId, offset: Number(args.offset ?? 0), ...(typeof args.outputVersion === 'number' ? { outputVersion: args.outputVersion } : {}), ...(typeof args.reportId === 'string' ? { reportId: args.reportId } : {}) };
    }
    if (args.attemptId !== undefined) {
        if (typeof args.attemptId !== 'string' || !args.attemptId || args.attemptId.length > 200
            || typeof args.coordinatorSessionId !== 'string' || !args.coordinatorSessionId
            || args.messageId !== undefined || (args.reportId !== undefined && (typeof args.reportId !== 'string' || !/^[a-f0-9]{64}$/.test(args.reportId)))
            || !Number.isSafeInteger(args.offset ?? 0) || Number(args.offset ?? 0) < 0) return 'attemptId, coordinatorSessionId and non-negative offset required; reportId must be a SHA256 identity';
        return { attemptId: args.attemptId, coordinatorSessionId: args.coordinatorSessionId, offset: Number(args.offset ?? 0), ...(typeof args.reportId === 'string' ? { reportId: args.reportId } : {}) };
    }
    if (args.messageId === undefined && args.offset === undefined && args.coordinatorSessionId === undefined) return null;
    if (typeof args.messageId !== 'string' || !/^[a-f0-9]{64}$/.test(args.messageId)
        || typeof args.coordinatorSessionId !== 'string' || !args.coordinatorSessionId
        || !Number.isSafeInteger(args.offset) || (args.offset as number) < 0) return 'messageId, coordinatorSessionId and non-negative integer offset required';
    return { messageId: args.messageId, offset: args.offset as number, coordinatorSessionId: args.coordinatorSessionId };
}

/** Bounded exact-session recovery; never substitute a newest reply for the requested report. */
export async function continueReport(execute: Execute, cursor: ReportContinuation): Promise<Record<string, unknown>> {
    const slice = (chat: Record<string, unknown>): Record<string, unknown> | null => {
        const messages = Array.isArray(chat.messages) ? chat.messages : [];
        const found = messages.find(m => isVisible(m) && reportMessageId(m) === cursor.messageId);
        if (!found) return null;
        const body = messageText(found);
        if (cursor.offset > body.length) return { success: false, code: 'invalid_report_offset' };
        const end = Math.min(body.length, cursor.offset + PROJECT_READ_MESSAGE_MAX_CHARS);
        return { success: true, coordinatorSessionId: cursor.coordinatorSessionId, messageId: cursor.messageId,
            text: body.slice(cursor.offset, end), offset: cursor.offset, totalChars: body.length,
            truncated: end < body.length, complete: end === body.length, nextOffset: end < body.length ? end : null };
    };
    const tail = await execute('read_chat', { targetSessionId: cursor.coordinatorSessionId, limit: 200 });
    if (tail.success) { const page = slice(tail); if (page) return page; }
    // Existing history consumer resolves native/session mappings and authorization.
    // No file paths supplied by the model, no body cache on disk, bounded to 800 bubbles.
    for (let offset = 0; offset < 800; offset += 100) {
        const history = await execute('chat_history', { targetSessionId: cursor.coordinatorSessionId,
            offset, limit: 100, excludeRecentCount: 0 });
        if (!history.success) return { success: false, code: 'original_report_unavailable', reason: 'history_read_failed' };
        const page = slice(history); if (page) return page;
        if (history.hasMore !== true) break;
    }
    return { success: false, code: 'original_report_unavailable', reason: 'exact_message_not_found_in_bounded_history' };
}
