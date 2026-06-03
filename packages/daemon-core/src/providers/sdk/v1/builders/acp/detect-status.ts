/**
 * buildDetectStatusFromAcp
 *
 * Turns a declarative `acp/session-protocol@1` block into a runtime
 * `(input: AcpStatusInput) => 'idle' | 'generating' | 'waiting_approval' | null`
 * function.
 *
 * Dispatch order:
 *   1. Not connected → null (no information available).
 *   2. Error patterns — checked first; first match returns the declared verdict.
 *   3. Generating pattern — `generating`.
 *   4. Idle pattern — `idle`.
 *   5. Default: `null` (no change — caller preserves last known status).
 *
 * All regex patterns are compiled once at builder time so the returned
 * detector function is allocation-free on the hot path.
 */

// ─── Spec shapes (mirror the JSON schema) ──────────────────────────────

interface AcpRegexPatternSpec {
  regex: string;
  flags?: string;
  description?: string;
}

interface AcpErrorPatternSpec extends AcpRegexPatternSpec {
  verdict: 'idle' | 'generating' | 'waiting_approval';
}

export interface AcpSessionSpec {
  $schema?: 'adhdev:acp/session-protocol@1';
  /** Pattern that matches a line emitted when the agent is idle/ready. */
  idlePattern?: AcpRegexPatternSpec;
  /** Pattern that matches a line emitted while the agent is actively working. */
  generatingPattern?: AcpRegexPatternSpec;
  /**
   * Error/edge-case patterns. Checked in order; first match returns the
   * declared verdict. Useful for approval prompts, fatal errors, etc.
   */
  errorPatterns?: AcpErrorPatternSpec[];
  /** Wire format; informational only at the builder level — regex matching
   *  is identical regardless of promptStyle. */
  promptStyle?: 'json-rpc' | 'plain-text' | 'mcp';
  /** Message delimiter used to split incoming bytes (default: newline). */
  messageDelimiter?: string;
}

// ─── Input shape ────────────────────────────────────────────────────────

export interface AcpStatusInput {
  /** The most recently received line from the stdio stream. */
  lastLine: string;
  /**
   * A sliding window of recent output lines (newest last).
   * Builders may check these when a single line is not enough for context.
   */
  recentLines: string[];
  /** Whether the ACP process is currently connected and running. */
  isConnected: boolean;
}

// ─── Output type ────────────────────────────────────────────────────────

export type AcpDetectedStatus = 'idle' | 'generating' | 'waiting_approval' | null;

// ─── Helpers ────────────────────────────────────────────────────────────

function compile(re: string, flags?: string): RegExp {
  try {
    return new RegExp(re, flags ?? 'i');
  } catch (e) {
    throw new Error(`Invalid regex /${re}/${flags ?? 'i'}: ${(e as Error).message}`);
  }
}

/**
 * Safe `.test()` wrapper: resets `lastIndex` before each call so that
 * regexes compiled with the `g` or `y` flag remain stateless across
 * multiple detect invocations.
 */
function testRe(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

// ─── Compiled internal representation ───────────────────────────────────

interface CompiledAcpSpec {
  idle: RegExp | null;
  generating: RegExp | null;
  errors: Array<{ re: RegExp; verdict: AcpDetectedStatus }>;
}

function compileSpec(spec: AcpSessionSpec): CompiledAcpSpec {
  const idle = spec.idlePattern
    ? compile(spec.idlePattern.regex, spec.idlePattern.flags)
    : null;

  const generating = spec.generatingPattern
    ? compile(spec.generatingPattern.regex, spec.generatingPattern.flags)
    : null;

  const errors = (spec.errorPatterns ?? []).map((ep) => ({
    re: compile(ep.regex, ep.flags),
    verdict: ep.verdict as AcpDetectedStatus,
  }));

  return { idle, generating, errors };
}

// ─── Public builder ─────────────────────────────────────────────────────

export function buildDetectStatusFromAcp(
  spec: AcpSessionSpec,
): (input: AcpStatusInput) => AcpDetectedStatus {
  const compiled = compileSpec(spec);

  return function detectAcpStatus(input: AcpStatusInput): AcpDetectedStatus {
    // 1. No connection → no information.
    if (!input.isConnected) return null;

    const line = input.lastLine;

    // 2. Error/edge-case patterns take priority.
    for (const { re, verdict } of compiled.errors) {
      if (testRe(re, line)) return verdict;
    }

    // 3. Generating pattern.
    if (compiled.generating && testRe(compiled.generating, line)) return 'generating';

    // 4. Idle pattern.
    if (compiled.idle && testRe(compiled.idle, line)) return 'idle';

    // 5. Nothing matched.
    return null;
  };
}

// Internal exports for builder reuse + tests.
export const __internal = {
  compileSpec,
};
