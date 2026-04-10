import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let configDir = '';

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => configDir,
}));

import { loadState, resetState, saveState } from '../../src/config/state-store.js';

describe('state-store', () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'adhdev-daemon-core-state-'));
  });

  afterEach(() => {
    if (configDir && existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
    }
    configDir = '';
  });

  it('returns default state when no state file exists', () => {
    expect(loadState()).toEqual({
      recentActivity: [],
      savedProviderSessions: [],
      sessionReads: {},
      sessionReadMarkers: {},
    });
  });

  it('normalizes malformed persisted state on load', () => {
    writeFileSync(
      join(configDir, 'state.json'),
      JSON.stringify({
        recentActivity: [{ id: 'a', kind: 'cli' }],
        savedProviderSessions: [{ id: 'b', providerSessionId: 'sess_1' }],
        sessionReads: { good: 1, bad: 'x', inf: Number.POSITIVE_INFINITY },
        sessionReadMarkers: { ok: 'done', nope: 42 },
      }),
      'utf-8',
    );

    expect(loadState()).toEqual({
      recentActivity: [{ id: 'a', kind: 'cli' }],
      savedProviderSessions: [{ id: 'b', providerSessionId: 'sess_1' }],
      sessionReads: { good: 1 },
      sessionReadMarkers: { ok: 'done' },
    });
  });

  it('saveState writes normalized state to disk', () => {
    saveState({
      recentActivity: [],
      savedProviderSessions: [],
      sessionReads: {
        ok: 123,
        bad: Number.NaN as unknown as number,
      },
      sessionReadMarkers: {
        done: 'marker',
        invalid: 1 as unknown as string,
      },
    });

    const raw = JSON.parse(readFileSync(join(configDir, 'state.json'), 'utf-8'));
    expect(raw).toEqual({
      recentActivity: [],
      savedProviderSessions: [],
      sessionReads: { ok: 123 },
      sessionReadMarkers: { done: 'marker' },
    });
  });

  it('resetState overwrites state.json with the default shape', () => {
    writeFileSync(join(configDir, 'state.json'), JSON.stringify({ junk: true }), 'utf-8');

    resetState();

    expect(loadState()).toEqual({
      recentActivity: [],
      savedProviderSessions: [],
      sessionReads: {},
      sessionReadMarkers: {},
    });
  });
});
