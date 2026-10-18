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

/** Shared by the local and remote lanes: assistant prose only, never thinking/tool/user rows. */
const referenceable = (role: unknown, kind: unknown, text: string): boolean =>
    ['assistant', 'agent'].includes(String(role)) && (kind === undefined || kind === null || kind === '' || kind === 'standard') && !!text.trim();

/** A context pointer, deliberately not an exact-attempt content claim. */
export async function latestCoordinatorReference(execute: Execute, sessionId: string): Promise<ReportContinuation | null> {
    for (const command of ['read_chat', 'chat_history']) {
        const read = await execute(command, { targetSessionId: sessionId, limit: 100,
            ...(command === 'chat_history' ? { offset: 0, excludeRecentCount: 0 } : {}) });
        if (!read.success || !Array.isArray(read.messages)) continue;
        const message = [...read.messages].reverse().find(m => isVisible(m) && referenceable(m.role, m.kind, messageText(m)));
        if (message) return { coordinatorSessionId: sessionId, messageId: reportMessageId(message), offset: 0 };
    }
    return null;
}

/** Remote hosts return compact rows that already carry the content-bound id. */
export function remoteCoordinatorReference(messages: readonly unknown[], sessionId: string): ReportContinuation | null {
    const message = [...messages].reverse().find((m: any) => isVisible(m) && referenceable(m?.role, m?.kind, typeof m?.text === 'string' ? m.text : '')
        && typeof m.messageId === 'string' && /^[a-f0-9]{64}$/.test(m.messageId)) as { messageId: string } | undefined;
    return message ? { coordinatorSessionId: sessionId, messageId: message.messageId, offset: 0 } : null;
}
