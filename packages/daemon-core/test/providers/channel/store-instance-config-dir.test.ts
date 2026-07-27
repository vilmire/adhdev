import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';

// Stage 2 store must follow the isolated instance config dir (Stage 3
// invariant): the verified provider object store and the active pointers are
// per-instance mutable state — stable and preview never read or activate each
// other's provider trees.

const tempRoots: string[] = [];
let originalConfigDir: string | undefined;

beforeEach(() => {
  originalConfigDir = process.env.ADHDEV_CONFIG_DIR;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
  else process.env.ADHDEV_CONFIG_DIR = originalConfigDir;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-provider-store-'));
  tempRoots.push(dir);
  return dir;
}

function makeEntry(digestHex: string) {
  return {
    providerType: 'claude-cli',
    providerVersion: '1.0.0',
    category: 'cli' as const,
    bundleDigest: `sha256:${digestHex}`,
    digestAlgorithm: 'sha256' as const,
  };
}

describe('ProviderChannelStore instance scoping', () => {
  it('defaultRoot follows ADHDEV_CONFIG_DIR', () => {
    const root = makeTempRoot();
    const previewDir = path.join(root, '.adhdev-preview');
    process.env.ADHDEV_CONFIG_DIR = previewDir;

    expect(ProviderChannelStore.defaultRoot()).toBe(
      path.join(previewDir, 'providers', '.store'),
    );
    expect(ProviderChannelStore.defaultRoot()).not.toContain(`${path.sep}.adhdev${path.sep}`);
  });

  it('two instances activate and resolve disjoint stores and pointers', () => {
    const root = makeTempRoot();
    const stableDir = path.join(root, '.adhdev');
    const previewDir = path.join(root, '.adhdev-preview');
    const digest = 'a'.repeat(64);

    process.env.ADHDEV_CONFIG_DIR = stableDir;
    const stableStore = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
    const stableStaging = stableStore.createStagingDir('test');
    fs.mkdirSync(path.join(stableStaging, 'cli', 'claude-cli'), { recursive: true });
    stableStore.activate('stable', makeEntry(digest), stableStaging);

    process.env.ADHDEV_CONFIG_DIR = previewDir;
    const previewStore = new ProviderChannelStore(ProviderChannelStore.defaultRoot());

    // Roots and pointers are disjoint.
    expect(previewStore.rootDir).not.toBe(stableStore.rootDir);
    expect(previewStore.getPointer('stable', 'claude-cli')).toBe(null);
    expect(previewStore.listActiveActivations('stable').activations).toHaveLength(0);

    // Stable instance kept its activation under its own dir.
    process.env.ADHDEV_CONFIG_DIR = stableDir;
    const stableAgain = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
    const pointer = stableAgain.getPointer('stable', 'claude-cli');
    expect(pointer?.active.digest).toBe(`sha256:${digest}`);
    expect(stableAgain.rootDir.startsWith(stableDir + path.sep)).toBe(true);
  });
});
