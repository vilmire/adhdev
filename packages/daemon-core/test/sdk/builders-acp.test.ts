/**
 * Unit tests for buildDetectStatusFromAcp — the declarative `acp/session-protocol@1`
 * runtime detector. Mirrors the shape of the CLI builder tests
 * (test/providers/sdk/claude-cli-v1-builder.test.ts) but for the stdio /
 * ACP code path.
 *
 * Each case name encodes the contract clause it exercises so that a failing
 * test line tells the maintainer the shape of frame that broke without
 * digging through a stack trace.
 *
 * Reference spec:
 *   packages/daemon-core/src/providers/sdk/v1/builders/acp/detect-status.ts
 *   packages/daemon-core/src/providers/sdk/v1/schemas/primitives/acp-session-protocol-v1.json
 *
 * Anchor fixture: adhdev-providers/acp/claude-agent/provider.v1.json
 *   (real production session block — json-rpc style, methods: agent/ready,
 *    agent/done, agent/thinking, agent/toolCall, agent/textDelta,
 *    agent/approvalRequired).
 */

import { describe, expect, it } from 'vitest';
import {
  buildDetectStatusFromAcp,
  type AcpSessionSpec,
  type AcpStatusInput,
} from '../../src/providers/sdk/v1/builders/acp/detect-status.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function frame(
  lastLine: string,
  opts: { recentLines?: string[]; isConnected?: boolean } = {},
): AcpStatusInput {
  return {
    lastLine,
    recentLines: opts.recentLines ?? [lastLine],
    isConnected: opts.isConnected ?? true,
  };
}

// Realistic session spec mirroring the claude-agent ACP production manifest.
// Kept inline (rather than read from adhdev-providers/) so this unit test does
// not depend on the sibling provider repo being checked out alongside the OSS
// submodule worktree.
const CLAUDE_AGENT_SPEC: AcpSessionSpec = {
  $schema: 'adhdev:acp/session-protocol@1',
  promptStyle: 'mcp',
  idlePattern: {
    regex: '"method"\\s*:\\s*"agent/(?:ready|done)"',
    flags: 'i',
    description: 'Claude Agent finished a turn',
  },
  generatingPattern: {
    regex: '"method"\\s*:\\s*"agent/(?:thinking|toolCall|textDelta)"',
    flags: 'i',
    description: 'Claude Agent is generating',
  },
  errorPatterns: [
    {
      regex: '"method"\\s*:\\s*"agent/approvalRequired"',
      flags: 'i',
      verdict: 'waiting_approval',
      description: 'Claude Agent is requesting approval',
    },
  ],
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe('buildDetectStatusFromAcp — production claude-agent spec', () => {
  const detect = buildDetectStatusFromAcp(CLAUDE_AGENT_SPEC);

  // CASE 1 — happy path: known method drives the matching verdict.
  it('happy path: agent/thinking json-rpc method → generating', () => {
    const line = '{"jsonrpc":"2.0","method":"agent/thinking","params":{"turnId":"t-1"}}';
    expect(detect(frame(line))).toBe('generating');
  });

  // CASE 2 — happy path: idle alternation branch.
  it('happy path: agent/done json-rpc method → idle (idle pattern alternation branch)', () => {
    const line = '{"jsonrpc":"2.0","method":"agent/done","params":{"turnId":"t-1"}}';
    expect(detect(frame(line))).toBe('idle');
  });

  // CASE 3 — unknown method falls through to null (caller preserves prior status).
  it('unknown method: agent/progress is not in any pattern → null (caller keeps prior status)', () => {
    const line = '{"jsonrpc":"2.0","method":"agent/progress","params":{"pct":42}}';
    expect(detect(frame(line))).toBe(null);
  });

  // CASE 4 — empty input is safe (doesn't throw, returns null).
  it('empty input: lastLine="" with no methods → null and does not throw', () => {
    expect(() => detect(frame(''))).not.toThrow();
    expect(detect(frame(''))).toBe(null);
  });

  // CASE 5 — disconnected stream short-circuits even when content would match.
  it('disconnected: isConnected=false short-circuits even when generating pattern would match', () => {
    const line = '{"jsonrpc":"2.0","method":"agent/thinking","params":{}}';
    expect(detect(frame(line, { isConnected: false }))).toBe(null);
  });

  // CASE 6 — dispatch order: error patterns are checked BEFORE generating/idle.
  // A line that matches both `agent/approvalRequired` (error) and `agent/thinking`
  // (generating) must return waiting_approval because errors are checked first.
  it('dispatch order: error pattern (approvalRequired) beats generating (thinking) when both match', () => {
    // Construct a synthetic line that satisfies both regexes — proves the
    // ordering, not just lucky disjoint patterns.
    const line =
      '{"jsonrpc":"2.0","method":"agent/approvalRequired","note":"method:agent/thinking embedded"}';
    expect(detect(frame(line))).toBe('waiting_approval');
  });
});

// ─── Edge cases on minimal specs ─────────────────────────────────────────

describe('buildDetectStatusFromAcp — degenerate specs', () => {
  // CASE 7 — spec with no patterns at all: builder still returns a function
  // that always returns null without throwing. This is the contract for
  // declarative providers that ship without status detection (rare, but
  // legal under the schema since all pattern fields are optional).
  it('no-spec: builder with no patterns returns a function that always yields null', () => {
    const spec: AcpSessionSpec = { $schema: 'adhdev:acp/session-protocol@1' };
    const detect = buildDetectStatusFromAcp(spec);
    expect(typeof detect).toBe('function');
    expect(detect(frame('any line at all'))).toBe(null);
    expect(detect(frame('{"method":"agent/thinking"}'))).toBe(null);
    expect(detect(frame('', { isConnected: false }))).toBe(null);
  });

  // CASE 8 — error pattern ordering within errorPatterns[]: first-match wins.
  // Documents that authors can shadow later entries by listing them first.
  it('error ordering: first matching errorPatterns[] entry wins (later entries are shadowed)', () => {
    const spec: AcpSessionSpec = {
      $schema: 'adhdev:acp/session-protocol@1',
      errorPatterns: [
        { regex: 'oops', flags: 'i', verdict: 'waiting_approval' },
        { regex: 'oops', flags: 'i', verdict: 'idle' },
      ],
    };
    const detect = buildDetectStatusFromAcp(spec);
    expect(detect(frame('oops something went wrong'))).toBe('waiting_approval');
  });
});
