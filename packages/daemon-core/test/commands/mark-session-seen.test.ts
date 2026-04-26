import { beforeEach, describe, expect, it, vi } from 'vitest';

const stateStore = vi.hoisted(() => ({
  current: {
    recentActivity: [],
    savedProviderSessions: [],
    sessionReads: {},
    sessionReadMarkers: {},
    sessionNotificationDismissals: {},
    sessionNotificationUnreadOverrides: {},
  } as any,
  saved: [] as any[],
}));

vi.mock('../../src/config/state-store.js', () => ({
  loadState: () => stateStore.current,
  saveState: (next: any) => {
    stateStore.current = next;
    stateStore.saved.push(next);
  },
}));

vi.mock('../../src/logging/command-log.js', () => ({
  logCommand: vi.fn(),
}));

import { DaemonCommandRouter } from '../../src/commands/router.js';

function createRouter() {
  const allStates = [{
    category: 'cli',
    type: 'cursor-cli',
    name: 'Cursor CLI',
    instanceId: 'runtime-session-1',
    providerSessionId: 'provider-session-1',
    status: 'idle',
    workspace: '/repo',
    mode: 'chat',
    activeChat: {
      title: 'Cursor task',
      status: 'idle',
      messages: [{ role: 'assistant', id: 'runtime-recomputed-marker', content: 'done' }],
    },
  }];

  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) },
    cliManager: { handleCliCommand: vi.fn(async () => ({ success: false })) },
    cdpManagers: new Map(),
    providerLoader: {},
    instanceManager: { collectAllStates: () => allStates },
    detectedIdes: { value: [] },
    sessionRegistry: {},
    onStatusChange: vi.fn(),
  } as any);
}

describe('mark_session_seen command', () => {
  beforeEach(() => {
    stateStore.current = {
      recentActivity: [],
      savedProviderSessions: [],
      sessionReads: {},
      sessionReadMarkers: {},
      sessionNotificationDismissals: {},
      sessionNotificationUnreadOverrides: {},
    };
    stateStore.saved = [];
  });

  it('persists the dashboard-observed completion marker instead of recomputing a different live marker', async () => {
    const router = createRouter();

    const result = await router.execute('mark_session_seen', {
      sessionId: 'runtime-session-1',
      seenAt: 1234,
      completionMarker: 'turn:dashboard-observed-marker',
    }, 'p2p');

    expect(result.success).toBe(true);
    expect(result.completionMarker).toBe('turn:dashboard-observed-marker');
    expect(stateStore.saved).toHaveLength(1);
    expect(stateStore.current.sessionReads['runtime-session-1']).toBe(1234);
    expect(stateStore.current.sessionReadMarkers['runtime-session-1']).toBe('turn:dashboard-observed-marker');
    expect(stateStore.current.sessionReadMarkers['provider:provider-session-1']).toBe('turn:dashboard-observed-marker');
  });
});
