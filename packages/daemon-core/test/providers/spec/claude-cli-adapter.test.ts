import { describe, expect, it, vi } from 'vitest';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';

const SINGLE_QUESTION_SCREEN = [
  '▗ ▗   ▖ ▖  Claude Code v2.1.153',
  '           Opus 4.7 (1M context) with high effort · Claude Max',
  '  ▘▘ ▝▝    ~/Work/adhdev',
  '',
  '❯ ## Task: 가위바위보',
  '',
  '⏺ 안녕하세요! 가위바위보 한 판 해요.',
  '────────────────────────────────────────────────────────────────',
  ' ☐ 가위바위보 ',
  '',
  '무엇을 내시겠어요?',
  '',
  '❯ 1. ✊ 바위',
  '     주먹',
  '  2. ✌️  가위',
  '     검지와 중지',
  '  3. ✋  보',
  '     손바닥',
  '  4. Type something.',
  '────────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

function makeAdapter(screenText: string): any {
  const adapter = Object.create(SpecCliAdapter.prototype);
  Object.assign(adapter, {
    cliType: 'claude-cli',
    cliName: 'Claude Code',
    workingDir: '/tmp/work',
    driver: { snapshot: () => screenText },
    spec: {
      $schema: 'adhdev:cli/spec@1',
      id: 'claude-cli',
      name: 'Claude Code',
      binary: 'claude',
      send_message: { submit_key: '\r' },
      layout: {
        sections: [
          { id: 'footer', from_bottom: 3 },
          { id: 'modal_zone', from_bottom: 11, until: { section: 'footer' } },
          { id: 'body', from_top: 0, until: { section: 'modal_zone' } },
        ],
      },
      states: [{ id: 'idle', label: 'Ready', when: { regex: '.*' } }],
      default_state: 'idle',
    },
    latestState: { id: 'idle', label: 'Ready', title: null },
    latestModal: null,
    activeInteractivePrompt: null,
    interactivePromptTransport: null,
    claudeTuiPromptCaptureInFlight: false,
    exited: false,
    spawned: true,
    providerSessionId: 'session-1',
    statusCallback: vi.fn(),
  });
  return adapter;
}

describe('SpecCliAdapter — claude-cli screen fallbacks', () => {
  it('promotes headerless numbered-choice AskUserQuestion screens to activeInteractivePrompt', () => {
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);

    adapter.maybeCaptureClaudeTuiPrompt();

    expect(adapter.activeInteractivePrompt).not.toBeNull();
    expect(adapter.activeInteractivePrompt.questions[0].options.map((option: any) => option.label)).toEqual([
      '✊ 바위',
      '✌️  가위',
      '✋  보',
      'Type something.',
    ]);
    expect(adapter.statusCallback).toHaveBeenCalled();
  });

  it('emits assistant text from the screen body in getScriptParsedStatus', () => {
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);

    const parsed = adapter.getScriptParsedStatus();

    expect(parsed.status).toBe('idle');
    expect(parsed.messages).toEqual([expect.objectContaining({
      role: 'assistant',
      kind: 'standard',
      content: '안녕하세요! 가위바위보 한 판 해요.',
    })]);
  });
});
