import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_CHANNEL,
  KNOWN_DIGEST_ALGORITHMS,
  ProviderChannelError,
  partitionChannelEntries,
  resolveProviderChannel,
} from '../../../src/providers/channel/contract.js';
import { TREE_DIGEST_ALGORITHM } from '../../../src/providers/channel/tree-digest.js';

const VALID_DIGEST = `sha256:${'a'.repeat(64)}`;

describe('resolveProviderChannel', () => {
  it('resolves absent configuration to stable', () => {
    expect(resolveProviderChannel(undefined, {})).toBe('stable');
    expect(resolveProviderChannel(null, {})).toBe('stable');
    expect(resolveProviderChannel('', {})).toBe('stable');
    expect(DEFAULT_PROVIDER_CHANNEL).toBe('stable');
  });

  it('resolves ambiguous configuration to stable (never preview)', () => {
    expect(resolveProviderChannel('nonsense', {})).toBe('stable');
    expect(resolveProviderChannel('STABLE', {})).toBe('stable');
    expect(resolveProviderChannel('Preview', {})).toBe('stable');
    expect(resolveProviderChannel('main', {})).toBe('stable');
  });

  it('resolves explicit stable/preview', () => {
    expect(resolveProviderChannel('stable', {})).toBe('stable');
    expect(resolveProviderChannel('preview', {})).toBe('preview');
    expect(resolveProviderChannel('  preview  ', {})).toBe('preview');
  });

  it('uses ADHDEV_PROVIDER_CHANNEL when config is absent, config wins otherwise', () => {
    expect(resolveProviderChannel(undefined, { ADHDEV_PROVIDER_CHANNEL: 'preview' })).toBe('preview');
    expect(resolveProviderChannel('stable', { ADHDEV_PROVIDER_CHANNEL: 'preview' })).toBe('stable');
    expect(resolveProviderChannel('garbage', { ADHDEV_PROVIDER_CHANNEL: 'preview' })).toBe('stable');
  });
});

describe('partitionChannelEntries (fail-closed entry gating)', () => {
  const base = { providerType: 'x-cli', providerVersion: '1.0.0', category: 'cli' };

  it('accepts entries with a valid sha256 digest and a known algorithm', () => {
    const { activatable, skipped } = partitionChannelEntries([
      { ...base, bundleDigest: VALID_DIGEST, digestAlgorithm: TREE_DIGEST_ALGORITHM },
    ]);
    expect(activatable).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    expect(KNOWN_DIGEST_ALGORITHMS.has(TREE_DIGEST_ALGORITHM)).toBe(true);
  });

  it('marks NULL-digest / legacy-unverified rows non-activatable (never an error, never activated)', () => {
    const { activatable, skipped } = partitionChannelEntries([
      { ...base, bundleDigest: null, digestAlgorithm: 'legacy-unverified' },
      { ...base, providerType: 'y-cli', bundleDigest: null, digestAlgorithm: null },
    ]);
    expect(activatable).toHaveLength(0);
    expect(skipped.map((s) => s.code)).toEqual(['ENTRY_NON_ACTIVATABLE', 'ENTRY_NON_ACTIVATABLE']);
  });

  it('isolates unsupported digest algorithms', () => {
    const { activatable, skipped } = partitionChannelEntries([
      { ...base, bundleDigest: VALID_DIGEST, digestAlgorithm: 'adhdev-provider-tree-sha256-v2' },
    ]);
    expect(activatable).toHaveLength(0);
    expect(skipped[0].code).toBe('ENTRY_ALGORITHM_UNSUPPORTED');
  });

  it('rejects malformed digests even with a known algorithm', () => {
    const bad = [
      'sha256:' + 'A'.repeat(64), // uppercase hex
      'sha256:' + 'a'.repeat(63), // too short
      'a'.repeat(64), // missing prefix
      'sha512:' + 'a'.repeat(64),
    ];
    for (const bundleDigest of bad) {
      const { activatable, skipped } = partitionChannelEntries([
        { ...base, bundleDigest, digestAlgorithm: TREE_DIGEST_ALGORITHM },
      ]);
      expect(activatable, bundleDigest).toHaveLength(0);
      expect(skipped[0].code, bundleDigest).toBe('ENTRY_DIGEST_INVALID');
    }
  });
});

describe('ProviderChannelError', () => {
  it('carries a typed code and optional providerType', () => {
    const err = new ProviderChannelError('DIGEST_MISMATCH', 'boom', 'x-cli');
    expect(err.code).toBe('DIGEST_MISMATCH');
    expect(err.providerType).toBe('x-cli');
    expect(err).toBeInstanceOf(Error);
  });
});
