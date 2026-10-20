import { describe, expect, it } from 'vitest';
import {
  attachTrustedOwnerIngressProof,
  isTrustedOwnerIngress,
  issueTrustedOwnerIngressProof,
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
  it('cannot be forged via JSON payload properties or unmarked/unproven mint calls and revokes when current proof becomes invalid', () => {
    const forged = JSON.parse('{"ownerVerified":true,"_ownerVerified":true,"source":"p2p","_commandSource":"p2p"}');
    expect(isTrustedOwnerIngress(forged)).toBe(false);

    // Calling markTrustedOwnerIngress without a valid proof token must fail closed
    const unproven = markTrustedOwnerIngress({ hello: 'world' }, undefined);
    expect(isTrustedOwnerIngress(unproven)).toBe(false);
    const fakeProofMarked = markTrustedOwnerIngress({ hello: 'world' }, {} as any);
    expect(isTrustedOwnerIngress(fakeProofMarked)).toBe(false);

    let live = true;
    const proof = issueTrustedOwnerIngressProof({
      source: 'standalone',
      ownerVerified: true,
      verifyCurrent: () => live,
    });
    expect(proof).not.toBeNull();
    const marked = markTrustedOwnerIngress({ hello: 'world' }, proof);
    expect(isTrustedOwnerIngress(marked)).toBe(true);
    expect(isTrustedOwnerIngress({ ...marked })).toBe(false);

    // Revoking current auth/channel state invalidates existing marked args immediately
    live = false;
    expect(isTrustedOwnerIngress(marked)).toBe(false);
  });

  it('stamps trusted owner ingress on verified p2p and standalone router execution and preserves it across stripTransportMetadata', async () => {
    const seen: boolean[] = [];
    const router = createTestRouter((args) => {
      seen.push(isTrustedOwnerIngress(args));
    });

    // `select_session` is a handler-family spec with stripTransportMetadata: true
    // and no source restriction, allowing us to observe post-strip args across sources.
    const p2pRes = await router.execute('select_session', { sessionId: 's1' }, 'p2p', {
      peerId: 'peer-owner',
      ownerVerified: true,
    });
    expect(p2pRes.success).toBe(true);
    expect((p2pRes as any).ownerVerified).toBe(true);

    const standaloneRes = await router.execute('select_session', { sessionId: 's1' }, 'standalone', {
      ownerVerified: true,
    });
    expect(standaloneRes.success).toBe(true);
    expect((standaloneRes as any).ownerVerified).toBe(true);

    // Transport-attached proof also survives even if 4th opts argument is omitted by a wrapper
    const transportPayload = attachTrustedOwnerIngressProof(
      { sessionId: 's1' },
      issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true }),
    );
    const attachedRes = await router.execute('select_session', transportPayload, 'standalone');
    expect(attachedRes.success).toBe(true);
    expect((attachedRes as any).ownerVerified).toBe(true);

    expect(seen).toEqual([true, true, true]);
  });

  it('denies trusted owner ingress when ownerVerified is missing, non-boolean, or false, or on non-owner sources', async () => {
    const router = createTestRouter();

    // Omitted opts or omitted ownerVerified on p2p/standalone must fail closed
    const missingOptsP2p = await router.execute('select_session', { sessionId: 's1' }, 'p2p');
    expect((missingOptsP2p as any).ownerVerified).toBe(false);
    const peerOnlyP2p = await router.execute('select_session', { sessionId: 's1' }, 'p2p', { peerId: 'peer-owner' });
    expect((peerOnlyP2p as any).ownerVerified).toBe(false);
    const missingOptsStandalone = await router.execute('select_session', { sessionId: 's1' }, 'standalone');
    expect((missingOptsStandalone as any).ownerVerified).toBe(false);

    for (const source of ['p2p', 'standalone'] as const) {
      for (const badValue of [false, undefined, null, 0, '', 'true', {}]) {
        const res = await router.execute('select_session', { sessionId: 's1' }, source, {
          peerId: 'peer-1',
          ownerVerified: badValue as any,
        });
        expect((res as any).ownerVerified).toBe(false);
      }
    }

    for (const src of ['ws', 'api', 'ext', 'ipc', 'internal', 'project_attach']) {
      const res = await router.execute(
        'select_session',
        { sessionId: 's1', ownerVerified: true, source: 'p2p', _commandSource: 'p2p' },
        src,
        { ownerVerified: true },
      );
      expect((res as any).ownerVerified).toBe(false);
    }

    const meshRes = await router.execute(
      'select_session',
      { sessionId: 's1', ownerVerified: true, source: 'p2p', _commandSource: 'p2p' },
      'mesh',
      { inProcess: true, ownerVerified: true },
    );
    expect((meshRes as any).ownerVerified).toBe(false);
  });
});
