import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MESH_POLICY,
  resolveAllowSendKeysDestructive,
} from '../../src/repo-mesh-types.js';

// MESH-SEND-KEYS (feature 3): destructive key injection (CTRL_C/ESC) is
// fail-closed — it requires an explicit mesh/node policy opt-in (on top of a
// per-call confirm_destructive). Default is FALSE so a stray Ctrl-C cannot kill a
// worker without the owner opting in.

describe('resolveAllowSendKeysDestructive', () => {
  it('defaults to FALSE (fail-closed) when no policy is set', () => {
    expect(resolveAllowSendKeysDestructive(undefined, undefined)).toBe(false);
    expect(resolveAllowSendKeysDestructive(null, null)).toBe(false);
    expect(resolveAllowSendKeysDestructive({}, {})).toBe(false);
  });

  it('honors the mesh-level opt-in', () => {
    expect(resolveAllowSendKeysDestructive({ allowSendKeysDestructive: true }, undefined)).toBe(true);
    expect(resolveAllowSendKeysDestructive({ allowSendKeysDestructive: false }, undefined)).toBe(false);
  });

  it('lets a node policy override the mesh-level policy', () => {
    expect(
      resolveAllowSendKeysDestructive(
        { allowSendKeysDestructive: false },
        { allowSendKeysDestructive: true },
      ),
    ).toBe(true);
    expect(
      resolveAllowSendKeysDestructive(
        { allowSendKeysDestructive: true },
        { allowSendKeysDestructive: false },
      ),
    ).toBe(false);
  });

  it('DEFAULT_MESH_POLICY leaves destructive send-keys disabled', () => {
    expect(resolveAllowSendKeysDestructive(DEFAULT_MESH_POLICY, undefined)).toBe(false);
  });
});
