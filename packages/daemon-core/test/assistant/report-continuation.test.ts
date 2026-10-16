import { describe, expect, it, vi } from 'vitest';
import { compactTranscriptTail, reportMessageId } from '../../src/assistant/project-views.js';
import { continueReport, parseReportContinuation } from '../../src/assistant/report-continuation.js';
import { localProjectRead, localAttemptReport } from '../../src/commands/high-family/assistant.js';

describe('exact long-report continuation', () => {
    it('recovers a 4229 character original suffix with stable identity and exact completeness', async () => {
        const message = { bubbleId: 'native-original', role: 'assistant', timestamp: 123, content: 'a'.repeat(4200) + 'converge both commits. done!!' };
        expect(message.content.length).toBe(4229);
        const tail: any = compactTranscriptTail({ messages: [message] }, 10);
        const first = tail.messages[0]; expect(first.complete).toBe(false); expect(first.nextOffset).toBe(4000); expect(first.totalChars).toBe(4229);
        const execute = vi.fn(async () => ({ success: true, messages: [message] }));
        const suffix: any = await continueReport(execute, { messageId: first.messageId, offset: first.nextOffset, coordinatorSessionId: 'coord' });
        expect(suffix.text).toBe(message.content.slice(4000)); expect(suffix.complete).toBe(true); expect(suffix.nextOffset).toBe(null);
        expect(first.text.slice(0, 4000) + suffix.text).toBe(message.content);
        expect(reportMessageId(message)).toBe(reportMessageId({ ...message }));
    });
    it('searches existing native history before declaring missing; never substitutes latest, growing or invisible message', async () => {
        const original = { bubbleId: 'old', role: 'assistant', content: 'full old report' };
        const execute = vi.fn(async (cmd: string) => cmd === 'read_chat' ? { success: true, messages: [{ ...original, content: 'new content' }] } : { success: true, messages: [original], hasMore: false });
        const cursor = { messageId: reportMessageId(original), coordinatorSessionId: 'coord', offset: 0 };
        expect((await continueReport(execute, cursor)).text).toBe('full old report');
        execute.mockImplementation(async () => ({ success: true, messages: [{ ...original, kind: 'tool_result' }], hasMore: false }));
        expect(await continueReport(execute, cursor)).toMatchObject({ success: false, code: 'original_report_unavailable' });
    });
    it('bounds reads and rejects malformed/out-of-range cursor and cross-project coordinator', async () => {
        expect(parseReportContinuation({ messageId: 'bad', offset: -1 })).toBeTypeOf('string');
        expect(parseReportContinuation({})).toBe(null);
        const execute = vi.fn(async () => ({ success: true, messages: [], hasMore: true }));
        const cursor = { messageId: 'a'.repeat(64), coordinatorSessionId: 'foreign', offset: 0 };
        await continueReport(execute, cursor); expect(execute).toHaveBeenCalledTimes(9);
        execute.mockClear();
        const ports: any = { execute, coordinators: () => [], lastCoordinatorSessionId: () => 'local' };
        expect(await localProjectRead(ports, 'mesh', 10, cursor)).toMatchObject({ result: { code: 'original_report_unavailable', reason: 'coordinator_session_no_longer_authorized' } });
        expect(execute).not.toHaveBeenCalled();
    });
});

it('attempt cursor rejects a changed recovered report and gives exact suffix completeness', async () => {
    const { pageAttemptReport, reportBodyId } = await import('../../src/assistant/report-continuation.js');
    const body = 'a'.repeat(4229); const cursor = { attemptId: 'attempt', coordinatorSessionId: 'coord', offset: 4000, reportId: reportBodyId(body) };
    expect(pageAttemptReport(body, cursor, 'native')).toMatchObject({ text: 'a'.repeat(229), complete: true, nextOffset: null, totalChars: 4229 });
    expect(pageAttemptReport('changed body', cursor, 'native')).toMatchObject({ success: false, reason: 'original_report_identity_mismatch' });
});

it('refuses unauthorized exact attempt reads before opening any durable body or evidence store', async () => {
    const execute = vi.fn();
    const ports: any = { execute, coordinatorSessionAuthorized: () => false };
    expect(await localAttemptReport(ports, 'mesh', 'foreign', 'plain:coord:1')).toMatchObject({ body: null, reason: 'coordinator_session_no_longer_authorized' });
    expect(execute).not.toHaveBeenCalled();
});
