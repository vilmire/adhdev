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

  it('drops polluted legacy state entries that use unstable session identities', () => {
    writeFileSync(
      join(configDir, 'state.json'),
      JSON.stringify({
        recentActivity: [
          {
            id: 'cli:hermes-cli:session:vi',
            kind: 'cli',
            providerType: 'hermes-cli',
            providerName: 'Hermes Agent',
            providerSessionId: 'vi',
            workspace: '/repo',
            lastUsedAt: 10,
          },
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
          { id: 'saved:vi', kind: 'cli', providerType: 'hermes-cli', providerName: 'Hermes Agent', providerSessionId: 'vi', createdAt: 1, lastUsedAt: 1 },
          { id: 'saved:undefined', kind: 'cli', providerType: 'hermes-cli', providerName: 'Hermes Agent', providerSessionId: 'undefined', createdAt: 2, lastUsedAt: 2 },
          { id: 'saved:20260416_212202_9c583d', kind: 'cli', providerType: 'hermes-cli', providerName: 'Hermes Agent', providerSessionId: '20260416_212202_9c583d', createdAt: 3, lastUsedAt: 3 },
        ],
        sessionReads: {
          'provider:codex:vscode-webview://volatile': 123,
          'provider:codex:turns:stable-1|stable-2': 456,
        },
        sessionReadMarkers: {
          'provider:codex:vscode-webview://volatile': 'turn:legacy',
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
