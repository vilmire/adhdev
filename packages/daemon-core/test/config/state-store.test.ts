import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let configDir = '';

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => configDir,
}));

import {
  loadPersistedProviderSessionPins,
  loadState,
  recordPersistedProviderSessionPin,
  resetState,
  saveState,
} from '../../src/config/state-store.js';

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
      sessionNotificationDismissals: {},
      sessionNotificationUnreadOverrides: {},
      sessionProviderSessionPins: {},
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
      sessionNotificationDismissals: {},
      sessionNotificationUnreadOverrides: {},
      sessionProviderSessionPins: {},
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
      sessionNotificationDismissals: {},
      sessionNotificationUnreadOverrides: {},
      sessionProviderSessionPins: {},
    });

    const raw = JSON.parse(readFileSync(join(configDir, 'state.json'), 'utf-8'));
    expect(raw).toEqual({
      recentActivity: [],
      savedProviderSessions: [],
      sessionReads: { ok: 123 },
      sessionReadMarkers: { done: 'marker' },
      sessionNotificationDismissals: {},
      sessionNotificationUnreadOverrides: {},
      sessionProviderSessionPins: {},
    });
  });

  it('drops state entries with missing or empty session identities', () => {
    writeFileSync(
      join(configDir, 'state.json'),
      JSON.stringify({
        recentActivity: [
          {
            id: 'cli:hermes-cli:session:20260416_212202_9c583d',
            kind: 'cli',
            providerType: 'hermes-cli',
            providerName: 'Hermes Agent',
            providerSessionId: '20260416_212202_9c583d',
            workspace: '/repo',
            lastUsedAt: 20,
          },
          {
            id: 'cli:hermes-cli:session:empty',
            kind: 'cli',
            providerType: 'hermes-cli',
            providerName: 'Hermes Agent',
            providerSessionId: '',
            workspace: '/repo',
            lastUsedAt: 10,
          },
        ],
        savedProviderSessions: [
          { id: 'saved:20260416_212202_9c583d', kind: 'cli', providerType: 'hermes-cli', providerName: 'Hermes Agent', providerSessionId: '20260416_212202_9c583d', createdAt: 3, lastUsedAt: 3 },
          { id: 'saved:empty', kind: 'cli', providerType: 'hermes-cli', providerName: 'Hermes Agent', providerSessionId: '', createdAt: 1, lastUsedAt: 1 },
        ],
        sessionReads: {
          'provider:codex:turns:stable-1|stable-2': 456,
        },
        sessionReadMarkers: {
          'provider:codex:turns:stable-1|stable-2': 'turn:stable',
        },
      }),
      'utf-8',
    );

    expect(loadState()).toEqual({
      recentActivity: [
        {
          id: 'cli:hermes-cli:session:20260416_212202_9c583d',
          kind: 'cli',
          providerType: 'hermes-cli',
          providerName: 'Hermes Agent',
          providerSessionId: '20260416_212202_9c583d',
          workspace: '/repo',
          lastUsedAt: 20,
        },
      ],
      savedProviderSessions: [
        { id: 'saved:20260416_212202_9c583d', kind: 'cli', providerType: 'hermes-cli', providerName: 'Hermes Agent', providerSessionId: '20260416_212202_9c583d', createdAt: 3, lastUsedAt: 3 },
      ],
      sessionReads: {
        'provider:codex:turns:stable-1|stable-2': 456,
      },
      sessionReadMarkers: {
        'provider:codex:turns:stable-1|stable-2': 'turn:stable',
      },
      sessionNotificationDismissals: {},
      sessionNotificationUnreadOverrides: {},
      sessionProviderSessionPins: {},
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
      sessionNotificationDismissals: {},
      sessionNotificationUnreadOverrides: {},
      sessionProviderSessionPins: {},
    });
  });

  describe('provider-session pin persistence (ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP)', () => {
    it('records a pin and reloads it across a fresh loadState (survives restart)', () => {
      recordPersistedProviderSessionPin('agy-session-1', '65c1fff8-conv-uuid');
      // A brand-new load (simulating a daemon restart reading state.json) sees it.
      expect(loadState().sessionProviderSessionPins).toEqual({ 'agy-session-1': '65c1fff8-conv-uuid' });
      expect(loadPersistedProviderSessionPins()).toEqual({ 'agy-session-1': '65c1fff8-conv-uuid' });
    });

    it('is a no-op write when the pin is unchanged (does not rewrite identical state)', () => {
      recordPersistedProviderSessionPin('agy-session-2', 'conv-a');
      const before = readFileSync(join(configDir, 'state.json'), 'utf-8');
      recordPersistedProviderSessionPin('agy-session-2', 'conv-a');
      const after = readFileSync(join(configDir, 'state.json'), 'utf-8');
      expect(after).toBe(before);
    });

    it('updates the pin when the conversation id changes (resume/new-session)', () => {
      recordPersistedProviderSessionPin('agy-session-3', 'conv-old');
      recordPersistedProviderSessionPin('agy-session-3', 'conv-new');
      expect(loadState().sessionProviderSessionPins).toEqual({ 'agy-session-3': 'conv-new' });
    });

    it('ignores empty session id or empty conversation id', () => {
      recordPersistedProviderSessionPin('', 'conv-x');
      recordPersistedProviderSessionPin('agy-session-4', '');
      expect(loadState().sessionProviderSessionPins).toEqual({});
    });

    it('keeps multiple sessions distinct and drops malformed entries on load', () => {
      recordPersistedProviderSessionPin('s1', 'c1');
      recordPersistedProviderSessionPin('s2', 'c2');
      // Corrupt the file with a malformed entry alongside good ones.
      const state = loadState();
      writeFileSync(
        join(configDir, 'state.json'),
        JSON.stringify({
          ...state,
          sessionProviderSessionPins: { s1: 'c1', s2: 'c2', bad: 42, '': 'nope', s3: '' },
        }),
        'utf-8',
      );
      expect(loadState().sessionProviderSessionPins).toEqual({ s1: 'c1', s2: 'c2' });
    });
  });
});
