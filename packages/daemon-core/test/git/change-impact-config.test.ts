import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  globToRegExp,
  loadChangeImpactConfig,
  suggestChangeImpactConfig,
  validateChangeImpactConfig,
} from '../../src/git/change-impact-config.js';

describe('change-impact config loader', () => {
  const roots: string[] = [];

  function tempDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-ci-${name}-`));
    roots.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('loads a JSON config from .adhdev/change-impact.json', () => {
    const dir = tempDir('json');
    mkdirSync(join(dir, '.adhdev'), { recursive: true });
    writeFileSync(
      join(dir, '.adhdev', 'change-impact.json'),
      JSON.stringify({ daemonRuntimePackages: ['engine'], webOnlyPackages: ['ui'] }),
    );

    const loaded = loadChangeImpactConfig(dir);
    expect(loaded.sourceType).toBe('repo_file');
    expect(loaded.source).toBe('.adhdev/change-impact.json');
    expect(loaded.config?.daemonRuntimePackages).toEqual(['engine']);
    expect(loaded.config?.webOnlyPackages).toEqual(['ui']);
  });

  it('loads a YAML config from .adhdev/change-impact.yaml', () => {
    const dir = tempDir('yaml');
    mkdirSync(join(dir, '.adhdev'), { recursive: true });
    writeFileSync(
      join(dir, '.adhdev', 'change-impact.yaml'),
      'daemonRuntimePackages:\n  - core\nwebOnlyPackages:\n  - dash\n',
    );

    const loaded = loadChangeImpactConfig(dir);
    expect(loaded.sourceType).toBe('repo_file');
    expect(loaded.source).toBe('.adhdev/change-impact.yaml');
    expect(loaded.config?.daemonRuntimePackages).toEqual(['core']);
    expect(loaded.config?.webOnlyPackages).toEqual(['dash']);
  });

  it('loads the repo-mesh-change-impact.* alias', () => {
    const dir = tempDir('alias');
    mkdirSync(join(dir, '.adhdev'), { recursive: true });
    writeFileSync(
      join(dir, '.adhdev', 'repo-mesh-change-impact.json'),
      JSON.stringify({ webOnlyPackages: ['site'] }),
    );

    const loaded = loadChangeImpactConfig(dir);
    expect(loaded.sourceType).toBe('repo_file');
    expect(loaded.source).toBe('.adhdev/repo-mesh-change-impact.json');
    expect(loaded.config?.webOnlyPackages).toEqual(['site']);
  });

  it('reports unavailable when no config file exists', () => {
    const dir = tempDir('none');
    const loaded = loadChangeImpactConfig(dir);
    expect(loaded.sourceType).toBe('unavailable');
    expect(loaded.config).toBeUndefined();
  });

  it('reports invalid for a malformed config (unknown key / wrong type)', () => {
    const dir = tempDir('invalid');
    mkdirSync(join(dir, '.adhdev'), { recursive: true });
    writeFileSync(
      join(dir, '.adhdev', 'change-impact.json'),
      JSON.stringify({ daemonRuntimePackages: 'not-an-array', bogus: true }),
    );

    const loaded = loadChangeImpactConfig(dir);
    expect(loaded.sourceType).toBe('invalid');
    expect(loaded.error).toBeTruthy();
  });

  it('produces a sourceKey that changes when the file is rewritten', () => {
    const dir = tempDir('sourcekey');
    mkdirSync(join(dir, '.adhdev'), { recursive: true });
    const path = join(dir, '.adhdev', 'change-impact.json');
    writeFileSync(path, JSON.stringify({ webOnlyPackages: ['a'] }));
    const first = loadChangeImpactConfig(dir).sourceKey;
    // Rewrite with different content; mtime-or-content perturbs the key.
    writeFileSync(path, JSON.stringify({ webOnlyPackages: ['a', 'b', 'c', 'd'] }));
    const second = loadChangeImpactConfig(dir).sourceKey;
    expect(first).not.toBe(second);
  });
});

describe('validateChangeImpactConfig', () => {
  it('accepts an impactTargets override with recommendedCommand only', () => {
    const result = validateChangeImpactConfig({
      impactTargets: { daemon: { recommendedCommand: 'deploy --target all && restart' } },
    });
    expect(result.valid).toBe(true);
    expect(result.config?.impactTargets?.daemon?.recommendedCommand).toBe('deploy --target all && restart');
  });

  it('rejects an impactTargets entry missing recommendedCommand', () => {
    const result = validateChangeImpactConfig({ impactTargets: { daemon: {} } });
    expect(result.valid).toBe(false);
  });

  it('rejects an unrecognized impact kind', () => {
    const result = validateChangeImpactConfig({ impactTargets: { mobile: { recommendedCommand: 'x' } } });
    expect(result.valid).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const result = validateChangeImpactConfig({ surprise: 1 });
    expect(result.valid).toBe(false);
  });

  it('accepts an empty config (all fields optional)', () => {
    const result = validateChangeImpactConfig({});
    expect(result.valid).toBe(true);
    expect(result.config).toEqual({});
  });
});

describe('globToRegExp', () => {
  it('matches `*` within a single path segment but not across slashes', () => {
    const re = globToRegExp('*.txt');
    expect(re.test('notes.txt')).toBe(true);
    expect(re.test('a/notes.txt')).toBe(false);
  });

  it('matches `**` across path segments', () => {
    const re = globToRegExp('docs/**');
    expect(re.test('docs/a/b/c.md')).toBe(true);
    expect(re.test('docs/x.md')).toBe(true);
    expect(re.test('src/x.md')).toBe(false);
  });

  it('matches `**/` prefix against bare filenames', () => {
    const re = globToRegExp('**/CHANGES.md');
    expect(re.test('CHANGES.md')).toBe(true);
    expect(re.test('deep/nested/CHANGES.md')).toBe(true);
  });

  it('escapes regex metacharacters literally', () => {
    const re = globToRegExp('a.b+c');
    expect(re.test('a.b+c')).toBe(true);
    expect(re.test('axbxc')).toBe(false);
  });
});

describe('suggestChangeImpactConfig', () => {
  const roots: string[] = [];

  function tempDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-cisuggest-${name}-`));
    roots.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('classifies web-* packages as web-only and the rest as daemon-runtime', () => {
    const dir = tempDir('layout');
    for (const pkg of ['daemon-core', 'server', 'web-cloud', 'web-standalone']) {
      mkdirSync(join(dir, 'packages', pkg), { recursive: true });
    }
    const { suggestedConfig, discoveredPackages } = suggestChangeImpactConfig(dir);
    expect(discoveredPackages.web.sort()).toEqual(['web-cloud', 'web-standalone']);
    expect(discoveredPackages.daemon.sort()).toEqual(['daemon-core', 'server']);
    expect(suggestedConfig.webOnlyPackages?.sort()).toEqual(['web-cloud', 'web-standalone']);
    expect(suggestedConfig.daemonRuntimePackages?.sort()).toEqual(['daemon-core', 'server']);
    // impactTargets cover all three classification kinds.
    expect(Object.keys(suggestedConfig.impactTargets ?? {}).sort()).toEqual(['daemon', 'none', 'web']);
  });

  it('also scans oss/packages and produces a config that round-trips through validation', () => {
    const dir = tempDir('oss');
    mkdirSync(join(dir, 'oss', 'packages', 'daemon-core'), { recursive: true });
    mkdirSync(join(dir, 'oss', 'packages', 'web-core'), { recursive: true });
    const { suggestedConfig } = suggestChangeImpactConfig(dir);
    expect(suggestedConfig.daemonRuntimePackages).toContain('daemon-core');
    expect(suggestedConfig.webOnlyPackages).toContain('web-core');
    const validation = validateChangeImpactConfig(suggestedConfig, 'suggested');
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('returns a usable empty-ish draft when no packages exist', () => {
    const dir = tempDir('empty');
    const { suggestedConfig, notes } = suggestChangeImpactConfig(dir);
    expect(suggestedConfig.daemonRuntimePackages).toBeUndefined();
    expect(suggestedConfig.webOnlyPackages).toBeUndefined();
    expect(suggestedConfig.nonRuntimeRootFilePatterns?.length).toBeGreaterThan(0);
    expect(notes.some(n => /No packages/.test(n))).toBe(true);
    // Even the empty draft must validate.
    expect(validateChangeImpactConfig(suggestedConfig, 'suggested').valid).toBe(true);
  });
});
