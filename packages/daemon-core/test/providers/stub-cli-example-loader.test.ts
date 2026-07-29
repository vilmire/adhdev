import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ProviderLoader } from '../../src/providers/provider-loader.js';

/**
 * F3 — stub-cli worked example: loader + hot-reload contract.
 *
 * The shipped example (adhdev-providers/examples/stub-cli) must load
 * out-of-box through the canonical ProviderLoader path once copied into a
 * provider root — its declared scriptDir (scripts/v1) ships a scripts.js
 * whose parseSession the runner can invoke. Fail-closed behavior for
 * providers WITHOUT scripts must remain: no scripts dir → no parseSession
 * handler (the runner then returns null + parseErrorMessage upstream).
 */

const HERE = __dirname;
const SHIPPED_EXAMPLE_DIR = path.resolve(HERE, '../../../../../adhdev-providers/examples/stub-cli');

class TestProviderLoader extends ProviderLoader {
  constructor(userDir: string) {
    super({ userDir, disableUpstream: true });
  }

  protected override readConfig(): any | null {
    return { providerSettings: {} };
  }

  protected override writeConfig(): void {
    // no-op: tests never persist machine config
  }
}

let userDir = '';

beforeEach(() => {
  // 'providers' in the path on purpose: reload() busts require.cache entries
  // keyed by that substring, matching real on-disk layouts.
  userDir = mkdtempSync(path.join(tmpdir(), 'adhdev-providers-stub-loader-'));
});

afterEach(() => {
  if (userDir && existsSync(userDir)) {
    rmSync(userDir, { recursive: true, force: true });
  }
  userDir = '';
});

function installShippedExample(): string {
  const target = path.join(userDir, 'cli', 'stub-cli');
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(SHIPPED_EXAMPLE_DIR, target, { recursive: true });
  return target;
}

describe('stub-cli example — ProviderLoader resolution', () => {
  it('loads the shipped example out-of-box with a working parseSession', () => {
    installShippedExample();
    const loader = new TestProviderLoader(userDir);
    loader.loadAll();

    const resolved = loader.resolve('stub-cli', { version: '0.1.0' }) as any;
    expect(resolved).toBeTruthy();
    expect(resolved._resolvedScriptDir).toBe('scripts/v1');
    expect(typeof resolved.scripts?.parseSession).toBe('function');

    const modalBuffer = [
      'Welcome to stub-agent v0.1.0',
      'stub> hello world',
      '⠋ Thinking...',
      '────────────────────────',
      'Approve this action?',
      '',
      '  1. Yes, run it',
      '  2. No, cancel',
      '────────────────────────',
      'stub> ',
    ].join('\n');
    const session = resolved.scripts.parseSession(undefined, { buffer: modalBuffer });
    expect(session.status).toBe('waiting_approval');
    expect(session.modal).toEqual({ message: 'Approve this action?', buttons: ['Yes, run it', 'No, cancel'] });
    expect(session.messages.some((m: any) => m.role === 'user' && m.content === 'hello world')).toBe(true);

    // Deterministic: identical input → identical output.
    expect(resolved.scripts.parseSession(undefined, { buffer: modalBuffer })).toEqual(session);
  });

  it('still fails closed for a provider whose declared scriptDir is missing', () => {
    installShippedExample();
    rmSync(path.join(userDir, 'cli', 'stub-cli', 'scripts'), { recursive: true, force: true });
    const loader = new TestProviderLoader(userDir);
    loader.loadAll();

    const resolved = loader.resolve('stub-cli', { version: '0.1.0' }) as any;
    expect(resolved).toBeTruthy();
    // No scripts on disk → no parseSession handler. The runner's fail-closed
    // path (parseSession unavailable → null + parseErrorMessage) is upstream
    // of this and stays untouched.
    expect(typeof resolved?.scripts?.parseSession).not.toBe('function');
  });

  it('hot-reload picks up edited scripts via reload() (require-cache busted)', () => {
    installShippedExample();
    const scriptsJs = path.join(userDir, 'cli', 'stub-cli', 'scripts', 'v1', 'scripts.js');
    const parseSessionJs = path.join(userDir, 'cli', 'stub-cli', 'scripts', 'v1', 'parse_session.js');

    const loader = new TestProviderLoader(userDir);
    loader.loadAll();
    const before = loader.resolve('stub-cli', { version: '0.1.0' }) as any;
    expect(before.scripts.parseSession(undefined, { buffer: 'stub> ' }).status).toBe('idle');

    // Simulate an author iterating on the example: rewrite both files.
    writeFileSync(
      parseSessionJs,
      `'use strict';\nmodule.exports = function parseSession() {\n  return { status: 'generating', messages: [], modal: null, parsedStatus: 'generating' };\n};\n`,
      'utf-8',
    );
    writeFileSync(
      scriptsJs,
      `'use strict';\nvar path = require('path');\nvar parseSession = require(path.join(__dirname, 'parse_session.js'));\nmodule.exports.parseSession = function (state, input) { return parseSession(state, input); };\n`,
      'utf-8',
    );

    loader.reload();
    const after = loader.resolve('stub-cli', { version: '0.1.0' }) as any;
    expect(after.scripts.parseSession(undefined, { buffer: 'stub> ' }).status).toBe('generating');
  });
});
