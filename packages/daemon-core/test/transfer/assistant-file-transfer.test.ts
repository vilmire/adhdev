/**
 * Daemon-level coverage of `assistant_file_transfer` (owner decision 2026-11-02 section 6): the bound
 * assistant can request / status / cancel its OWN transfers, never approve, and may export only the
 * workspaces of the project it is authorized for; another machine only when it is a node of that project.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testConfigDir = join(tmpdir(), `adhdev-xfer-asst-${randomUUID().slice(0, 8)}`, '.adhdev');
const cfg = vi.hoisted(() => ({ workspaces: [] as Array<{ id: string; path: string; label?: string }> }));
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => { if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true }); return testConfigDir; },
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
  loadConfig: () => ({ workspaces: cfg.workspaces }),
}));
const asst = { sid: 'assistant-session-1' };
vi.mock('../../src/assistant/assistant-registry.js', () => ({
  getAssistantRegistry: () => ({ read: () => ({ sessionId: asst.sid }), reload: () => ({ sessionId: asst.sid }) }),
}));

import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { __resetMcpSessionCredentialsForTest, mintMcpSessionCredential } from '../../src/commands/mcp-command-ingress.js';
import { loadMeshConfig, saveMeshConfig } from '../../src/config/mesh-config-store.js';
import { buildOwnerDecisions } from '../../src/mesh/mesh-mission-decisions.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { configureProjectTransfer, resetProjectTransferForTest } from '../../src/transfer/runtime.js';
import { setWorkspaceLookupForTest } from '../../src/transfer/workspace-lookup.js';
import { setMeshScopeResolverForTest } from '../../src/transfer/workspace-scope.js';
import { LinkBroker, makeSide, tmpDir, writeTree, type Side } from './helpers.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const cleanups: Array<() => void> = [];
let meshId = '';
let hosted = true;
let a: Side; let s: Side; let b: Side;
let otherWs = '';

const meshEntry = (): LocalMeshEntry => ({
  id: meshId, name: 'Blog', repoIdentity: 'github.com/acme/blog',
  nodes: [
    { id: 'n-a', workspace: a.ws.path, daemonId: 'daemon_mach_a' },
    { id: 'n-s', workspace: s.ws.path, daemonId: 'daemon_mach_s' },
  ],
}) as unknown as LocalMeshEntry;

beforeEach(() => {
  meshId = `asst-xfer-${randomUUID().slice(0, 8)}`;
  hosted = true;
  const broker = new LinkBroker();
  const peers = new Map<string, Side>();
  a = makeSide('daemon_mach_a', broker, peers);
  s = makeSide('daemon_mach_s', broker, peers);
  b = makeSide('daemon_mach_b', broker, peers);
  a.engine.shutdown();
  a.engine = configureProjectTransfer(a.ports);
  cleanups.push(() => { a.engine.shutdown(); s.engine.shutdown(); b.engine.shutdown(); });
  for (const side of [a, s, b]) side.engine.setAgentAutoApprove(false); // shipped default is ON (2026-11-08); these tests pin the asking path
  writeTree(a.ws.path, { 'proj/a.txt': 'local' });
  writeTree(s.ws.path, { 'proj/s.txt': 'remote' });
  otherWs = tmpDir('other');
  writeTree(otherWs, { 'x.txt': 'x' });
  cfg.workspaces = [{ id: a.ws.id, path: a.ws.path, label: 'src' }, { id: 'ws-other', path: otherWs, label: 'other' }];
  saveMeshConfig({ ...loadMeshConfig(), meshes: [meshEntry()] as any });
  setWorkspaceLookupForTest((q) => (q === 'src' ? { id: a.ws.id, path: a.ws.path, label: 'src' } : q === 'other' ? { id: 'ws-other', path: otherWs, label: 'other' } : q === 'ssrc' ? { id: s.ws.id, path: s.ws.path, label: 'ssrc' } : null));
  // the OTHER machines answer from their own mesh view: s and b know only their own project workspace
  setMeshScopeResolverForTest((mesh, machine, via) => {
    if (!mesh || (via && !peers.has(via))) return null;
    const side = peers.get(machine);
    return side ? { workspaces: [{ id: side.ws.id, path: side.ws.path, label: side.id === 'daemon_mach_b' ? 'dst' : 'ssrc' }] } : null;
  });
  setAssistantServicesForTests(createAssistantServices({ configDir: testConfigDir, listMeshes: () => [meshEntry()] }));
  setAssistantProjectPortsForTests(() => ({
    selfDaemonId: () => 'daemon_mach_a',
    listMeshes: () => [meshEntry()],
    isHostedHere: () => hosted,
    aliases: () => ({}),
    coordinators: () => [],
    lastCoordinatorSessionId: () => null,
    queueCounts: () => ({ pending: 0, assigned: 0, failed: 0 }),
    activeMissionCount: () => 0,
    pendingApprovals: () => 0,
    relay: { openThread: vi.fn(), isThreadOpen: () => false, lastRelayAt: () => 0 },
    execute: vi.fn(async () => ({ success: true })) as any,
    remoteHost: () => ({ label: 'host-box', hostDaemonId: 'daemon_mach_h', hostMeshId: meshId, reachable: true }),
    callHost: vi.fn() as any,
    coordinatorTurns: () => ({ open: false, committed: [] }),
    meshStatusLine: () => null,
  }) as unknown as AssistantProjectPorts);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetProjectTransferForTest();
  setWorkspaceLookupForTest(null);
  setMeshScopeResolverForTest(null);
  setAssistantProjectPortsForTests(null);
  setAssistantServicesForTests(null);
  __resetMcpSessionCredentialsForTest();
  try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh */ }
  MeshRuntimeStore.resetForTests();
  try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

