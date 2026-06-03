/**
 * Regression guard: the residual codex-cli override we ship after the v1
 * migration must classify as `clean`. Its only purpose is the stateful
 * idle-settle hold; if it ever flips to elevated/hostile, the migration
 * regressed.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeOverrideTaint } from '../../../src/providers/sdk/v1/validators/taint.js';

const codexV1Override = resolve(
  __dirname,
  '../../../../../../adhdev-providers/cli/codex-cli/scripts/v1/detect_status.js',
);

describe('codex-cli v1 residual override', () => {
  it('exists at the documented migration path', () => {
    expect(existsSync(codexV1Override)).toBe(true);
  });

  it('classifies as clean (no flagged APIs)', () => {
    if (!existsSync(codexV1Override)) return;
    const dir = mkdtempSync(join(tmpdir(), 'taint-codex-v1-'));
    mkdirSync(join(dir, 'scripts', 'v1'), { recursive: true });
    copyFileSync(codexV1Override, join(dir, 'scripts', 'v1', 'detect_status.js'));
    writeFileSync(
      join(dir, 'provider.json'),
      JSON.stringify({ overrides: { detectStatus: 'scripts/v1/detect_status.js' } }),
    );
    const result = analyzeOverrideTaint(join(dir, 'provider.json'));
    expect(result.level).toBe('clean');
    expect(result.findings).toEqual([]);
  });
});
