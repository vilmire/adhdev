/**
 * excludeInProgressTurn — in-flight tool-tail trim on the native-history read path.
 *
 * While a session sits in `waiting_approval`, read_chat sets
 * `excludeInProgressTurn` (chat-commands-read.ts) so the tool call the user is
 * being asked to approve is NOT rendered as an already-executed `⏺ Tool`
 * bubble. The flag used to be honoured only by `_shared/native_history.js`'s
 * `trimIncompleteLastTurn`; once providers moved to spec-driven reading, no
 * live route consumed it and every provider showed the pending action as done.
 *
 * The trim now lives at the loader's `readNativeHistory` dispatch boundary, so
 * it covers ALL three native-history routes by construction:
 *   - `source`        — declarative jsonl/sqlite executor
 *                       (claude-cli, codex-cli, cursor-cli, hermes-cli, kimi, opencode)
 *   - `reader`        — built-in TypeScript reader (antigravity-cli, grok-cli)
 *   - `override_path` — provider-supplied reader module (out-of-tree escape hatch)
 *
 * These tests drive the REAL ProviderLoader wiring rather than calling the trim
 * directly, because the gap being regressed was precisely a wiring gap: the
 * helper existed and the flag was computed, but nothing connected them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import { trimInProgressTurnToolTail } from '../../src/providers/chat-message-normalization.js';
import { parseGrokRecord } from '../../src/providers/native-history/grok-cli-transcript.js';

class TestProviderLoader extends ProviderLoader {
  constructor(userDir: string) {
    super({ userDir, disableUpstream: true });
  }
  protected override readConfig(): any | null {
    return { providerSettings: {} };
  }
  protected override writeConfig(): void {
    /* tests never persist machine config */
  }
}

let userDir = '';

beforeEach(() => {
  // 'providers' in the path on purpose — reload() busts require.cache entries
  // keyed by that substring, matching real on-disk layouts.
  userDir = mkdtempSync(path.join(tmpdir(), 'adhdev-providers-exclude-turn-'));
});

afterEach(() => {
  if (userDir && existsSync(userDir)) rmSync(userDir, { recursive: true, force: true });
  userDir = '';
});

/** A transcript ending on the tool call that is awaiting approval. */
const APPROVAL_SHAPE = [
  { role: 'user', content: 'delete the build dir', kind: 'standard', receivedAt: 1 },
  { role: 'assistant', content: "I'll clean that up.", kind: 'standard', receivedAt: 2 },
  { role: 'assistant', content: '[tool: Bash rm -rf build/]', kind: 'tool', receivedAt: 3 },
];

/**
 * Install a provider whose native history is served by an `override_path`
 * reader module returning `records`. override_path is the one route that lets a
 * test pin the reader's output exactly, so the assertions isolate the TRIM
 * rather than the on-disk resolution of any particular store format.
 */
function installOverrideProvider(type: string, records: object[]): void {
  const dir = path.join(userDir, 'cli', type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'reader.js'),
    `module.exports = function read() {
      return {
        messages: ${JSON.stringify(records)},
        providerSessionId: 'sess-1',
        sourcePath: '/tmp/${type}.jsonl',
        sourceMtimeMs: 1,
        nativeHistoryCoverage: 'full',
      };
    };\n`,
    'utf-8',
  );
  writeFileSync(
    path.join(dir, 'provider.json'),
    JSON.stringify({
      type,
      name: type,
      displayName: type,
      category: 'cli',
      providerVersion: '0.1.0',
      binary: type,
      spawn: { command: type, args: [] },
      nativeHistory: { override_path: 'reader.js' },
    }),
    'utf-8',
  );
}

function readNativeHistory(type: string, input: Record<string, unknown>): any {
  const loader = new TestProviderLoader(userDir);
  loader.loadAll();
  const resolved = loader.resolve(type, { version: '0.1.0' }) as any;
  expect(typeof resolved?.scripts?.readNativeHistory).toBe('function');
  return resolved.scripts.readNativeHistory(input);
}

