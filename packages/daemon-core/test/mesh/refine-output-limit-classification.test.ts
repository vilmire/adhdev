/**
 * Regression suite: an output-budget kill must NOT be reported as
 * `missing_dependencies`.
 *
 * Refinery runs each validation command through execFile with
 * maxBuffer = REFINE_VALIDATION_OUTPUT_LIMIT_BYTES. When a command's output
 * exceeds that, Node KILLS the child and rejects with
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER — carrying `code === 1` even though the
 * command was on its way to exit 0. The gate then classified the failure by
 * regex-matching the captured stderr against
 * /Cannot find module|MODULE_NOT_FOUND|node_modules|.../, and EVERY vitest/tsc
 * stack frame contains "node_modules" — so a buffer kill was reported as
 * `missing_dependencies`.
 *
 * That misdiagnosis is expensive: it sent a full investigation after an absent
 * packages/server/node_modules (which is just normal npm hoisting) and an
 * uninitialized local D1 (which those tests never touch — they build an
 * in-memory SQLite from the migration files). Measured: running `db:init` left
 * the error count and stderr byte size byte-for-byte identical.
 *
 * The whole value of the fix is that the FAILURE GETS THE RIGHT NAME, so that
 * is what these tests pin — in BOTH directions:
 *   1. output-budget kill      -> output_limit_exceeded
 *   2. genuine missing module  -> missing_dependencies  (must NOT regress)
 * Testing only (1) would just move the misclassification to the other side.
 *
 * Judged on structured values (error codes, the classifier's boolean outcome,
 * the terminal-kind mapping) and on real spawn EXIT BEHAVIOR — never on log
 * text. A prior gate in this repo was defeated by output-string matching when a
 * `[08:05:...]` log prefix collided with a JSON `[`.
 */

import { describe, it, expect } from 'vitest';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyValidationFailure } from '../../src/mesh/mesh-refine-gates.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const gatesSrc = readFileSync(
  path.resolve(here, '../../src/mesh/mesh-refine-gates.ts'),
  'utf8',
);
const routerSrc = readFileSync(
  path.resolve(here, '../../src/commands/router-refine.ts'),
  'utf8',
);

/**
 * The REAL production classifier — imported, not mirrored. An earlier draft of
 * this suite copied the logic locally and stayed green when the production guard
 * was deleted, which is precisely the vacuum-test failure mode this repo has been
 * bitten by. Importing binds the assertions to shipped behavior.
 */
function classify(error: { code?: unknown; message?: string; stderr?: string }) {
  return classifyValidationFailure(error, error.stderr || error.message || '', false);
}

describe('refine validation failure classification', () => {
  it('a real maxBuffer overflow kills the child and yields code===1 (the trap)', async () => {
    // Not a synthetic error object: this is the actual Node behavior the gate sees.
    // The child stays alive after writing, so the overflow kill wins the race —
    // a child that exits immediately can slip through with silent truncation.
    let caught: any;
    try {
      await execFileAsync(
        process.execPath,
        [
          '-e',
          'process.stderr.write("at /repo/node_modules/vitest/dist/x.js:1:1\\n".repeat(6000)); setTimeout(() => process.exit(0), 3000)',
        ],
        { encoding: 'utf8', maxBuffer: 128 * 1024 },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught, 'overflow must reject, not resolve').toBeTruthy();
    expect(caught.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    // The trap in one line: the captured stderr DOES contain "node_modules",
    // which is exactly why the old heuristic mislabeled this.
    expect(/node_modules/.test(caught.stderr || '')).toBe(true);
  });

  it('classifies an output-budget kill as output_limit_exceeded, not missing_dependencies', () => {
    const verdict = classify({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      message: 'stdout maxBuffer length exceeded',
      stderr: 'at Object.<anonymous> (/repo/node_modules/vitest/dist/index.js:5:21)',
    });
    expect(verdict.outputLimitExceeded).toBe(true);
    expect(verdict.missingDependencyFailure).toBe(false);
  });

  it('still classifies a GENUINE missing module as missing_dependencies (no reverse regression)', () => {
    const verdict = classify({
      code: 1,
      message: 'Command failed',
      stderr: "Error: Cannot find module 'hono'\n    at Module._resolveFilename",
    });
    expect(verdict.missingDependencyFailure).toBe(true);
    expect(verdict.outputLimitExceeded).toBe(false);
  });

  it('detects the overflow via message text when code is absent', () => {
    // Some spawn wrappers surface the condition only in the message.
    const verdict = classify({
      code: 1,
      message: 'stderr maxBuffer length exceeded',
      stderr: '/repo/node_modules/x',
    });
    expect(verdict.outputLimitExceeded).toBe(true);
    expect(verdict.missingDependencyFailure).toBe(false);
  });

  it('pins the ordering guard and the failureCode wiring in the real source', () => {
    // The imported classifier proves behavior; these pin the two things behavior
    // alone cannot see — the ordering guard, and that the gate actually assigns
    // the resulting failureCode rather than computing it and dropping it.
    const guard = gatesSrc.match(
      /const missingDependencyFailure = !spawnResolutionFailed\s*\n\s*&& !outputLimitExceeded/,
    );
    expect(
      guard,
      'missingDependencyFailure must be guarded by !outputLimitExceeded, or a buffer kill is mislabeled again',
    ).toBeTruthy();
    expect(gatesSrc).toMatch(/failureCode = 'output_limit_exceeded'/);
    expect(gatesSrc).toMatch(/failureKind: 'output_limit_exceeded'/);
  });

  it('maps output_limit_exceeded to the validation_failed terminal kind', () => {
    // Without this the code fell through to the 'merge_failed' fallback and a
    // command that never finished was reported to coordinators as a merge failure.
    expect(routerSrc).toMatch(/refineCode === 'output_limit_exceeded'/);
    const mapping = routerSrc.match(
      /\|\| refineCode === 'output_limit_exceeded'\s*\n\s*\? 'validation_failed'/,
    );
    expect(mapping, "output_limit_exceeded must map to 'validation_failed'").toBeTruthy();
  });

  it('gives the coordinator an actionable message that rules out the wrong causes', () => {
    const idx = routerSrc.indexOf("failureCode === 'output_limit_exceeded'");
    expect(idx).toBeGreaterThan(-1);
    const message = routerSrc.slice(idx, idx + 900);
    // The message must say what it is NOT — that is what stops the next
    // investigation from chasing dependencies again.
    expect(message).toMatch(/not a missing dependency/i);
    expect(message).toMatch(/outputLimitBytes/);
  });
});
