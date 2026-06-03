/**
 * Tests for buildDetectStatusFromAcp.
 *
 * Covers the 6 required scenarios:
 *   1. Idle pattern match → 'idle'
 *   2. Generating pattern match → 'generating'
 *   3. Error pattern match → declared verdict
 *   4. No pattern matches → null
 *   5. Disconnected input → null (regardless of line content)
 *   6. Regex flag handling (g/i flags compile correctly)
 *
 * Additional edge cases: error pattern verdict routing, multi-pattern
 * priority ordering, and invalid-regex error propagation.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDetectStatusFromAcp,
  type AcpSessionSpec,
  type AcpStatusInput,
} from '../../../src/providers/sdk/v1/builders/acp/detect-status.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function input(
  lastLine: string,
  opts: { recentLines?: string[]; isConnected?: boolean } = {},
): AcpStatusInput {
  return {
    lastLine,
    recentLines: opts.recentLines ?? [lastLine],
    isConnected: opts.isConnected ?? true,
  };
}

// ─── Basic plain-text spec ────────────────────────────────────────────────

describe('buildDetectStatusFromAcp — plain-text spec', () => {
  const spec: AcpSessionSpec = {
    $schema: 'adhdev:acp/session-protocol@1',
    promptStyle: 'plain-text',
    idlePattern: { regex: 'agent ready', flags: 'i' },
    generatingPattern: { regex: 'thinking|processing', flags: 'i' },
    errorPatterns: [
      {
        regex: 'approval required',
        flags: 'i',
        verdict: 'waiting_approval',
        description: 'Agent is requesting user approval',
      },
      {
        regex: 'fatal error|crash',
        flags: 'i',
        verdict: 'idle',
        description: 'Unrecoverable — treat as idle so user can retry',
      },
    ],
  };

  const detect = buildDetectStatusFromAcp(spec);

  // Test 1: idle pattern match
  it('returns idle when the idle pattern matches lastLine', () => {
    expect(detect(input('Agent Ready. Awaiting input.'))).toBe('idle');
  });

  // Test 2: generating pattern match
  it('returns generating when the generating pattern matches lastLine', () => {
    expect(detect(input('Thinking about your request...'))).toBe('generating');
  });

  it('returns generating for alternative generating keyword', () => {
    expect(detect(input('Processing tool call: read_file'))).toBe('generating');
  });

  // Test 3: error pattern match with declared verdict
  it('returns waiting_approval when an approval-required error pattern fires', () => {
    expect(detect(input('Approval required: run bash command?'))).toBe('waiting_approval');
  });

  it('returns idle when a fatal-error pattern fires (verdict: idle)', () => {
    expect(detect(input('Fatal error: out of context window'))).toBe('idle');
  });

  // Test 4: no match → null
  it('returns null when no pattern matches the lastLine', () => {
    expect(detect(input('Some intermediate stdout line with no signal'))).toBe(null);
  });

  it('returns null for an empty last line', () => {
    expect(detect(input(''))).toBe(null);
  });

  // Test 5: disconnected → null
  it('returns null when isConnected is false regardless of matching content', () => {
    expect(detect(input('Agent Ready. Awaiting input.', { isConnected: false }))).toBe(null);
  });

  it('returns null when isConnected is false even if generating pattern would match', () => {
    expect(detect(input('Thinking...', { isConnected: false }))).toBe(null);
  });

  // Error pattern priority: errors are checked before generating/idle
  it('error patterns take priority over generating pattern', () => {
    // A line that could match both generating and approval error — error wins
    const line = 'Thinking — approval required before proceeding';
    expect(detect(input(line))).toBe('waiting_approval');
  });
});

// ─── Test 6: regex flag handling ─────────────────────────────────────────

describe('buildDetectStatusFromAcp — regex flag handling', () => {
  it('respects case-insensitive flag (i) for idle pattern', () => {
    const spec: AcpSessionSpec = {
      idlePattern: { regex: 'READY', flags: 'i' },
    };
    const detect = buildDetectStatusFromAcp(spec);
    expect(detect(input('ready for next prompt'))).toBe('idle');
    expect(detect(input('READY'))).toBe('idle');
    expect(detect(input('Ready'))).toBe('idle');
  });

  it('without i flag, pattern match is case-sensitive', () => {
    const spec: AcpSessionSpec = {
      idlePattern: { regex: 'READY', flags: '' },
    };
    const detect = buildDetectStatusFromAcp(spec);
    // Only exact uppercase match fires
    expect(detect(input('READY'))).toBe('idle');
    // Lowercase does NOT fire
    expect(detect(input('ready'))).toBe(null);
  });

  it('handles global flag (g) on generating pattern without infinite-loop', () => {
    const spec: AcpSessionSpec = {
      generatingPattern: { regex: 'tool', flags: 'gi' },
    };
    const detect = buildDetectStatusFromAcp(spec);
    // Should match and return without hanging
    expect(detect(input('calling tool: list_files'))).toBe('generating');
    // A second call must also work (global regex lastIndex reset check)
    expect(detect(input('calling tool: write_file'))).toBe('generating');
  });

  it('handles multiline flag (m) on idle pattern', () => {
    const spec: AcpSessionSpec = {
      // Anchored with ^ in multiline mode — matches line start inside lastLine
      idlePattern: { regex: '^ready$', flags: 'mi' },
    };
    const detect = buildDetectStatusFromAcp(spec);
    expect(detect(input('ready'))).toBe('idle');
    // In multiline mode, ^ matches after \n inside a string
    expect(detect(input('output\nready'))).toBe('idle');
  });

  it('throws a descriptive error for an invalid regex in idle pattern', () => {
    const spec: AcpSessionSpec = {
      idlePattern: { regex: '(unclosed' },
    };
    expect(() => buildDetectStatusFromAcp(spec)).toThrowError(/Invalid regex/);
  });

  it('throws a descriptive error for an invalid regex in error patterns', () => {
    const spec: AcpSessionSpec = {
      errorPatterns: [{ regex: '[bad', verdict: 'idle' }],
    };
    expect(() => buildDetectStatusFromAcp(spec)).toThrowError(/Invalid regex/);
  });
});

// ─── JSON-RPC style spec ─────────────────────────────────────────────────

describe('buildDetectStatusFromAcp — json-rpc spec', () => {
  const spec: AcpSessionSpec = {
    $schema: 'adhdev:acp/session-protocol@1',
    promptStyle: 'json-rpc',
    idlePattern: { regex: '"method"\\s*:\\s*"agent/ready"' },
    generatingPattern: { regex: '"method"\\s*:\\s*"agent/(?:thinking|toolCall)"' },
    errorPatterns: [
      {
        regex: '"method"\\s*:\\s*"agent/approvalRequired"',
        verdict: 'waiting_approval',
      },
    ],
  };

  const detect = buildDetectStatusFromAcp(spec);

  it('returns idle on agent/ready json-rpc line', () => {
    expect(detect(input('{"jsonrpc":"2.0","method":"agent/ready","params":{}}'))).toBe('idle');
  });

  it('returns generating on agent/thinking json-rpc line', () => {
    expect(detect(input('{"jsonrpc":"2.0","method":"agent/thinking","params":{}}'))).toBe('generating');
  });

  it('returns generating on agent/toolCall json-rpc line', () => {
    expect(detect(input('{"jsonrpc":"2.0","method":"agent/toolCall","params":{}}'))).toBe('generating');
  });

  it('returns waiting_approval on agent/approvalRequired json-rpc line', () => {
    expect(detect(input('{"jsonrpc":"2.0","method":"agent/approvalRequired","params":{}}'))).toBe(
      'waiting_approval',
    );
  });

  it('returns null for unrecognised json-rpc method', () => {
    expect(detect(input('{"jsonrpc":"2.0","method":"agent/progress","params":{}}'))).toBe(null);
  });
});

// ─── Spec with no patterns ────────────────────────────────────────────────

describe('buildDetectStatusFromAcp — minimal spec (no patterns defined)', () => {
  const spec: AcpSessionSpec = {
    $schema: 'adhdev:acp/session-protocol@1',
  };

  const detect = buildDetectStatusFromAcp(spec);

  it('always returns null when no patterns are defined (connected)', () => {
    expect(detect(input('anything at all'))).toBe(null);
  });

  it('always returns null when no patterns are defined (disconnected)', () => {
    expect(detect(input('anything at all', { isConnected: false }))).toBe(null);
  });
});
