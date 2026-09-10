/**
 * (QUEUED-SEND-CANCEL) The daemon half of cancelling a parked send.
 *
 * ★ Why this command exists at all.
 *
 * A queued send is not merely a UI state — the body really is sitting in
 * `FsmDriver.pendingSends`, and `drainPendingSends()` WILL write it to the agent
 * as soon as the machine returns to idle. A dashboard that only hid its own
 * bubble would produce the worst outcome available: the owner is told the
 * message was cancelled, watches it disappear, and then the agent answers it
 * anyway some minutes later with nothing on screen to explain where it came
 * from. So cancellation has to remove the body where it actually lives, and the
 * command has to report honestly whether it managed to.
 *
 * The removal primitive is `claimQueuedSends(text)` — content-keyed, and already
 * used by the interrupt path, so cancellation introduces no new semantics.
 */

import { describe, expect, it, vi } from 'vitest';
import { handleCancelQueuedChat } from '../../src/commands/chat-commands.js';
import type { CommandHelpers } from '../../src/commands/handler.js';

interface FakeAdapterOptions {
    cliType?: string;
    /** How many entries the FIFO removes for the requested body. */
    claimResult?: number;
    /** Omit claimQueuedSends entirely (an adapter that cannot cancel). */
    withoutClaim?: boolean;
}

function makeHelpers(options: {
    transport?: string | null;
    adapter?: FakeAdapterOptions | null;
} = {}): { helpers: CommandHelpers; claim: ReturnType<typeof vi.fn> } {
    const claim = vi.fn(() => options.adapter?.claimResult ?? 0);
    const adapter = options.adapter
        ? {
            cliType: options.adapter.cliType || 'claude-code',
            ...(options.adapter.withoutClaim ? {} : { claimQueuedSends: claim }),
        }
        : null;

    const helpers = {
        // `getTargetTransport` short-circuits on currentSession.transport, so this
        // alone decides the PTY/non-PTY branch.
        currentSession: options.transport === null ? undefined : { transport: options.transport || 'pty' },
        currentManagerKey: 'mgr',
        currentProviderType: 'claude-code',
        getProvider: () => undefined,
        getCliAdapter: () => adapter,
        ctx: {},
    } as unknown as CommandHelpers;

    return { helpers, claim };
}

describe('cancel_queued_chat — removes the body from the daemon FIFO', () => {
    it('★ claims the parked body and reports it removed', async () => {
        const { helpers, claim } = makeHelpers({ adapter: { claimResult: 1 } });

        const result = await handleCancelQueuedChat(helpers, { message: 'the queued body' });

        expect(result.success).toBe(true);
        expect(result.cancelled).toBe(1);
        expect(result.removed).toBe(true);
        // Content-keyed: the exact body is what identifies the entry.
        expect(claim).toHaveBeenCalledWith('the queued body');
    });

    it('★ reports cancelled:0 / removed:false when the queue already drained', async () => {
        // The race that matters: the agent went idle and consumed the body while
        // the owner was deciding. Reporting success here would let the dashboard
        // clear a bubble for a message the agent is actively answering.
        const { helpers } = makeHelpers({ adapter: { claimResult: 0 } });

        const result = await handleCancelQueuedChat(helpers, { message: 'already drained' });

        expect(result.success).toBe(true);
        expect(result.cancelled).toBe(0);
        expect(result.removed).toBe(false);
    });

    it('cancels every copy when the same body was queued more than once', async () => {
        const { helpers } = makeHelpers({ adapter: { claimResult: 2 } });
        const result = await handleCancelQueuedChat(helpers, { message: 'continue' });
        expect(result.cancelled).toBe(2);
        expect(result.removed).toBe(true);
    });

    it('rejects an empty body rather than claiming an unspecified entry', async () => {
        const { helpers, claim } = makeHelpers({ adapter: { claimResult: 1 } });

        for (const message of ['', '   ', undefined]) {
            const result = await handleCancelQueuedChat(helpers, { message });
            expect(result.success).toBe(false);
            expect(result.error).toContain('message required');
        }
        expect(claim).not.toHaveBeenCalled();
    });

    it('refuses non-PTY transports, which have no send FIFO to cancel from', async () => {
        for (const transport of ['acp', 'cdp-webview', 'cdp-page']) {
            const { helpers, claim } = makeHelpers({ transport, adapter: { claimResult: 1 } });
            const result = await handleCancelQueuedChat(helpers, { message: 'body' });
            expect(result.success).toBe(false);
            expect(String(result.error)).toContain('only supported on PTY');
            expect(claim).not.toHaveBeenCalled();
        }
    });

    it('fails clearly when no CLI adapter is resolved', async () => {
        const { helpers } = makeHelpers({ adapter: null });
        const result = await handleCancelQueuedChat(helpers, { message: 'body' });
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('CLI adapter not found');
    });

    it('fails clearly when the adapter cannot cancel (older driver)', async () => {
        const { helpers } = makeHelpers({ adapter: { withoutClaim: true } });
        const result = await handleCancelQueuedChat(helpers, { message: 'body' });
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('does not support cancelling');
    });
});
