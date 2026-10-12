import { expect, it } from 'vitest';
import { ASSISTANT_TOOLS, ASSISTANT_WRITE_TOOLS } from '@adhdev/mesh-shared';
import { availableAssistantTools, resolveAssistantModeTools } from '../../../mcp-server/src/tools/assistant-tools.js';
import { assistantToolArgsError } from '../../../mcp-server/src/assistant-server.js';
it('tool tuple/schema/annotation parity includes all new consumers and rejects forged consent/source', () => {
    const tools = resolveAssistantModeTools(); expect(tools.map(t => t.name)).toEqual([...ASSISTANT_TOOLS]);
    expect(tools.filter(t => !t.annotations.readOnlyHint).map(t => t.name).sort()).toEqual([...ASSISTANT_WRITE_TOOLS].sort());
    const action = tools.find(t => t.name === 'assistant_action')!;
    expect(assistantToolArgsError(action, { authorization: 'cap', meshId: 'm', targetSessionId: 's', action: 'approve', button: 'Accept', promptSource: 'OWNER', consent: true })).toBeTypeOf('string');
    const read = tools.find(t => t.name === 'project_read')!;
    expect(Object.keys(read.inputSchema.properties)).toEqual(expect.arrayContaining(['taskId','outputVersion','attemptId','reportId','messageId','offset','coordinatorSessionId']));
});
it('OFF, MCP-only, prompt_only and failed daemon state remove execution but preserve reads/send/Inbox separation', async () => {
    const transport = { command: async () => ({ success: true, executionEnabled: true, executionAvailable: true }) } as any;
    expect((await availableAssistantTools(transport, 'assistant')).some(t => t.name === 'assistant_action')).toBe(true);
    for (const response of [{ success: true, executionEnabled: false, executionAvailable: true }, { success: true, executionEnabled: true, executionAvailable: false }, { success: false }]) {
        transport.command = async () => response;
        const list = await availableAssistantTools(transport, 'assistant'); expect(list.some(t => t.name === 'assistant_action')).toBe(false);
        expect(list.map(t => t.name)).toEqual(expect.arrayContaining(['project_read','project_send','project_watch','environment']));
        expect(list.map(t => t.name)).not.toContain('assistant_staged_resolve');
    }
    transport.command = async () => { throw Error('offline'); };
    expect((await availableAssistantTools(transport, 'assistant')).some(t => t.name === 'assistant_action')).toBe(false);
    expect((await availableAssistantTools(transport, undefined)).some(t => t.name === 'assistant_action')).toBe(false);
});
