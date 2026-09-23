import assert from 'node:assert/strict';
import test from 'node:test';

import { sendChat } from '../src/tools/send-chat.js';

// D2 (applied in C-W8): the send_chat tool feeds the daemon's ONE send funnel —
// it forwards a messageId (the caller's, or a minted one), the admission policy
// and origin 'mcp', so a retried send is deduplicated and a busy session is
// handled per policy instead of by legacy booleans.
function capture() {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const transport = { command: async (command: string, args: Record<string, unknown> = {}) => { calls.push({ command, args }); return { success: true }; } };
    return { calls, transport: transport as any };
}

test('forwards the caller message_id, the delivery_mode policy and origin mcp', async () => {
    const { calls, transport } = capture();
    assert.equal(await sendChat(transport, { message: 'hi', session_id: 's1', message_id: 'msg_fixed', delivery_mode: 'interrupt' }), 'Message sent.');
    assert.deepEqual(calls[0], { command: 'send_chat', args: { message: 'hi', targetSessionId: 's1', messageId: 'msg_fixed', policy: { mode: 'interrupt' }, origin: 'mcp' } });
});

test('mints a messageId and defaults to queue when neither is given', async () => {
    const { calls, transport } = capture();
    await sendChat(transport, { message: 'hi' });
    assert.match(String(calls[0].args.messageId), /^msg_/);
    assert.deepEqual(calls[0].args.policy, { mode: 'queue' });
    assert.equal(calls[0].args.origin, 'mcp');
});

test('refuses an unknown delivery_mode instead of silently queueing', async () => {
    const { calls, transport } = capture();
    assert.match(await sendChat(transport, { message: 'hi', delivery_mode: 'now!' }), /unknown delivery_mode/);
    assert.equal(calls.length, 0);
});
