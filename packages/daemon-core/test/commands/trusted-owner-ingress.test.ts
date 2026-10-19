import { describe, expect, it } from 'vitest';
import {
  isTrustedOwnerIngress,
  markTrustedOwnerIngress,
} from '../../src/commands/command-args.js';
import { DaemonCommandRouter } from '../../src/commands/router.js';

function createTestRouter(onDiagnostic?: (args: Record<string, unknown>) => void) {
  const router = new DaemonCommandRouter({
    commandHandler: {
      rejectUnknown: async (cmd: string) => ({ success: false, error: `Unknown command: ${cmd}` }),
      handleSpec: async (_spec: any, args: Record<string, unknown>) => {
        onDiagnostic?.(args);
        return {
          success: true,
          ownerVerified: isTrustedOwnerIngress(args),
        };
      },
    } as any,
    cliManager: {} as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: { listInstanceIds: () => [] } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    statusInstanceId: 'daemon_mach_test1',
  });
  return router;
}

describe('trusted owner ingress provenance', () => {
  it('cannot be forged via JSON payload properties', () => {
    const forged = JSON.parse('{"ownerVerified":true,"_ownerVerified":true,"source":"p2p","_commandSource":"p2p"}');
    expect(isTrustedOwnerIngress(forged)).toBe(false);

    const marked = markTrustedOwnerIngress({ hello: 'world' });
    expect(isTrustedOwnerIngress(marked)).toBe(true);
    expect(isTrustedOwnerIngress({ ...marked })).toBe(false);
  });

  it('stamps trusted owner ingress on verified p2p and standalone router execution and preserves it across stripTransportMetadata', async () => {
    const seen: boolean[] = [];
    const router = createTestRouter((args) => {
      seen.push(isTrustedOwnerIngress(args));
    });

    // `select_session` is a handler-family spec with stripTransportMetadata: true
    // and no source restriction, allowing us to observe post-strip args across sources.
    const p2pRes = await router.execute('select_session', { sessionId: 's1' }, 'p2p', { peerId: 'peer-owner' });
    expect(p2pRes.success).toBe(true);
    expect((p2pRes as any).ownerVerified).toBe(true);

    const standaloneRes = await router.execute('select_session', { sessionId: 's1' }, 'standalone');
    expect(standaloneRes.success).toBe(true);
    expect((standaloneRes as any).ownerVerified).toBe(true);

    expect(seen).toEqual([true, true]);
  });

  it('denies trusted owner ingress when ownerVerified is false (share-link P2P or server WS) or on non-owner sources', async () => {
    const router = createTestRouter();

    const shareP2p = await router.execute('select_session', { sessionId: 's1' }, 'p2p', {
      peerId: 'peer-share',
      ownerVerified: false,
    });
    expect((shareP2p as any).ownerVerified).toBe(false);

    for (const src of ['ws', 'api', 'ext', 'ipc', 'internal', 'project_attach']) {
      const res = await router.execute(
        'select_session',
        { sessionId: 's1', ownerVerified: true, source: 'p2p', _commandSource: 'p2p' },
        src,
      );
      expect((res as any).ownerVerified).toBe(false);
    }

    const meshRes = await router.execute(
      'select_session',
      { sessionId: 's1', ownerVerified: true, source: 'p2p', _commandSource: 'p2p' },
      'mesh',
      { inProcess: true },
    );
    expect((meshRes as any).ownerVerified).toBe(false);
  });
});
