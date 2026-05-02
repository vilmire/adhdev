import { describe, expect, it, vi } from 'vitest';
import { DaemonCommandHandler } from '../../src/commands/handler.js';

/**
 * Tests for the onBeforeSendChat hook in DaemonCommandHandler.
 * Verifies the hook fires at the right time with the right params.
 */

function makeSession(sessionId: string, workspace: string) {
  return {
    sessionId,
    providerType: 'test-provider',
    cdpManagerKey: undefined,
    transport: 'cli' as const,
  };
}

function makeHandler({
  onBeforeSendChat,
  sessionId,
  workspace,
}: {
  onBeforeSendChat?: (params: { workspace: string; sessionId: string }) => void;
  sessionId?: string;
  workspace?: string;
}) {
  const session = sessionId && workspace ? makeSession(sessionId, workspace) : undefined;

  const instanceManager = workspace && sessionId
    ? {
        getInstance: (id: string) => {
          if (id === sessionId) {
            return {
              getState: () => ({ workspace }),
              category: 'cli',
              type: 'test-provider',
            };
          }
          return null;
        },
      }
    : { getInstance: () => null };

  const sessionRegistry = session
    ? {
        get: (id: string) => (id === sessionId ? session : undefined),
      }
    : {
        get: () => undefined,
      };

  return new DaemonCommandHandler({
    cdpManagers: new Map(),
    ideType: '',
    adapters: new Map(),
    instanceManager: instanceManager as any,
    sessionRegistry: sessionRegistry as any,
    onBeforeSendChat,
    // Minimal stub: send_chat will fail gracefully without a real adapter
  } as any);
}

describe('onBeforeSendChat hook', () => {
  it('fires with workspace and sessionId before send_chat is dispatched', async () => {
    const onBeforeSendChat = vi.fn();
    const handler = makeHandler({
      onBeforeSendChat,
      sessionId: 'sess-1',
      workspace: '/repo/project',
    });

    // send_chat will fail (no real CLI adapter) but the hook fires before dispatch
    await handler.handle('send_chat', { targetSessionId: 'sess-1' });

    expect(onBeforeSendChat).toHaveBeenCalledTimes(1);
    expect(onBeforeSendChat).toHaveBeenCalledWith({
      workspace: '/repo/project',
      sessionId: 'sess-1',
    });
  });

  it('does NOT fire for non-send_chat commands', async () => {
    const onBeforeSendChat = vi.fn();
    const handler = makeHandler({
      onBeforeSendChat,
      sessionId: 'sess-1',
      workspace: '/repo/project',
    });

    await handler.handle('read_chat', { targetSessionId: 'sess-1' });
    await handler.handle('git_status', { workspace: '/repo/project' });

    expect(onBeforeSendChat).not.toHaveBeenCalled();
  });

  it('does NOT fire if no workspace is resolvable for the session', async () => {
    const onBeforeSendChat = vi.fn();
    // instanceManager returns null instance (no workspace)
    const handler = new DaemonCommandHandler({
      cdpManagers: new Map(),
      ideType: '',
      adapters: new Map(),
      instanceManager: { getInstance: () => null } as any,
      sessionRegistry: {
        get: (id: string) => id === 'sess-noworkspace'
          ? { sessionId: 'sess-noworkspace', providerType: 'cli', cdpManagerKey: undefined }
          : undefined,
      } as any,
      onBeforeSendChat,
    } as any);

    await handler.handle('send_chat', { targetSessionId: 'sess-noworkspace' });

    expect(onBeforeSendChat).not.toHaveBeenCalled();
  });

  it('does NOT fire if no session is in route (no targetSessionId)', async () => {
    const onBeforeSendChat = vi.fn();
    const handler = makeHandler({ onBeforeSendChat });

    // No targetSessionId → no session in route
    await handler.handle('send_chat', {});

    expect(onBeforeSendChat).not.toHaveBeenCalled();
  });

  it('send_chat is not blocked if onBeforeSendChat throws', async () => {
    const onBeforeSendChat = vi.fn(() => {
      throw new Error('hook error');
    });
    const handler = makeHandler({
      onBeforeSendChat,
      sessionId: 'sess-1',
      workspace: '/repo/project',
    });

    // Should not throw — hook errors are swallowed
    const result = await handler.handle('send_chat', { targetSessionId: 'sess-1' });
    // Result will be failure (no real chat adapter) but not an unhandled error
    expect(typeof result.success).toBe('boolean');
    expect(onBeforeSendChat).toHaveBeenCalledTimes(1);
  });
});
