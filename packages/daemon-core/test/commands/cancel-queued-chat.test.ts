/**
 * (QUEUED-SEND-CANCEL) The daemon half of cancelling a parked send.
 *
 * ★ Why this command exists at all: a queued send is not merely a UI state —
 * the body really is sitting in `FsmDriver.pendingSends`, and the idle drain
 * WILL write it. A dashboard that only hid its bubble would tell the owner a
 * message was cancelled while the agent answers it minutes later. So the
 * removal happens where the body lives, and the command reports honestly
 * whether it managed to.
 *
 * ★ Wiring-unification D2: the removal is by `messageId` (the FIFO entry
 * carries the id the dashboard minted) through `SessionInputService.withdraw`
 * — exact, never a content guess. A text-only cancel from a pre-D dashboard is
 * served for one release by the service's legacy text → parked-id lookup.
 */

import { describe, expect, it, vi } from 'vitest';
import { handleCancelQueuedChat, handleSendChat } from '../../src/commands/chat-commands.js';
import type { CommandHelpers } from '../../src/commands/handler.js';

function makeHelpers(options: {
    transport?: string | null;
    adapter?: { withoutClaim?: boolean } | null;
    parked?: Array<{ messageId: string; text: string }>;
} = {}) {
    const fifo = [...(options.parked ?? [])];
    const claim = vi.fn((id: string) => {
        const index = fifo.findIndex(e => e.messageId === id);
        return index < 0 ? null : { entry: fifo.splice(index, 1)[0], index };
    });
    const adapter = options.adapter === null
        ? null
        : {
            cliType: 'claude-code',
            getStatus: () => ({ status: 'generating' }),
            async sendMessage(text: string, opts?: { messageId?: string }) {
                fifo.push({ messageId: opts?.messageId || 'anon', text });
                return { status: 'queued' as const, position: fifo.length };
            },
            hasQueuedSend: (id: string) => fifo.some(e => e.messageId === id),
            ...(options.adapter?.withoutClaim ? {} : { claimQueuedSend: claim }),
        };

    const helpers = {
        // `getTargetTransport` short-circuits on currentSession.transport.
        currentSession: options.transport === null ? undefined : { sessionId: 'sess-1', transport: options.transport || 'pty' },
        currentManagerKey: 'mgr',
        currentProviderType: 'claude-code',
        getProvider: () => undefined,
        getCliAdapter: () => adapter,
        ctx: { adapters: new Map(adapter ? [['sess-1', adapter]] : []) },
    } as unknown as CommandHelpers;

    return { helpers, claim, fifo };
}

describe('cancel_queued_chat — removes the body from the daemon FIFO by messageId', () => {
    it('★ withdraws the parked body named by messageId and reports it removed', async () => {
        const { helpers, claim, fifo } = makeHelpers({ parked: [{ messageId: 'msg_a', text: 'the queued body' }] });

        const result = await handleCancelQueuedChat(helpers, { messageId: 'msg_a', message: 'the queued body' });

        expect(result).toMatchObject({ success: true, cancelled: 1, removed: true, messageId: 'msg_a' });
        expect(claim).toHaveBeenCalledWith('msg_a');
        expect(fifo).toEqual([]);
    });

    it('★ reports cancelled:0 / removed:false when the queue already drained', async () => {
        const { helpers } = makeHelpers({ parked: [] });
        const result = await handleCancelQueuedChat(helpers, { messageId: 'msg_gone' });
        expect(result).toMatchObject({ success: true, cancelled: 0, removed: false });
    });

    it('★ two identical queued bodies: cancelling one id removes exactly that one', async () => {
        const { helpers, fifo } = makeHelpers({
            parked: [{ messageId: 'msg_1', text: 'continue' }, { messageId: 'msg_2', text: 'continue' }],
        });
        const result = await handleCancelQueuedChat(helpers, { messageId: 'msg_2', message: 'continue' });
        expect(result.cancelled).toBe(1);
        expect(fifo.map(e => e.messageId)).toEqual(['msg_1']);
    });

    it('rejects a request with neither messageId nor body', async () => {
        const { helpers, claim } = makeHelpers({ parked: [{ messageId: 'msg_a', text: 'x' }] });
        for (const message of ['', '   ', undefined]) {
            const result = await handleCancelQueuedChat(helpers, { message });
            expect(result.success).toBe(false);
            expect(result.error).toContain('messageId required');
        }
        expect(claim).not.toHaveBeenCalled();
    });

    it('LEGACY (one release): a text-only cancel finds the body this daemon parked for that text', async () => {
        const { helpers, fifo } = makeHelpers();
        // A pre-D dashboard send: no messageId → the daemon mints one and parks under it.
        const sent = await handleSendChat(helpers, { message: 'old dashboard body' });
        expect(sent).toMatchObject({ success: true, queued: true });
        expect(fifo).toHaveLength(1);

        const result = await handleCancelQueuedChat(helpers, { message: 'old dashboard body' });
        expect(result).toMatchObject({ success: true, cancelled: 1, removed: true });
        expect(fifo).toEqual([]);
    });

    it('refuses non-PTY transports, which have no send FIFO to cancel from', async () => {
        for (const transport of ['acp', 'cdp-webview', 'cdp-page']) {
            const { helpers, claim } = makeHelpers({ transport, parked: [{ messageId: 'msg_a', text: 'body' }] });
            const result = await handleCancelQueuedChat(helpers, { messageId: 'msg_a' });
            expect(result.success).toBe(false);
            expect(String(result.error)).toContain('only supported on PTY');
            expect(claim).not.toHaveBeenCalled();
        }
    });

    it('fails clearly when no CLI adapter is resolved', async () => {
        const { helpers } = makeHelpers({ adapter: null });
        const result = await handleCancelQueuedChat(helpers, { messageId: 'msg_a' });
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('CLI adapter not found');
    });

    it('fails clearly when the adapter cannot cancel (older driver)', async () => {
        const { helpers } = makeHelpers({ adapter: { withoutClaim: true } });
        const result = await handleCancelQueuedChat(helpers, { messageId: 'msg_a' });
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('does not support cancelling');
    });
});
