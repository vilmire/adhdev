import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  replayFixture,
  loadFixtureExpected,
  formatReplayReport,
} from '../../../src/providers/sdk/v1/fixture-tooling/index.js';
import type { CliProviderHandlers } from '../../../src/providers/sdk/v1/fixture-tooling/index.js';

function makeHandlers(overrides: Partial<CliProviderHandlers> = {}): CliProviderHandlers {
  return {
    detectStatus: () => null,
    parseApproval: () => null,
    parseSession: () => ({
      status: 'idle',
      modal: null,
      messages: [],
    }),
    ...overrides,
  };
}

function writeFixture(name: string, pty: string, expected: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-replay-'));
  const ptyPath = join(dir, `${name}.pty`);
  const expPath = join(dir, `${name}.expected.json`);
  writeFileSync(ptyPath, pty, 'utf-8');
  writeFileSync(expPath, JSON.stringify(expected), 'utf-8');
  return expPath;
}

describe('fixture replay runner', () => {
  it('rejects unsupported fixture versions', () => {
    const expPath = writeFixture('bad-version', 'irrelevant', {
      version: 2,
      providerType: 'stub-cli',
      ptyFile: 'bad-version.pty',
      anchors: [{ name: 'a', expect: {} }],
    });
    expect(() => loadFixtureExpected(expPath)).toThrow(/version 2 not supported/);
  });

  it('replays anchors in order using untilSentinel stop points', () => {
    const expPath = writeFixture(
      'sentinel',
      'Welcome to stub-agent\nstub> \n⠋ Thinking\n',
      {
        version: 1,
        providerType: 'stub-cli',
        ptyFile: 'sentinel.pty',
        anchors: [
          {
            name: 'splash',
            untilSentinel: 'Welcome to stub-agent',
            expect: { detectStatus: 'idle' },
          },
          {
            name: 'spinner',
            untilSentinel: '⠋ Thinking',
            expect: { detectStatus: 'generating' },
          },
        ],
      },
    );
    const result = replayFixture(
      expPath,
      makeHandlers({
        detectStatus: (input) =>
          /⠋ Thinking/.test(input.screenText) ? 'generating' : 'idle',
      }),
    );
    expect(result.overallPasses).toBe(true);
    expect(result.perAnchor).toHaveLength(2);
    expect(result.perAnchor[0].anchor.name).toBe('splash');
  });

  it('reports diffs when handlers disagree with expectations', () => {
    const expPath = writeFixture(
      'mismatch',
      'stub> ready\n',
      {
        version: 1,
        providerType: 'stub-cli',
        ptyFile: 'mismatch.pty',
        anchors: [
          {
            name: 'whole file',
            expect: { detectStatus: 'generating' },
          },
        ],
      },
    );
    const result = replayFixture(expPath, makeHandlers());
    expect(result.overallPasses).toBe(false);
    expect(result.perAnchor[0].diffs[0]).toMatch(/detectStatus/);
    expect(formatReplayReport(result)).toMatch(/OVERALL: FAIL/);
  });

  it('produces a passing report when everything matches', () => {
    const expPath = writeFixture(
      'happy',
      'stub> hi\n',
      {
        version: 1,
        providerType: 'stub-cli',
        ptyFile: 'happy.pty',
        anchors: [
          {
            name: 'whole file',
            expect: { detectStatus: 'idle', parseApproval: null },
          },
        ],
      },
    );
    const result = replayFixture(expPath, makeHandlers({ detectStatus: () => 'idle' }));
    expect(result.overallPasses).toBe(true);
    expect(formatReplayReport(result)).toMatch(/OVERALL: PASS/);
  });
});
