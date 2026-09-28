/**
 * DUPLICATE-GATE-REARM — one "Send now" press must never produce two agent turns.
 *
 * ★ The live defect (2026-09-24, darwin, rc.35). The owner pressed "Send now"
 * on a queued bubble and the body reached the agent TWICE. The daemon log shows
 * the shape exactly:
 *
 *   [02:51:39] mid-generation split write (len=49)   ← passed
 *   [02:51:43] send suppressed — duplicate (len=38)  ← suppressed
 *   [02:51:47] mid-generation split write (len=38)   ← passed AGAIN, 4s later
 *
 * ★ Root cause: `submitCliChat` resolved an out-of-band press (`send_now` /
 * `interrupt`) to a parked body by TEXT for pre-D dashboards, and when that
 * lookup MISSED it fell through to `mintLegacyMessageId()` — a fresh random id.
 * Every dedupe layer in `SessionInputService` is keyed by `messageId`, so a new
 * id defeats all three at once:
 *
 *   - the settled map has never seen it   → the `delivered` check cannot fire
 *   - the driver FIFO does not hold it    → `parked` is false
 *   - so `splitWrite` takes the NOT-parked branch and writes a FRESH body,
 *     while the original entry stays parked and the idle drain writes it again.
 *
 * ★ The fix is to FAIL CLOSED: an out-of-band press that matches no parked body
 * is refused rather than promoted to a new logical send. The tests below pin
 * BOTH directions, because either one alone permits a silent regression:
 *
 *   (a) the same body arriving through two different routes must not be
 *       written twice  — the defect this closes; and
 *   (b) the claim subject's OWN resubmit must still go through — without this,
 *       "fix" the gate by suppressing harder and the body is silently LOST,
 *       which is strictly worse than the duplicate it replaces.
 */

import { describe, expect, it, vi } from 'vitest';
import { handleSendChat } from '../../src/commands/chat-commands.js';
import type { CommandHelpers } from '../../src/commands/handler.js';

/**
 * A PTY session whose driver exposes the full claim surface. `writes` records
 * every body that actually reached the terminal, by route — the only thing that
 * decides whether the owner saw one turn or two.
 */
function makeSession(options: {
    status?: string;
    parked?: Array<{ messageId: string; text: string }>;
} = {}) {
    const fifo = [...(options.parked ?? [])];
    /** Bodies that really reached the PTY. */
    const writes: Array<{ route: 'split' | 'pty'; text: string }> = [];

    const claimQueuedSend = vi.fn((id: string) => {
        const index = fifo.findIndex(e => e.messageId === id);
        return index < 0 ? null : { entry: fifo.splice(index, 1)[0], index };
    });

    const sendMessageDuringGeneration = vi.fn((text: string) => {
        writes.push({ route: 'split', text });
        return { accepted: true };
    });

    const adapter = {
        cliType: 'claude-code',
        getStatus: () => ({ status: options.status ?? 'generating' }),
        async sendMessage(text: string, opts?: { messageId?: string }) {
            // Mirrors the real driver: it parks whatever it cannot write now.
            if ((options.status ?? 'generating') === 'generating') {
                fifo.push({ messageId: opts?.messageId || 'anon', text });
                return { status: 'queued' as const, position: fifo.length };
            }
            writes.push({ route: 'pty', text });
            return { status: 'delivered' as const };
        },
        hasQueuedSend: (id: string) => fifo.some(e => e.messageId === id),
        claimQueuedSend,
        restoreQueuedSend: (claimed: { entry: { messageId: string; text: string }; index: number }) => {
            fifo.splice(claimed.index, 0, claimed.entry);
        },
        sendMessageDuringGeneration,
        reserveDrain: () => {},
        releaseDrain: () => {},
    };

    const helpers = {
        currentSession: { sessionId: 'sess-1', transport: 'pty' },
        currentManagerKey: 'mgr',
        currentProviderType: 'claude-code',
        getProvider: () => undefined,
        getCliAdapter: () => adapter,
        ctx: { adapters: new Map([['sess-1', adapter]]) },
    } as unknown as CommandHelpers;

    return { helpers, fifo, writes, claimQueuedSend, sendMessageDuringGeneration };
}

