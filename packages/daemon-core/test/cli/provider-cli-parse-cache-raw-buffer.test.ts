import { describe, expect, it, vi } from 'vitest';
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js';

function makeAdapter(parseSession: ReturnType<typeof vi.fn>): any {
  const adapter = new ProviderCliAdapter({
    type: 'test-cli',
    name: 'Test CLI',
    category: 'cli',
    binary: 'test-cli',
    spawn: {
      command: 'test-cli',
      args: [],
      shell: true,
      env: {},
    },
    scripts: {
      detectStatus: () => 'idle',
      parseApproval: () => null,
      parseSession,
    },
  } as any, '/tmp/project') as any;

  let screenText = '';
  adapter.terminalScreen = {
    write: vi.fn((data: string) => {
      screenText += String(data || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
    }),
    getText: vi.fn(() => screenText),
  };
  adapter.scheduleSettle = vi.fn();
  adapter.scheduleStartupSettleCheck = vi.fn();
  adapter.resolveStartupState = vi.fn();
  adapter.startupParseGate = false;
  adapter.currentStatus = 'idle';
  adapter.activeModal = null;
  return adapter;
}

describe('ProviderCliAdapter parsed-status cache', () => {
  it('invalidates cache hits when raw PTY output gains semantic text', () => {
    const parseSession = vi.fn((input: any) => ({
      id: 'cli_session',
      status: 'idle',
      title: 'Test CLI',
      messages: [
        { role: 'assistant', content: input.rawBuffer || 'empty', id: 'assistant-1', index: 0, receivedAt: 2 },
      ],
    }));
    const adapter = makeAdapter(parseSession);

    const first = adapter.getScriptParsedStatus();
    adapter.handleOutput('\x1b[31mvisible raw text');
    const second = adapter.getScriptParsedStatus();

    expect(parseSession).toHaveBeenCalledTimes(2);
    expect(first.messages[0].content).toBe('empty');
    expect(second.messages[0].content).toContain('visible raw text');
  });
});
