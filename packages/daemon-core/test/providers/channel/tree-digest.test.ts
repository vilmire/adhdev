import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { computeProviderTreeDigest } from '../../../src/providers/channel/tree-digest.js';
import { ProviderChannelError } from '../../../src/providers/channel/contract.js';
import { makeTmp } from './helpers.js';

/**
 * Golden vector: the digest below is the value the reference implementation
 * (adhdev-providers/scripts/lib/provider-channels.mjs) computed over the
 * git-tracked tree `extension/cline/` — it is the `bundleDigest` published
 * in adhdev-providers/channels/{stable,preview}.json for providerType
 * "cline". The fixture is a byte-for-byte copy of that tree (14 files), so
 * this test proves the TypeScript port reproduces the canonical algorithm
 * bit-for-bit.
 */
const CLINE_GOLDEN_DIGEST = 'sha256:2858a90bcab1ffed2773a58281744e67d542c8af8fbbfc05900eadac2e784f22';

describe('computeProviderTreeDigest (adhdev-provider-tree-sha256-v1)', () => {
  it('reproduces the reference-implementation digest for extension/cline (golden vector)', () => {
    const digest = computeProviderTreeDigest(join(__dirname, 'fixtures', 'cline-tree'));
    expect(digest).toBe(CLINE_GOLDEN_DIGEST);
  });

  it('is sensitive to file content, file set and relative paths', () => {
    const root = makeTmp('adhdev-digest-sensitivity-');
    mkdirSync(join(root, 'cli', 'x'), { recursive: true });
    writeFileSync(join(root, 'cli', 'x', 'provider.json'), '{"type":"x"}', 'utf-8');
    const base = computeProviderTreeDigest(root);

    writeFileSync(join(root, 'cli', 'x', 'provider.json'), '{"type":"x","v":2}', 'utf-8');
    expect(computeProviderTreeDigest(root)).not.toBe(base);

    const root2 = makeTmp('adhdev-digest-sensitivity-');
    mkdirSync(join(root2, 'cli', 'y'), { recursive: true });
    writeFileSync(join(root2, 'cli', 'y', 'provider.json'), '{"type":"x"}', 'utf-8');
    expect(computeProviderTreeDigest(root2)).not.toBe(base);
  });

  it('fails closed on empty trees', () => {
    const root = makeTmp('adhdev-digest-empty-');
    expect(() => computeProviderTreeDigest(root)).toThrowError(ProviderChannelError);
    try {
      computeProviderTreeDigest(root);
    } catch (e: any) {
      expect(e.code).toBe('ENTRY_TREE_INVALID');
    }
  });

  it('fails closed on non-regular entries (symlinks)', () => {
    const root = makeTmp('adhdev-digest-symlink-');
    mkdirSync(join(root, 'cli', 'x'), { recursive: true });
    writeFileSync(join(root, 'cli', 'x', 'provider.json'), '{}', 'utf-8');
    symlinkSync(join(root, 'cli', 'x', 'provider.json'), join(root, 'cli', 'x', 'link.js'));
    try {
      computeProviderTreeDigest(root);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(ProviderChannelError);
      expect(e.code).toBe('ENTRY_TREE_INVALID');
    }
  });
});
