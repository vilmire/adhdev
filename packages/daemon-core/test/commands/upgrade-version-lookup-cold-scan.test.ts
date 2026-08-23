import { describe, it, expect } from 'vitest';
import { resolveNpmPublishedVersion } from '../../src/commands/upgrade-helper.js';

/**
 * Regression: the daemon-side upgrade died on the VERSION LOOKUP, before
 * `npm install` was ever reached, on Windows machines running Microsoft
 * Defender with no exclusions.
 *
 * The lookup spawns a portable `node.exe` + `npm-cli.js`, which the on-access
 * scanner reads end-to-end the first time they execute. Measured on the
 * affected machine: cold 10,897ms vs warm 758ms — so the fixed 10s timeout
 * fires on exactly the first attempt after an install and never afterwards.
 *
 * These tests pin the resolution (retry a timeout, because the warm spawn is
 * fast) and, just as importantly, the three ways that fix could over-correct:
 * slowing the warm path, retrying real failures, or retrying forever.
 */

/** Shape of the error Node throws when it kills a child for exceeding `timeout`. */
function timeoutError(): Error & { code: string; signal: string; status: null } {
  return Object.assign(new Error('spawnSync npm ETIMEDOUT'), {
    code: 'ETIMEDOUT',
    signal: 'SIGTERM',
    status: null,
  });
}

/** Shape of a child that RAN and failed on its own (404 / auth / offline). */
function realFailure(message: string): Error & { status: number; code: undefined } {
  return Object.assign(new Error(message), { status: 1, code: undefined });
}

describe('resolveNpmPublishedVersion — cold-scan resilience', () => {
  it('recovers when the first spawn is killed by the cold-scan timeout', () => {
    // Cold spawn exceeds the 10s timeout; the warm spawn returns immediately —
    // the exact 10,897ms → 758ms transition measured in the field.
    const calls: number[] = [];
    let attempt = 0;
    const version = resolveNpmPublishedVersion('adhdev', 'next', undefined, {
      execFileSync: (_file, _args, options) => {
        attempt += 1;
        calls.push(options.timeout as number);
        if (attempt === 1) throw timeoutError();
        return '1.0.58-rc.6\n';
      },
    });

    expect(version).toBe('1.0.58-rc.6');
    expect(attempt).toBe(2);
    // The retry must not quietly widen the timeout — the warm spawn is fast, so
    // the same bound still applies. (Raising it was the rejected alternative.)
    expect(calls).toEqual([10_000, 10_000]);
  });

  it('surfaces the retry instead of silently making a failure look like a success', () => {
    const seen: Array<{ attempt: number; attempts: number; timeoutMs: number }> = [];
    let attempt = 0;
    resolveNpmPublishedVersion('adhdev', 'next', undefined, {
      onRetry: ({ attempt: n, attempts, timeoutMs }) => seen.push({ attempt: n, attempts, timeoutMs }),
      execFileSync: () => {
        attempt += 1;
        if (attempt === 1) throw timeoutError();
        return '1.2.3\n';
      },
    });

    expect(seen).toEqual([{ attempt: 1, attempts: 3, timeoutMs: 10_000 }]);
  });

  it('still resolves when the scan is slow enough to burn two attempts', () => {
    let attempt = 0;
    const version = resolveNpmPublishedVersion('adhdev', 'next', undefined, {
      execFileSync: () => {
        attempt += 1;
        if (attempt < 3) throw timeoutError();
        return '9.9.9\n';
      },
    });

    expect(version).toBe('9.9.9');
    expect(attempt).toBe(3);
  });

  it('treats a SIGTERM kill with no exit status as a timeout', () => {
    // Defensive: `killSignal` is caller-overridable, so the signal shape is
    // recognized even when `code` is not the documented ETIMEDOUT.
    let attempt = 0;
    const version = resolveNpmPublishedVersion('adhdev', 'next', undefined, {
      execFileSync: () => {
        attempt += 1;
        if (attempt === 1) {
          throw Object.assign(new Error('killed'), { signal: 'SIGKILL', status: null, code: undefined });
        }
        return '2.0.0\n';
      },
    });

    expect(version).toBe('2.0.0');
    expect(attempt).toBe(2);
  });
});

