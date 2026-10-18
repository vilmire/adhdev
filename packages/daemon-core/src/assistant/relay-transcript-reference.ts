/** Readability is weaker than proof of final capture; never promote it to final_native. */
import type { Execute } from './assistant-project-ports.js';
import type { AuditedCoordinatorReply } from './assistant-native-window.js';
import { continueReport, type ReportContinuation } from './report-continuation.js';
import { isVisible, messageText, reportMessageId } from './project-views.js';

const normalize = (text: string) => text.replace(/\r\n?/g, '\n');

export async function coordinatorReplyReadable(execute: Execute, reply: AuditedCoordinatorReply): Promise<boolean> {
    if (!reply.messageId) return false;
    const page = await continueReport(execute, { coordinatorSessionId: reply.sessionId, messageId: reply.messageId, offset: 0 });
    if (page.success !== true || typeof page.text !== 'string') return false;
    // The content-bound cursor already matched the raw message. Compare text in
    // the same normalization as the auditor, rather than raw vs trimmed lengths.
    const expected = normalize(reply.text).trim();
    return page.complete === true ? normalize(page.text).trim() === expected
        : expected.startsWith(normalize(page.text).trim());
}

/** A context pointer, deliberately not an exact-attempt content claim. */
export async function latestCoordinatorReference(execute: Execute, sessionId: string): Promise<ReportContinuation | null> {
    for (const command of ['read_chat', 'chat_history']) {
        const read = await execute(command, { targetSessionId: sessionId, limit: 100,
            ...(command === 'chat_history' ? { offset: 0, excludeRecentCount: 0 } : {}) });
        if (!read.success || !Array.isArray(read.messages)) continue;
        const message = [...read.messages].reverse().find(m => isVisible(m) && ['assistant', 'agent'].includes(String(m.role))
            && (!m.kind || m.kind === 'standard') && messageText(m).trim());
        if (message) return { coordinatorSessionId: sessionId, messageId: reportMessageId(message), offset: 0 };
    }
    return null;
}