const verb = () => getDaemonCommandRegistry().get(ASSISTANT_VERB.fileTransfer)!;
function call(args: Record<string, unknown>, o: { sid?: string; coordinator?: boolean; credential?: boolean } = {}): Promise<Record<string, any>> {
  const sid = o.sid ?? asst.sid;
  const raw: Record<string, unknown> = { project: 'Blog', assistantSessionId: sid, ...args };
  if (o.credential !== false) raw.mcpSessionCredential = mintMcpSessionCredential({ sessionId: sid, isCoordinator: o.coordinator === true });
  return (verb().run as any)({}, raw);
}
const REQ = { action: 'request', from_workspace: 'src', selected: ['proj'], to_daemon_id: 'daemon_mach_b', to_workspace: 'dst', final_name: 'incoming' };

describe('assistant_file_transfer (daemon level)', () => {
  it('requests a transfer for the project, stamps the assistant as requester and only raises an owner decision', async () => {
    const r = await call(REQ);
    expect(r).toMatchObject({ success: true, awaitingOwner: true, autoApproved: false, files: 1 });
    const rec = a.engine.get(r.transferId)!;
    expect(rec.requestedBy).toEqual({ role: 'assistant', sessionId: asst.sid });
    expect(rec.localApproval).toBeUndefined();
    const [d] = buildOwnerDecisions(meshId);
    expect(d!.transferId).toBe(r.transferId);
    expect(d!.question).toMatch(/^Assistant:/);
    expect(`${d!.question} ${d!.context}`).not.toMatch(/a\.txt|proj\//);
  });

  it('only the bound assistant session with its own credential may call it', async () => {
    expect(await call(REQ, { credential: false })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
    expect(await call(REQ, { coordinator: true })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
    expect(await call(REQ, { sid: 'someone-else' })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
    expect(a.engine.list()).toEqual([]);
  });

  it('status and cancel cover only its own requests', async () => {
    const r = await call(REQ);
    const o = await a.engine.create({ workspaceId: a.ws.id, selected: ['proj'], targetDaemonId: 'daemon_mach_b', targetWorkspaceId: b.ws.id, finalName: 'owner' });
    if (!o.ok) throw new Error(o.code);
    expect((await call({ action: 'status' })).transfers.map((t: any) => t.transferId)).toEqual([r.transferId]);
    expect(await call({ action: 'cancel', transfer_id: o.transferId })).toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(await call({ action: 'cancel', transfer_id: r.transferId })).toMatchObject({ success: true, state: 'cancelled' });
    expect(buildOwnerDecisions(meshId)).toHaveLength(0);
  });

  it('refuses a registered workspace that is not a node of the authorized project', async () => {
    expect(await call({ ...REQ, from_workspace: 'other' })).toMatchObject({ success: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
    expect(a.engine.list()).toEqual([]);
  });

  it('a followed remote project (not hosted here) is refused clearly', async () => {
    hosted = false;
    expect(await call(REQ)).toMatchObject({ success: false, code: 'remote_project_unsupported' });
  });

  it('another machine as the source: only a node of this project; the source daemon raises the decision', async () => {
    expect(await call({ ...REQ, from_daemon_id: 'daemon_mach_stranger', from_workspace: 'ssrc' })).toMatchObject({ success: false, code: 'machine_not_in_project' });
    const r = await call({ ...REQ, from_daemon_id: 'daemon_mach_s', from_workspace: 'ssrc' });
    expect(r).toMatchObject({ success: true, awaitingOwner: true, sourceMachine: 'daemon_mach_s' });
    expect(a.engine.get(r.transferId)).toBeNull();
    expect(s.engine.get(r.transferId)!.requestedBy).toEqual({ role: 'assistant', sessionId: asst.sid, viaDaemonId: 'daemon_mach_a' });
    expect(await call({ action: 'status', transfer_id: r.transferId })).toMatchObject({ success: true, state: 'previewed' });
  });
});