describe('resolveNpmPublishedVersion — over-correction guards', () => {
  it('GUARD 1: the warm path spawns exactly once and is not slowed by the retry', () => {
    let attempt = 0;
    const version = resolveNpmPublishedVersion('adhdev', 'next', undefined, {
      execFileSync: () => {
        attempt += 1;
        return '1.0.58-rc.6\n';
      },
    });

    expect(version).toBe('1.0.58-rc.6');
    // A retry that ran on every call would double every healthy upgrade check.
    expect(attempt).toBe(1);
  });

  it('GUARD 2: a real registry failure still fails, on the FIRST attempt', () => {
    let attempt = 0;
    expect(() => resolveNpmPublishedVersion('adhdev', '99.99.99', undefined, {
      execFileSync: () => {
        attempt += 1;
        throw realFailure('npm ERR! 404 Not Found');
      },
    })).toThrow(/404/);

    // Retrying a 404 would turn a fast, correct failure into a 3x-slower one
    // and could mask a genuinely dead registry as a timeout.
    expect(attempt).toBe(1);
  });

  it('GUARD 2b: an offline/DNS failure is not retried either', () => {
    let attempt = 0;
    expect(() => resolveNpmPublishedVersion('adhdev', 'next', undefined, {
      execFileSync: () => {
        attempt += 1;
        throw Object.assign(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'), {
          code: 'ENOTFOUND',
          status: 1,
        });
      },
    })).toThrow(/ENOTFOUND/);

    expect(attempt).toBe(1);
  });

  it('GUARD 3: retries are bounded — a persistent timeout eventually throws', () => {
    let attempt = 0;
    expect(() => resolveNpmPublishedVersion('adhdev', 'next', undefined, {
      execFileSync: () => {
        attempt += 1;
        throw timeoutError();
      },
    })).toThrow(/ETIMEDOUT/);

    // 1 initial attempt + 2 retries. Never unbounded.
    expect(attempt).toBe(3);
  });

  it('GUARD 3b: the interactive no-timeout caller never retries', () => {
    // `adhdev update` opts out of the timeout, so its spawn can never be killed
    // for slowness — a cold scan just makes it wait once and succeed. Retrying
    // there would only multiply a real error.
    let attempt = 0;
    expect(() => resolveNpmPublishedVersion('adhdev', 'next', undefined, {
      timeout: undefined,
      execFileSync: () => {
        attempt += 1;
        throw timeoutError();
      },
    })).toThrow();

    expect(attempt).toBe(1);
  });

  it('honors an explicit timeoutRetries: 0 opt-out', () => {
    let attempt = 0;
    expect(() => resolveNpmPublishedVersion('adhdev', 'next', undefined, {
      timeoutRetries: 0,
      execFileSync: () => {
        attempt += 1;
        throw timeoutError();
      },
    })).toThrow(/ETIMEDOUT/);

    expect(attempt).toBe(1);
  });

  it('preserves the exact argv and piped stdio across retries', () => {
    // The mandatory-update path depends on both: the argv is asserted by its own
    // tests, and piped stdio keeps npm's stderr off the daemon console. A retry
    // that rebuilt options differently would regress either one.
    const observed: Array<{ file: string; args: readonly string[]; stdio: unknown }> = [];
    let attempt = 0;
    resolveNpmPublishedVersion(
      'adhdev',
      '1.0.58-rc.6',
      { npmExecutable: 'C:\\node\\node.exe', npmArgsPrefix: ['C:\\node\\npm-cli.js'], execOptions: { shell: false } },
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        execFileSync: (file, args, options) => {
          attempt += 1;
          observed.push({ file, args, stdio: options.stdio });
          if (attempt === 1) throw timeoutError();
          return '1.0.58-rc.6\n';
        },
      },
    );

    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual(observed[1]);
    expect(observed[0].file).toBe('C:\\node\\node.exe');
    expect(observed[0].args).toEqual([
      'C:\\node\\npm-cli.js',
      'view',
      'adhdev@1.0.58-rc.6',
      'version',
    ]);
    expect(observed[0].stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });
});
