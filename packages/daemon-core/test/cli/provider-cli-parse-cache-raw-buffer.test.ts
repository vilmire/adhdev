import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('ProviderCliAdapter parsed-status cache', () => {
  it('invalidates cache hits when only the raw PTY buffer changes', () => {
    const source = readFileSync(resolve(here, '../../src/cli-adapters/provider-cli-adapter.ts'), 'utf8');

    expect(source).toMatch(/accumulatedRawBuffer: string/);
    expect(source).toMatch(/cached\.accumulatedRawBuffer === this\.accumulatedRawBuffer/);
    expect(source).toMatch(/accumulatedRawBuffer: this\.accumulatedRawBuffer/);
  });
});