describe('DUPLICATE-GATE-REARM — a claim must not re-arm the dedupe for a second route', () => {
    it('★ (a) the SAME body pressed through a second route is NOT written twice', async () => {
        const { helpers, fifo, writes } = makeSession();

        // The owner's original send, parked while the agent generates.
        const queued = await handleSendChat(helpers, { messageId: 'msg_a', message: 'the queued body' });
        expect(queued).toMatchObject({ success: true, queued: true });
        expect(fifo.map(e => e.messageId)).toEqual(['msg_a']);

        // "Send now" on that bubble — claims the parked entry and split-writes it.
        const sendNow = await handleSendChat(helpers, {
            messageId: 'msg_a',
            message: 'the queued body',
            policy: { mode: 'send_now' },
        });
        expect(sendNow).toMatchObject({ success: true, queuedWithAgent: true });
        expect(fifo).toEqual([]);
        expect(writes).toEqual([{ route: 'split', text: 'the queued body' }]);

        // ★ The regression. A SECOND route carrying the same body — the live
        // shape was a text-keyed press arriving after the claim had emptied the
        // FIFO. Before the fix this minted a brand-new messageId, bypassed all
        // three messageId-keyed dedupe layers and wrote the body a second time.
        const second = await handleSendChat(helpers, {
            message: 'the queued body',
            policy: { mode: 'send_now' },
        });

        expect(second.success).toBe(false);
        expect(second.reason).toBe('not_parked');
        // The only thing that actually matters: still exactly ONE write.
        expect(writes).toEqual([{ route: 'split', text: 'the queued body' }]);
    });

    it('★ (a2) a text-keyed press with NOTHING parked is refused, never minted into a fresh send', async () => {
        const { helpers, writes, sendMessageDuringGeneration } = makeSession({ parked: [] });

        const result = await handleSendChat(helpers, {
            message: 'a body this daemon never parked',
            policy: { mode: 'send_now' },
        });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('not_parked');
        expect(String(result.error)).toContain('no longer waiting');
        // Nothing was written — the whole point. A minted id would have taken
        // splitWrite's NOT-parked branch and written a fresh body here.
        expect(sendMessageDuringGeneration).not.toHaveBeenCalled();
        expect(writes).toEqual([]);
    });

    it('★ (a3) the same refusal applies to `interrupt`, which shares the mint fallthrough', async () => {
        const { helpers, writes } = makeSession({ parked: [] });

        const result = await handleSendChat(helpers, {
            message: 'nothing is parked under this',
            policy: { mode: 'interrupt' },
        });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('not_parked');
        expect(writes).toEqual([]);
    });

    it('★ (b) the claim subject\'s OWN resubmit still goes through — no silent loss', async () => {
        const { helpers, fifo, writes, claimQueuedSend } = makeSession();

        const queued = await handleSendChat(helpers, { messageId: 'msg_b', message: 'promote me' });
        expect(queued).toMatchObject({ success: true, queued: true });

        // The owner presses Send now on THAT bubble, by its own id. This is a
        // RESUBMIT of the same logical message under a new policy and it must
        // still be delivered — suppressing it would be the silent-data-loss
        // regression that makes the duplicate look like the lesser evil.
        const sendNow = await handleSendChat(helpers, {
            messageId: 'msg_b',
            message: 'promote me',
            policy: { mode: 'send_now' },
        });

        expect(sendNow).toMatchObject({ success: true, queuedWithAgent: true });
        expect(claimQueuedSend).toHaveBeenCalledWith('msg_b');
        expect(writes).toEqual([{ route: 'split', text: 'promote me' }]);
        expect(fifo).toEqual([]);
    });

    it('★ (b2) LEGACY text-keyed send-now on a body that IS parked still resolves and delivers', async () => {
        const { helpers, fifo, writes } = makeSession();

        // A pre-D dashboard send: no messageId, so the daemon mints one and parks it.
        const queued = await handleSendChat(helpers, { message: 'pre-D body' });
        expect(queued).toMatchObject({ success: true, queued: true });
        expect(fifo).toHaveLength(1);

        // The same pre-D dashboard presses Send now by TEXT only. The legacy
        // lookup must still find it — this is the path the refusal above must
        // NOT have broken.
        const sendNow = await handleSendChat(helpers, {
            message: 'pre-D body',
            policy: { mode: 'send_now' },
        });

        expect(sendNow).toMatchObject({ success: true, queuedWithAgent: true });
        expect(writes).toEqual([{ route: 'split', text: 'pre-D body' }]);
        expect(fifo).toEqual([]);
    });

    it('★ (b3) an ordinary `queue` send with no messageId is untouched — it is a NEW message', async () => {
        const { helpers, fifo } = makeSession();

        // The mint fallthrough is correct HERE (shortcuts API, `adhdev send`):
        // there is no parked body to promote, the caller is sending something new.
        const first = await handleSendChat(helpers, { message: 'a brand new body' });
        const second = await handleSendChat(helpers, { message: 'a brand new body' });

        expect(first).toMatchObject({ success: true, queued: true });
        expect(second).toMatchObject({ success: true, queued: true });
        // Two distinct logical sends → two parked entries with distinct ids.
        expect(fifo).toHaveLength(2);
        expect(fifo[0].messageId).not.toBe(fifo[1].messageId);
    });
});
