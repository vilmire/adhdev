import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageJsonPath = join(import.meta.dirname, '..', 'package.json');

describe('daemon-core package metadata', () => {
  it('does not mark session-host-core as a bundled dependency', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      bundleDependencies?: string[];
      bundledDependencies?: string[];
    };

    expect(pkg.dependencies?.['@adhdev/session-host-core']).toBeDefined();
    expect(pkg.bundleDependencies ?? []).not.toContain('@adhdev/session-host-core');
    expect(pkg.bundledDependencies ?? []).not.toContain('@adhdev/session-host-core');
  });
});
