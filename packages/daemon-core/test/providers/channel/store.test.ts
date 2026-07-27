import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import { ProviderChannelError } from '../../../src/providers/channel/contract.js';
import { TREE_DIGEST_ALGORITHM } from '../../../src/providers/channel/tree-digest.js';
import { buildObjectStaging, entryFromSpec, makeTmp, type FixtureProviderSpec } from './helpers.js';

const CLI_X: FixtureProviderSpec = { category: 'cli', dirname: 'x-cli', type: 'x-cli' };

function activateWith(store: ProviderChannelStore, channel: 'stable' | 'preview', spec: FixtureProviderSpec, marker: string) {
  // Distinct content per activation → distinct digest.
  const variant = { ...spec, files: { 'marker.txt': marker } };
  const { dir, digest } = buildObjectStaging(variant);
  return store.activate(channel, entryFromSpec(variant, digest), dir);
}

describe('ProviderChannelStore', () => {
  let root = '';
  let store: ProviderChannelStore;

  beforeEach(() => {
    root = makeTmp('adhdev-channel-store-');
    store = new ProviderChannelStore(join(root, '.store'));
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('activates a verified tree and exposes it via the active pointer', () => {
    const result = activateWith(store, 'stable', CLI_X, 'v1');
    expect(result.changed).toBe(true);

    const pointer = store.getPointer('stable', 'x-cli');
    expect(pointer?.active.digest).toBe(result.ref.digest);
    expect(pointer?.previous).toBeNull();
    expect(existsSync(join(result.objectDir, 'cli', 'x-cli', 'provider.json'))).toBe(true);

    const { activations, errors } = store.listActiveActivations('stable');
    expect(errors).toHaveLength(0);
    expect(activations).toHaveLength(1);
    expect(activations[0].objectDir).toBe(result.objectDir);
  });

  it('is a no-op when the same digest is already active', () => {
    const first = activateWith(store, 'stable', CLI_X, 'v1');
    const { dir, digest } = buildObjectStaging({ ...CLI_X, files: { 'marker.txt': 'v1' } });
    expect(digest).toBe(first.ref.digest);
    const second = store.activate('stable', entryFromSpec(CLI_X, digest), dir);
    expect(second.changed).toBe(false);
    expect(store.getPointer('stable', 'x-cli')?.previous).toBeNull();
  });

  it('keeps the previous activation as rollback target; rollback is a local pointer flip', () => {
    const v1 = activateWith(store, 'stable', CLI_X, 'v1');
    const v2 = activateWith(store, 'stable', CLI_X, 'v2');
    expect(v2.changed).toBe(true);
    expect(store.getPointer('stable', 'x-cli')?.previous?.digest).toBe(v1.ref.digest);

    const rolledBack = store.rollback('stable', 'x-cli');
    expect(rolledBack?.digest).toBe(v1.ref.digest);
    // Rollback preserves a forward target (flip-flop is possible).
    expect(store.getPointer('stable', 'x-cli')?.previous?.digest).toBe(v2.ref.digest);

    // The rolled-back object is intact on disk.
    const { activations, errors } = store.listActiveActivations('stable');
    expect(errors).toHaveLength(0);
    expect(activations[0].ref.digest).toBe(v1.ref.digest);
    expect(existsSync(join(activations[0].objectDir, 'cli', 'x-cli', 'marker.txt'))).toBe(true);
  });

  it('returns null when there is no rollback target', () => {
    activateWith(store, 'stable', CLI_X, 'v1');
    expect(store.rollback('stable', 'other-cli')).toBeNull();
  });

  it('retains N=2 activated digests per provider type/channel after gc', () => {
    const v1 = activateWith(store, 'stable', CLI_X, 'v1');
    const v2 = activateWith(store, 'stable', CLI_X, 'v2');
    const v3 = activateWith(store, 'stable', CLI_X, 'v3');

    const gcResult = store.gc();
    expect(gcResult.removedObjects).toContain(v1.ref.digest);

    const objectsDir = join(root, '.store', 'objects');
    const remaining = readdirSync(objectsDir);
    expect(remaining.sort()).toEqual(
      [v2.ref.digest.slice('sha256:'.length), v3.ref.digest.slice('sha256:'.length)].sort(),
    );

    // Rollback still works after the third activation (previous = v2).
    expect(store.rollback('stable', 'x-cli')?.digest).toBe(v2.ref.digest);
  });

  it('does not observe crash orphans: an object without a pointer is never active and is gc-collected', () => {
    // Simulate a crash after the object rename but before the pointer flip:
    // putObject ran, activate() never finished.
    const { dir, digest } = buildObjectStaging({ ...CLI_X, files: { 'marker.txt': 'orphan' } });
    store.putObject(dir, digest);

    const { activations, errors } = store.listActiveActivations('stable');
    expect(activations).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(store.getPointer('stable', 'x-cli')).toBeNull();

    const gcResult = store.gc();
    expect(gcResult.removedObjects).toContain(digest);
    expect(existsSync(store.getObjectDir(digest))).toBe(false);
  });

  it('cleans staging leftovers from interrupted syncs during gc', () => {
    const staging = store.createStagingDir('sync');
    writeFileSync(join(staging, 'partial.bin'), 'x', 'utf-8');
    const gcResult = store.gc();
    expect(gcResult.removedStaging).toBeGreaterThanOrEqual(1);
    expect(existsSync(staging)).toBe(false);
  });

  it('treats corrupt pointer files as typed STORE_CORRUPT errors (fail closed)', () => {
    const pointerDir = join(root, '.store', 'active', 'stable');
    mkdirSync(pointerDir, { recursive: true });
    writeFileSync(join(pointerDir, 'x-cli.json'), 'not json at all', 'utf-8');

    expect(() => store.getPointer('stable', 'x-cli')).toThrowError(ProviderChannelError);
    try {
      store.getPointer('stable', 'x-cli');
    } catch (e: any) {
      expect(e.code).toBe('STORE_CORRUPT');
    }

    const { pointers, errors } = store.listPointers('stable');
    expect(pointers.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('STORE_CORRUPT');
  });

  it('fails closed when the active object is missing from the store', () => {
    const v1 = activateWith(store, 'stable', CLI_X, 'v1');
    rmSync(v1.objectDir, { recursive: true, force: true });

    const { activations, errors } = store.listActiveActivations('stable');
    expect(activations).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('STORE_CORRUPT');
  });

  it('isolates channels: stable activations are invisible to preview and vice versa', () => {
    activateWith(store, 'stable', CLI_X, 'v1');
    expect(store.listActiveActivations('preview').activations).toHaveLength(0);
    expect(store.getPointer('preview', 'x-cli')).toBeNull();
  });

  it('rejects malformed digests for store operations', () => {
    const { dir } = buildObjectStaging(CLI_X);
    expect(() => store.putObject(dir, 'not-a-digest')).toThrowError(ProviderChannelError);
  });
});
