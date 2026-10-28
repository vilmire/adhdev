import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/transfer-fs/index.js', async (orig) => {
  const real = await orig<typeof import('../../src/transfer-fs/index.js')>();
  return { ...real, getBindingInfo: () => { throw new Error('Unable to load transfer_fs_node native binding'); } };
});

import { LinkBroker, makeSide, writeTree, type Side } from './helpers.js';

describe('A14 native helper unavailable', () => {
  it('refuses to create or accept transfers and never falls back to pure Node', async () => {
    const peers = new Map<string, Side>();
    const a = makeSide('daemon_mach_a', new LinkBroker(), peers);
    const b = makeSide('daemon_mach_b', new LinkBroker(), peers);
    expect(a.engine.capabilities()).toMatchObject({ supported: false, reasons: ['NATIVE_HELPER_UNAVAILABLE'] });
    writeTree(a.ws.path, { 'p/x': '1' });
    expect(await a.engine.create({ workspaceId: a.ws.id, selected: ['p'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'f' }))
      .toMatchObject({ ok: false, code: 'NATIVE_HELPER_UNAVAILABLE' });
    expect(await b.engine.handlePeerOp(a.id, { op: 'offer', transferId: 'a'.repeat(32), selection: {}, selectionDigest: 'x' }))
      .toMatchObject({ ok: false, code: 'NATIVE_HELPER_UNAVAILABLE' });
  });
});
