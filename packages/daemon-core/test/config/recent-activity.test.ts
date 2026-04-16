import { describe, expect, it } from 'vitest';
import {
  appendRecentActivity,
  buildRecentActivityKey,
  buildRecentActivityKeyForEntry,
  getRecentActivity,
  getSessionSeenAt,
  getSessionSeenMarker,
  markSessionSeen,
} from '../../src/config/recent-activity.js';
import type { DaemonState } from '../../src/config/state-store.js';

function createState(): DaemonState {
  return {
    recentActivity: [],
    savedProviderSessions: [],
    sessionReads: {},
    sessionReadMarkers: {},
  };
}

describe('recent-activity', () => {
  it('uses provider session id when present and trims whitespace', () => {
    const key = buildRecentActivityKeyForEntry({
      kind: 'cli',
      providerType: 'codex-cli',
      providerSessionId: '  sess_123  ',
      workspace: '/tmp/project',
    });

    expect(key).toBe('cli:codex-cli:session:sess_123');
  });

  it('falls back to normalized workspace key when no provider session id exists', () => {
    const key = buildRecentActivityKey({
      kind: 'cli',
      providerType: 'claude-cli',
      workspace: './tmp/project',
    });

    expect(key).toBe(`cli:claude-cli:${process.cwd()}/tmp/project`);
  });

  it('deduplicates entries by computed id and keeps newest first', () => {
    const state = createState();
    const first = appendRecentActivity(state, {
      kind: 'cli',
      providerType: 'codex-cli',
      providerName: 'Codex CLI',
      providerSessionId: 'sess_1',
      workspace: '/tmp/old',
      title: 'older',
      lastUsedAt: 10,
    });
    const second = appendRecentActivity(first, {
      kind: 'cli',
      providerType: 'codex-cli',
      providerName: 'Codex CLI',
      providerSessionId: 'sess_1',
      workspace: '/tmp/new',
      title: 'newer',
      lastUsedAt: 20,
    });

    expect(second.recentActivity).toHaveLength(1);
    expect(second.recentActivity[0]?.title).toBe('newer');
    expect(second.recentActivity[0]?.workspace).toBe('/tmp/new');
  });

  it('sorts getRecentActivity by lastUsedAt descending', () => {
    const state = createState();
    const withA = appendRecentActivity(state, {
      kind: 'cli',
      providerType: 'claude-cli',
      providerName: 'Claude Code',
      workspace: '/tmp/a',
      lastUsedAt: 5,
    });
    const withB = appendRecentActivity(withA, {
      kind: 'acp',
      providerType: 'agent-acp',
      providerName: 'ACP',
      workspace: '/tmp/b',
      lastUsedAt: 50,
    });

    const result = getRecentActivity(withB);
    expect(result.map((entry) => entry.lastUsedAt)).toEqual([50, 5]);
  });

  it('writes summary metadata without duplicating currentModel in new recent activity entries', () => {
    const next = appendRecentActivity(createState(), {
      kind: 'cli',
      providerType: 'codex',
      providerName: 'Codex',
      providerSessionId: 'sess-2',
      workspace: '/repo',
      summaryMetadata: {
        items: [{ id: 'model', value: 'gpt-5.4', shortValue: 'gpt-5.4', order: 10 }],
      },
      lastUsedAt: 33,
    } as any)

    expect(next.recentActivity[0]?.summaryMetadata).toEqual({
      items: [{ id: 'model', value: 'gpt-5.4', shortValue: 'gpt-5.4', order: 10 }],
    })
    expect(next.recentActivity[0]).not.toHaveProperty('currentModel')
  })

  it('does not upgrade legacy currentModel when reading old recent activity after compat removal', () => {
    const state = createState()
    state.recentActivity = [{
      id: 'cli:codex:session:sess-legacy',
      kind: 'cli',
      providerType: 'codex',
      providerName: 'Codex',
      providerSessionId: 'sess-legacy',
      workspace: '/repo',
      currentModel: 'gpt-5.4',
      lastUsedAt: 99,
    } as any]

    const result = getRecentActivity(state)
    expect(result[0]?.summaryMetadata).toBeUndefined()
  })

  it('marks session seen monotonically and only updates marker when provided', () => {
    const state = createState();
    const first = markSessionSeen(state, 'session-1', 100, 'done-1');
    const second = markSessionSeen(first, 'session-1', 50, null);

    expect(second.sessionReads['session-1']).toBe(100);
    expect(second.sessionReadMarkers['session-1']).toBe('done-1');
  });

  it('reuses providerSessionId read markers across runtime session id churn', () => {
    const state = createState();
    const first = markSessionSeen(state, 'runtime-a', 100, 'done-1', 'provider-1');

    expect(getSessionSeenAt(first, 'runtime-b', 'provider-1')).toBe(100);
    expect(getSessionSeenMarker(first, 'runtime-b', 'provider-1')).toBe('done-1');
    expect(first.sessionReads['provider:provider-1']).toBe(100);
    expect(first.sessionReadMarkers['provider:provider-1']).toBe('done-1');
  });
});
