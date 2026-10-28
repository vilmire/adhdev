import { afterEach, describe, expect, it } from 'vitest';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { configureProjectTransfer, resetProjectTransferForTest } from '../../src/transfer/runtime.js';
import { LinkBroker, makeSide, writeTree, type Side } from './helpers.js';

afterEach(() => resetProjectTransferForTest());

const OWNER = ['project_transfer_capabilities', 'project_transfer_browse', 'project_transfer_create', 'project_transfer_approve',
  'project_transfer_revoke_approval', 'project_transfer_cancel', 'project_transfer_list', 'project_transfer_status'];

describe('A13 owner-only commands', () => {
  it('owner commands accept only p2p/standalone sources and are not mesh-capable', () => {
    for (const name of OWNER) {
      const spec = getDaemonCommandRegistry().get(name)!;
      expect(spec.sources, name).toEqual(['p2p', 'standalone']);
    }
    const peer = getDaemonCommandRegistry().get('project_transfer_peer')!;
    expect(peer.sources).toEqual(['mesh']);
    expect(peer.meshSender).toBe('authenticated_peer');
  });

  it('refuses owner commands without a trusted-owner ingress proof, even with forged payload fields', async () => {
    const peers = new Map<string, Side>();
    const side = makeSide('daemon_mach_a', new LinkBroker(), peers);
    configureProjectTransfer(side.ports);
    for (const name of OWNER) {
      const spec = getDaemonCommandRegistry().get(name)!;
      const res = await (spec.run as any)({}, { ownerVerified: true, _commandSource: 'p2p', source: 'p2p', transferId: 'x', workspaceId: side.ws.id });
      expect(res, name).toMatchObject({ success: false, code: 'OWNER_INGRESS_REQUIRED' });
    }
  });

  it('peer op requires a transport-stamped sender that is the record peer', async () => {
    const peers = new Map<string, Side>();
    const a = makeSide('daemon_mach_a', new LinkBroker(), peers);
    const b = makeSide('daemon_mach_b', new LinkBroker(), peers);
    configureProjectTransfer(b.ports);
    writeTree(a.ws.path, { 'p/x': '1' });
    const c = await a.engine.create({ workspaceId: a.ws.id, selected: ['p'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'f' });
    if (!c.ok) throw new Error(c.code);
    const spec = getDaemonCommandRegistry().get('project_transfer_peer')!;
    const noSender = await (spec.run as any)({}, { op: 'cancel', transferId: c.transferId });
    expect(noSender).toMatchObject({ success: false, code: 'PEER_UNAUTHORIZED' });
    const wrong = await (spec.run as any)({}, { op: 'cancel', transferId: c.transferId, [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_mach_evil' });
    expect(wrong).toMatchObject({ success: false });
    // A payload-claimed sender id inside nested args is never read.
    const nested = await (spec.run as any)({}, { op: 'cancel', transferId: c.transferId, selection: { sourceDaemonId: a.id } });
    expect(nested).toMatchObject({ success: false, code: 'PEER_UNAUTHORIZED' });
    expect(b.engine.get(c.transferId)?.state).toBe('offered');
    a.engine.shutdown(); b.engine.shutdown();
  });

  it('an unconfigured daemon (standalone/no engine) answers TRANSFER_UNAVAILABLE', async () => {
    const spec = getDaemonCommandRegistry().get('project_transfer_peer')!;
    expect(await (spec.run as any)({}, { op: 'offer', [MESH_SENDER_DAEMON_ID_ARG]: 'x' })).toMatchObject({ success: false, code: 'TRANSFER_UNAVAILABLE' });
  });
});
