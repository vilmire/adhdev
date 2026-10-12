import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantToolRefresh } from '../src/assistant-tool-refresh.js';
import { resolveAssistantModeTools, availableAssistantTools } from '../src/tools/assistant-tools.js';
import { handleAssistantToolCall } from '../src/assistant-server.js';

test('live attestation and OFF to ON refresh tool visibility; cached calls recheck enforcement', async () => {
    let enabled = true, enforced = false, notifications = 0, dispatches = 0;
    const transport = { command: async (type: string) => {
        if (type === 'assistant_execution_state') return { success: true, executionEnabled: enabled, executionAvailable: enabled && enforced };
        if (type === 'assistant_action') dispatches++;
        return { success: true };
    } };
    const tools = resolveAssistantModeTools();
    const refresh = new AssistantToolRefresh(transport, 'assistant', tools, async () => { notifications++; });
    await refresh.refresh(); assert.equal(notifications, 0);
    enforced = true; await refresh.refresh(); assert.equal(notifications, 1);
    enabled = false; await refresh.refresh(); assert.equal(notifications, 2);
    assert.equal((await availableAssistantTools(transport, 'assistant', tools)).some(t => t.name === 'assistant_action'), false);
    enabled = true; await refresh.refresh(); assert.equal(notifications, 3);
    assert.equal((await availableAssistantTools(transport, 'assistant', tools)).some(t => t.name === 'assistant_action'), true);
    enforced = false; // no refresh: a cached tool still cannot execute
    const result = await handleAssistantToolCall(transport, tools, 'assistant', 'assistant_action', {
        authorization: 'cap', meshId: 'mesh', targetSessionId: 'worker', action: 'approve', button: 'Accept',
    });
    assert.equal(result.isError, true); assert.equal(dispatches, 0);
    await refresh.refresh(); assert.equal(notifications, 4);
});

test('failed list_changed notification retries on the next refresh', async () => {
    let live = false, count = 0;
    const transport = { command: async () => ({ success: true, executionEnabled: true, executionAvailable: live }) };
    const refresh = new AssistantToolRefresh(transport, 'assistant', resolveAssistantModeTools(), async () => {
        if (++count === 1) throw Error('disconnected');
    });
    await refresh.refresh(); live = true;
    await assert.rejects(refresh.refresh(), /disconnected/);
    await refresh.refresh(); assert.equal(count, 2);
});

test('an initial list before attestation is refreshed even when enforcement arrives before the first timer baseline', async () => {
    const transport = { command: async () => ({ success: true, executionEnabled: true, executionAvailable: true }) };
    const tools = resolveAssistantModeTools(); let count = 0;
    const refresh = new AssistantToolRefresh(transport, 'assistant', tools, async () => { count++; });
    refresh.recordListed(tools.filter(t => t.name !== 'assistant_action'));
    await refresh.refresh(); assert.equal(count, 1);
});