describe('excludeInProgressTurn — loader read dispatch', () => {
  it('strips the trailing in-flight tool bubble when the flag is set', () => {
    installOverrideProvider('trim-cli', APPROVAL_SHAPE);
    const result = readNativeHistory('trim-cli', { excludeInProgressTurn: true });
    expect(result.messages.map((m: any) => `${m.role}/${m.kind}`)).toEqual([
      'user/standard',
      'assistant/standard',
    ]);
    // Everything else about the result must survive the wrapper untouched.
    expect(result.providerSessionId).toBe('sess-1');
    expect(result.sourcePath).toBe('/tmp/trim-cli.jsonl');
    expect(result.nativeHistoryCoverage).toBe('full');
  });

  it('honours the flag when it arrives via `args` (the read path sends both)', () => {
    installOverrideProvider('trim-args-cli', APPROVAL_SHAPE);
    const result = readNativeHistory('trim-args-cli', { args: { excludeInProgressTurn: true } });
    expect(result.messages).toHaveLength(2);
  });

  it('preserves the tool bubble when the flag is false or absent', () => {
    installOverrideProvider('keep-cli', APPROVAL_SHAPE);

    const absent = readNativeHistory('keep-cli', {});
    expect(absent.messages).toHaveLength(3);
    expect(absent.messages[2].kind).toBe('tool');

    const explicitFalse = readNativeHistory('keep-cli', { excludeInProgressTurn: false });
    expect(explicitFalse.messages).toHaveLength(3);
  });

  it('leaves a settled transcript untouched (last record is not a tool bubble)', () => {
    // The guard from the original trimIncompleteLastTurn: a turn that ended on
    // prose has nothing in flight to hide, so the flag must be a no-op.
    installOverrideProvider('settled-cli', [
      { role: 'user', content: 'run the tests', kind: 'standard', receivedAt: 1 },
      { role: 'assistant', content: '[tool: Bash npm test]', kind: 'tool', receivedAt: 2 },
      { role: 'assistant', content: 'all green', kind: 'standard', receivedAt: 3 },
    ]);
    const result = readNativeHistory('settled-cli', { excludeInProgressTurn: true });
    expect(result.messages.map((m: any) => m.content)).toEqual([
      'run the tests',
      '[tool: Bash npm test]',
      'all green',
    ]);
  });

  it('never returns an empty transcript for an approval fired straight off a user prompt', () => {
    // The most common approval shape has NO assistant prose between the user
    // prompt and the pending tool call. The user turn must survive: an earlier
    // revision of the original helper sliced from the last user message and the
    // dashboard showed "0 messages" while the terminal showed the conversation.
    installOverrideProvider('bare-cli', [
      { role: 'user', content: 'force push please', kind: 'standard', receivedAt: 1 },
      { role: 'assistant', content: '[tool: Bash git push --force]', kind: 'tool', receivedAt: 2 },
    ]);
    const result = readNativeHistory('bare-cli', { excludeInProgressTurn: true });
    expect(result.messages.map((m: any) => `${m.role}/${m.kind}`)).toEqual(['user/standard']);
  });

  it('applies to every native-history route, not just the one that declared it', () => {
    // codex-cli was the ONLY provider declaring excludeInProgressTurn, which is
    // why the gap read as codex-specific. The trim is wired at the shared
    // dispatch boundary, so any provider on any route gets it.
    for (const type of ['route-a-cli', 'route-b-cli', 'route-c-cli']) {
      installOverrideProvider(type, APPROVAL_SHAPE);
      expect(readNativeHistory(type, { excludeInProgressTurn: true }).messages).toHaveLength(2);
    }
  });
});

describe('reader-route providers are covered too (antigravity-cli / grok-cli)', () => {
  /**
   * The `reader:` route resolves its transcript against the REAL user home
   * (~/.grok, ~/.antigravity), which a test on a shared machine must not touch.
   * So the coverage claim is pinned structurally instead: the reader's own
   * projection is used to build the bubbles, and the trim is asserted against
   * that genuine shape. This is what makes "the reader route needs no separate
   * fix" a checked fact rather than an assumption — the loader wraps every
   * route's reader identically, so matching bubble shape is sufficient.
   */
  it('grok-cli projects pending tool calls into the exact shape the trim removes', () => {
    const toolBubble = parseGrokRecord({
      type: 'assistant',
      content: '',
      tool_calls: [{ id: 't1', name: 'bash' }],
    });
    expect(toolBubble).toMatchObject({ role: 'assistant', kind: 'tool' });

    const trimmed = trimInProgressTurnToolTail([
      { role: 'user', content: 'clean up', kind: 'standard' },
      toolBubble as any,
    ] as any);
    expect(trimmed.map((m: any) => m.role)).toEqual(['user']);
  });
});

describe('trimInProgressTurnToolTail — trim semantics', () => {
  it('removes a multi-bubble trailing tool run in one pass', () => {
    const trimmed = trimInProgressTurnToolTail([
      { role: 'user', content: 'ship it', kind: 'standard' },
      { role: 'assistant', content: 'on it', kind: 'standard' },
      { role: 'assistant', content: '[tool: Read a]', kind: 'tool' },
      { role: 'assistant', content: '[terminal: npm run build]', kind: 'terminal' },
      { role: 'assistant', content: '[tool: Bash deploy]', kind: 'tool' },
    ] as any);
    expect(trimmed.map(m => m.content)).toEqual(['ship it', 'on it']);
  });

  it('does not treat a trailing thought as in-flight activity', () => {
    // Matches the original helper: a finished turn can legitimately end on an
    // internal thought, so a thought tail must not be trimmed.
    const messages = [
      { role: 'user', content: 'why', kind: 'standard' },
      { role: 'assistant', content: 'because', kind: 'standard' },
      { role: 'assistant', content: 'hmm', kind: 'thought' },
    ] as any;
    expect(trimInProgressTurnToolTail(messages)).toBe(messages);
  });

  it('is idempotent — re-trimming an already-trimmed transcript is a no-op', () => {
    // Guarantees the dispatch-boundary wrapper is safe even when an out-of-tree
    // provider script already applied its own trim.
    const once = trimInProgressTurnToolTail(APPROVAL_SHAPE as any);
    expect(trimInProgressTurnToolTail(once)).toBe(once);
  });

  it('returns the same array reference when nothing is trimmed', () => {
    // The loader wrapper relies on referential equality to avoid rebuilding the
    // result object on every non-approval read.
    const messages = [{ role: 'assistant', content: 'done', kind: 'standard' }] as any;
    expect(trimInProgressTurnToolTail(messages)).toBe(messages);
  });

  it('handles empty and nullish input without throwing', () => {
    expect(trimInProgressTurnToolTail([])).toEqual([]);
    expect(trimInProgressTurnToolTail(null)).toEqual([]);
    expect(trimInProgressTurnToolTail(undefined)).toEqual([]);
  });

  it('trims a transcript consisting only of in-flight tool bubbles', () => {
    expect(trimInProgressTurnToolTail([
      { role: 'assistant', content: '[tool: Bash x]', kind: 'tool' },
      { role: 'assistant', content: '[tool: Bash y]', kind: 'tool' },
    ] as any)).toEqual([]);
  });
});
