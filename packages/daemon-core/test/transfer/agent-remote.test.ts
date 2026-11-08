import * as fs from 'node:fs';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testConfigDir = join(tmpdir(), `adhdev-xfer-remote-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => { if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true }); return testConfigDir; },
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
  loadConfig: () => ({ workspaces: [] }),
}));
vi.mock('../../src/assistant/assistant-registry.js', () => ({
  getAssistantRegistry: () => ({ read: () => ({ sessionId: 'assistant-session-1' }), reload: () => ({ sessionId: 'assistant-session-1' }) }),
}));
const coordinatorMesh = vi.hoisted(() => ({ meshId: '' }));
vi.mock('../../src/mesh/coordinator-registry.js', async (orig) => ({
  ...(await orig() as object),
  getCoordinatorForSession: (sid: string) => (sid === 'coord-session-1' || sid === 'coord-session-2' ? { meshId: coordinatorMesh.meshId } : undefined),
}));

import { COMMAND_SOURCE_ARG } from '../../src/commands/command-args.js';
import { attachIpcMcpAuthority } from '../../src/commands/mcp-authority-attach.js';
import { __resetMcpSessionCredentialsForTest, mintMcpSessionCredential } from '../../src/commands/mcp-command-ingress.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { answerMissionDecision, buildOwnerDecisions } from '../../src/mesh/mesh-mission-decisions.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { configureProjectTransfer, resetProjectTransferForTest } from '../../src/transfer/runtime.js';
import { setWorkspaceLookupForTest } from '../../src/transfer/workspace-lookup.js';
import { setMeshScopeResolverForTest } from '../../src/transfer/workspace-scope.js';
import { LinkBroker, makeSide, readTree, tmpDir, waitFor, writeTree, type Side } from './helpers.js';

const cleanups: Array<() => void> = [];
let meshId = '';

beforeEach(() => { meshId = `xfer-${randomUUID().slice(0, 8)}`; coordinatorMesh.meshId = meshId; });
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetProjectTransferForTest();
  setWorkspaceLookupForTest(null);
  setMeshScopeResolverForTest(null);
  __resetMcpSessionCredentialsForTest();
  try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh */ }
  MeshRuntimeStore.resetForTests();
  try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});


interface World { a: Side; s: Side; b: Side; peers: Map<string, Side> }

/** a = the machine the agent is attached to, s = holds the files, b = a third machine. */
function world(files: Record<string, string>, dst: Record<string, string> = {}): World {
  const broker = new LinkBroker();
  const peers = new Map<string, Side>();
  const a = makeSide('daemon_mach_a', broker, peers);
  const s = makeSide('daemon_mach_s', broker, peers);
  const b = makeSide('daemon_mach_b', broker, peers);
  a.engine.shutdown();
  a.engine = configureProjectTransfer(a.ports); // the process-wide engine is the agent's daemon
  cleanups.push(() => { a.engine.shutdown(); s.engine.shutdown(); b.engine.shutdown(); });
  for (const side of [a, s, b]) side.engine.setAgentAutoApprove(false); // shipped default is ON (2026-11-08); these tests pin the asking path
  writeTree(s.ws.path, files);
  writeTree(b.ws.path, dst);
  const extra = tmpDir('s-other');
  writeTree(extra, { 'private.txt': 'not this project' });
  setWorkspaceLookupForTest((q) => {
    if (q === s.ws.id || q === 'src') return { id: s.ws.id, path: s.ws.path, label: 'src' };
    if (q === 'unscoped' || q === extra) return { id: 'ws-unscoped', path: extra, label: 'unscoped' };
    return null;
  });
  const label: Record<string, string> = { daemon_mach_a: 'adst', daemon_mach_s: 'src', daemon_mach_b: 'dst' };
  setMeshScopeResolverForTest((mesh, machine, via) => {
    if (!mesh) return null;
    if (via && !peers.has(via)) return null;
    const side = peers.get(machine);
    return side ? { workspaces: [{ id: side.ws.id, path: side.ws.path, label: label[side.id] }] } : null;
  });
  return { a, s, b, peers };
}

const spec = (name: string) => getDaemonCommandRegistry().get(name)!;

async function agent(args: Record<string, unknown>, o: { session?: string } = {}) {
  const raw: Record<string, unknown> = { ...args };
  const token = mintMcpSessionCredential({ sessionId: o.session ?? 'coord-session-1', meshId, isCoordinator: true });
  attachIpcMcpAuthority(raw, 'project_transfer_agent', { sessionCredential: token });
  raw[COMMAND_SOURCE_ARG] = 'ipc';
  return (await (spec('project_transfer_agent').run as any)({}, raw)) as Record<string, any>;
}

const REMOTE = { action: 'request', fromDaemonId: 'daemon_mach_s', fromWorkspace: 'src', selected: ['proj'], toDaemonId: 'daemon_mach_b', toWorkspace: 'dst', finalName: 'incoming' };

describe('remote source: an agent pulls files FROM another machine', () => {
  it('forwards to the source daemon, which creates the record and raises the owner decision (never approving)', async () => {
    const { a, s, b } = world({ 'proj/secret-name-report.txt': 'x', 'proj/b.txt': 'yy', 'proj/.env': 'KEY=1' });
    const r = await agent(REMOTE);
    expect(r).toMatchObject({ success: true, autoApproved: false, awaitingOwner: true, files: 2, excluded: 1, state: 'previewed', sourceMachine: 'daemon_mach_s' });
    expect(a.engine.get(r.transferId)).toBeNull(); // the record lives on the source, not on the agent's daemon
    const rec = s.engine.get(r.transferId)!;
    expect(rec.role).toBe('source');
    expect(rec.requestedBy).toEqual({ role: 'coordinator', sessionId: 'coord-session-1', viaDaemonId: 'daemon_mach_a' });
    expect(rec.localApproval).toBeUndefined();
    expect(b.engine.get(r.transferId)!.requestedBy?.viaDaemonId).toBe('daemon_mach_a');
    const [d] = buildOwnerDecisions(meshId);
    expect(d!.transferId).toBe(r.transferId);
    expect(`${d!.question} ${d!.context}`).not.toMatch(/secret-name|proj\/|\.txt|\.env/);
    expect(d!.question.length).toBeLessThanOrEqual(120);
  });

  it('completes only after the owner approves both daemons; status/cancel route to the source by themselves', async () => {
    const { s, b } = world({ 'proj/a.txt': 'hello' });
    const r = await agent(REMOTE);
    const id = r.transferId as string;
    const digest = s.engine.get(id)!.selectionDigest;
    expect(await agent({ action: 'status', transferId: id })).toMatchObject({ success: true, state: 'previewed' });
    expect((await s.engine.approve(id, digest)).ok).toBe(true);
    expect((await b.engine.approve(id, digest)).ok).toBe(true);
    await waitFor(() => b.engine.get(id)?.state === 'completed');
    expect(readTree(b.ws.path)['incoming/proj/a.txt']).toBe('hello');
    expect(await agent({ action: 'status', transferId: id })).toMatchObject({ success: true, state: 'completed' });
  });

  it('pulling to the agent\'s own machine works (target = the requesting daemon)', async () => {
    const { a, s } = world({ 'proj/a.txt': 'pull' });
    const r = await agent({ ...REMOTE, toDaemonId: 'daemon_mach_a', toWorkspace: 'adst' });
    expect(r).toMatchObject({ success: true, awaitingOwner: true });
    const digest = s.engine.get(r.transferId)!.selectionDigest;
    await s.engine.approve(r.transferId, digest);
    await a.engine.approve(r.transferId, digest);
    await waitFor(() => a.engine.get(r.transferId)?.state === 'completed');
    expect(readTree(a.ws.path)['incoming/proj/a.txt']).toBe('pull');
  });

  it('forwarding approves nothing: the source has no approval and the peer can only ask', async () => {
    const { s } = world({ 'proj/a.txt': 'x' });
    const r = await agent(REMOTE);
    const rec = s.engine.get(r.transferId)!;
    expect(rec.localApproval).toBeUndefined();
    expect(rec.peerApproved).toBeUndefined();
    // no agent op can approve: an agent_request carrying approval fields does not change anything
    const res = await s.engine.handlePeerOp('daemon_mach_a', { op: 'agent_request', caller: { role: 'coordinator', sessionId: 'coord-session-1', meshId }, request: { ...REMOTE, approve: true, approved: true }, approve: true });
    expect(res.ok).toBe(true);
    expect([...s.engine.list()].every((x) => !x.localApproval)).toBe(true);
  });
});

describe('security of the forwarded request', () => {
  it('refuses a sender that is not an authenticated peer (both ends) and the command without a transport-stamped sender', async () => {
    const { a, s } = world({ 'proj/a.txt': 'x' });
    s.authorized.value = false;
    expect(await agent(REMOTE)).toMatchObject({ success: false, code: 'PEER_UNAUTHORIZED' });
    s.authorized.value = true;
    a.authorized.value = false;
    expect(await agent(REMOTE)).toMatchObject({ success: false, code: 'PEER_UNAUTHORIZED' });
    expect(s.engine.list()).toEqual([]);
    // an unstamped project_transfer_peer command is refused before any op runs
    expect(await (spec('project_transfer_peer').run as any)({}, { op: 'agent_request' })).toMatchObject({ success: false, code: 'PEER_UNAUTHORIZED' });
    expect(spec('project_transfer_peer')).toMatchObject({ sources: ['mesh'], meshSender: 'authenticated_peer' });
  });

  it('refuses a peer that is not on the roster of the named project', async () => {
    const { s } = world({ 'proj/a.txt': 'x' });
    const res = await s.engine.handlePeerOp('daemon_mach_stranger', { op: 'agent_request', caller: { role: 'coordinator', sessionId: 'coord-session-1', meshId }, request: REMOTE });
    expect(res).toMatchObject({ ok: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
    expect(s.engine.list()).toEqual([]);
  });

  it('a registered workspace outside the project is refused, locally and remotely, with the same answer as an unknown one', async () => {
    const { s } = world({ 'proj/a.txt': 'x' });
    for (const name of ['unscoped', 'nonexistent']) {
      const remote = await agent({ ...REMOTE, fromWorkspace: name });
      expect(remote, name).toMatchObject({ success: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
      const local = await agent({ ...REMOTE, fromDaemonId: undefined, fromWorkspace: name });
      expect(local, name).toMatchObject({ success: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
    }
    expect(s.engine.list()).toEqual([]);
  });

  it('paths outside the registered project cannot be named; secrets are excluded', async () => {
    const { s } = world({ 'proj/a.txt': 'x', 'proj/.env': 'S=1', 'proj/id_rsa': 'k' });
    for (const sel of ['../outside', '/etc/hosts', 'proj/../../x']) {
      const r = await agent({ ...REMOTE, selected: [sel] });
      expect(r.success, sel).toBe(false);
    }
    const ok = await agent({ ...REMOTE, selected: ['proj'] });
    const names = s.engine.get(ok.transferId)!.selection.entries.map((e) => e.path).join(' ');
    expect(names).not.toMatch(/\.env|id_rsa/);
    expect(ok.excluded).toBeGreaterThanOrEqual(2);
  });

  it('a target workspace outside the project (or given as a path) is refused by the target machine', async () => {
    const { b } = world({ 'proj/a.txt': 'x' });
    expect(await agent({ ...REMOTE, toWorkspace: b.ws.path })).toMatchObject({ success: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
    expect(await agent({ ...REMOTE, toWorkspace: 'elsewhere' })).toMatchObject({ success: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
  });

  it('auto-approve needs EACH machine\'s own setting (source and target); the requester\'s daemon does not matter', async () => {
    const cases: Array<[boolean, boolean, boolean, boolean]> = [[false, true, true, true], [true, false, true, false], [true, true, false, false], [false, false, false, false]];
    for (const [aOn, sOn, bOn, expectAuto] of cases) {
      const { a, s, b } = world({ 'proj/a.txt': 'x' });
      a.engine.setAgentAutoApprove(aOn); s.engine.setAgentAutoApprove(sOn); b.engine.setAgentAutoApprove(bOn);
      const r = await agent(REMOTE);
      expect(r.autoApproved, `${aOn}/${sOn}/${bOn}`).toBe(expectAuto);
      if (!expectAuto) { expect(s.engine.get(r.transferId)!.localApproval).toBeUndefined(); expect(b.engine.get(r.transferId)!.localApproval).toBeUndefined(); }
      resetProjectTransferForTest(); while (cleanups.length) cleanups.pop()!();
      try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* ignore */ }
    }
  });

  it('overwrites always need the owner, even with both machines allowing auto-approve', async () => {
    const { s, b } = world({ 'proj/a.txt': 'NEW' }, { 'proj/a.txt': 'OLD' });
    s.engine.setAgentAutoApprove(true); b.engine.setAgentAutoApprove(true);
    const r = await agent({ ...REMOTE, targetMode: 'existing_path', targetDir: '' });
    expect(r).toMatchObject({ success: true, autoApproved: false, replacedFiles: 1 });
    expect(s.engine.get(r.transferId)!.localApproval).toBeUndefined();
    expect(fs.readFileSync(`${b.ws.path}/proj/a.txt`, 'utf8')).toBe('OLD');
  });

  it('status and cancel are limited to the original requester: role, session AND daemon', async () => {
    const { s } = world({ 'proj/a.txt': 'x' });
    const r = await agent(REMOTE);
    const id = r.transferId as string;
    const caller = { role: 'coordinator', sessionId: 'coord-session-1', meshId };
    // another session through the same daemon
    expect(await agent({ action: 'cancel', transferId: id, fromDaemonId: 'daemon_mach_s' }, { session: 'coord-session-2' })).toMatchObject({ success: false, code: 'NOT_FOUND' });
    // the same session id, but arriving through a different daemon (and an assistant with the same session id)
    for (const [who, c] of [['daemon_mach_b', caller], ['daemon_mach_a', { ...caller, role: 'assistant' }]] as const) {
      expect(await s.engine.handlePeerOp(who, { op: 'agent_status', caller: c, transferId: id })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(await s.engine.handlePeerOp(who, { op: 'agent_cancel', caller: c, transferId: id })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect((await s.engine.handlePeerOp(who, { op: 'agent_status', caller: c })).transfers).toEqual([]);
    }
    expect(s.engine.get(id)!.state).toBe('previewed');
    expect(await agent({ action: 'cancel', transferId: id })).toMatchObject({ success: true, state: 'cancelled' });
    expect(s.engine.get(id)!.state).toBe('cancelled');
    expect(buildOwnerDecisions(meshId)).toHaveLength(0); // the decision was withdrawn
  });

  it('an owner-created transfer on the source is not reachable through the agent ops', async () => {
    const { s, b } = world({ 'proj/a.txt': 'x' });
    const o = await s.engine.create({ workspaceId: s.ws.id, selected: ['proj'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'o' });
    if (!o.ok) throw new Error(o.code);
    expect(await agent({ action: 'cancel', transferId: o.transferId, fromDaemonId: 'daemon_mach_s' })).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });

  it('old-version peers get a clear PEER_TOO_OLD, not a hang', async () => {
    const { a } = world({ 'proj/a.txt': 'x' });
    a.ports.dispatchPeer = async () => ({ ok: false, code: 'PROTOCOL_ERROR' });
    expect(await agent(REMOTE)).toMatchObject({ success: false, code: 'PEER_TOO_OLD' });
    a.ports.dispatchPeer = async () => ({ ok: false });
    expect(await agent(REMOTE)).toMatchObject({ success: false, code: 'PEER_TOO_OLD' });
    a.ports.dispatchPeer = async () => { throw new Error('boom'); };
    expect(await agent(REMOTE)).toMatchObject({ success: false, code: 'PEER_UNREACHABLE' });
  });
});

describe('resolve_workspace peer op (path-probe hardening)', () => {
  it('answers exact id or label inside the shared project only - never a path, never an unshared mesh', async () => {
    const { b } = world({ 'proj/a.txt': 'x' });
    const ask = (query: string, mesh = meshId, from = 'daemon_mach_a') => b.engine.handlePeerOp(from, { op: 'resolve_workspace', query, meshId: mesh });
    expect(await ask('dst')).toMatchObject({ ok: true, workspaceId: b.ws.id, label: 'dst' });
    expect(await ask(b.ws.id)).toMatchObject({ ok: true, workspaceId: b.ws.id });
    expect(await ask(b.ws.path)).toMatchObject({ ok: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
    expect(await ask('unscoped')).toMatchObject({ ok: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
    expect(await ask('dst', '')).toMatchObject({ ok: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
    expect(await ask('dst', meshId, 'daemon_mach_stranger')).toMatchObject({ ok: false });
    expect(JSON.stringify(await ask('dst'))).not.toContain(b.ws.path);
  });

  it('is rate limited per peer', async () => {
    const { b } = world({ 'proj/a.txt': 'x' });
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await b.engine.handlePeerOp('daemon_mach_a', { op: 'resolve_workspace', query: `probe-${i}`, meshId });
      if (r.code === 'RATE_LIMITED') limited++;
    }
    expect(limited).toBe(10);
    // another peer has its own budget
    expect((await b.engine.handlePeerOp('daemon_mach_s', { op: 'resolve_workspace', query: 'dst', meshId })).ok).toBe(true);
  });
});

describe('coordinator workspace scope (local source)', () => {
  it('a coordinator cannot export a workspace outside its mesh from this machine', async () => {
    const { a } = world({ 'proj/a.txt': 'x' });
    writeTree(a.ws.path, { 'proj/a.txt': 'local' });
    setWorkspaceLookupForTest((q) => (q === 'mine' ? { id: a.ws.id, path: a.ws.path, label: 'mine' } : q === 'other' ? { id: 'ws-other', path: a.ws.path, label: 'other' } : null));
    const inScope = await agent({ action: 'request', fromWorkspace: 'mine', selected: ['proj'], toDaemonId: 'daemon_mach_b', toWorkspace: 'dst', finalName: 'f' });
    expect(inScope.success).toBe(true);
    expect(await agent({ action: 'request', fromWorkspace: 'other', selected: ['proj'], toDaemonId: 'daemon_mach_b', toWorkspace: 'dst', finalName: 'f' })).toMatchObject({ success: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
  });

  it('a mesh this daemon does not know has an empty scope (fail closed)', async () => {
    world({ 'proj/a.txt': 'x' });
    setMeshScopeResolverForTest(() => null);
    expect(await agent({ ...REMOTE, fromDaemonId: undefined })).toMatchObject({ success: false, code: 'WORKSPACE_NOT_IN_SCOPE' });
  });
});

describe('review hardening: source machine, validation order, agent-op rate limit', () => {
  it('a coordinator naming a source machine outside its project is refused with one generic code, before anything is forwarded', async () => {
    const { s } = world({ 'proj/a.txt': 'x' });
    const stranger = await agent({ ...REMOTE, fromDaemonId: 'daemon_mach_stranger' });
    expect(stranger).toMatchObject({ success: false, code: 'machine_not_in_project' });
    expect(s.engine.list()).toEqual([]);
    // status/cancel naming a stranger machine get the very same answer
    expect(await agent({ action: 'status', fromDaemonId: 'daemon_mach_stranger' })).toMatchObject({ success: false, code: 'machine_not_in_project' });
    // a roster machine and the agent's own daemon still work
    expect(await agent(REMOTE)).toMatchObject({ success: true });
    expect(await agent({ ...REMOTE, fromDaemonId: 'daemon_mach_a', fromWorkspace: 'adst', toDaemonId: 'daemon_mach_b' }).then((r) => r.code)).not.toBe('machine_not_in_project');
  });

  it('a malformed request is answered the same whether or not the source workspace is in scope', async () => {
    const { s } = world({ 'proj/a.txt': 'x' });
    const ask = (request: Record<string, unknown>) => s.engine.handlePeerOp('daemon_mach_a', { op: 'agent_request', caller: { role: 'coordinator', sessionId: 'coord-session-1', meshId }, request });
    const shapes: Array<Record<string, unknown>> = [
      { toDaemonId: '', selected: ['proj'], targetMode: 'new_folder', finalName: 'x' },
      { toDaemonId: 'daemon_mach_b', selected: [], targetMode: 'new_folder', finalName: 'x' },
      { toDaemonId: 'daemon_mach_b', selected: ['proj'], targetMode: 'bogus', finalName: 'x' },
    ];
    for (const shape of shapes) {
      const inScope = await ask({ ...shape, fromWorkspace: 'src' });
      const outOfScope = await ask({ ...shape, fromWorkspace: 'unscoped' });
      const unknown = await ask({ ...shape, fromWorkspace: 'nonexistent' });
      expect(inScope.ok).toBe(false);
      expect(inScope.code).not.toBe('WORKSPACE_NOT_IN_SCOPE');
      expect(outOfScope).toEqual(inScope);
      expect(unknown).toEqual(inScope);
    }
  });

  it('agent_request / agent_status / agent_cancel share the per-peer budget of resolve_workspace', async () => {
    const { s } = world({ 'proj/a.txt': 'x' });
    const caller = { role: 'coordinator', sessionId: 'coord-session-1', meshId };
    const ops = ['agent_status', 'agent_cancel', 'agent_request'];
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await s.engine.handlePeerOp('daemon_mach_a', { op: ops[i % 3], caller, transferId: 'tr_missing', request: { ...REMOTE, fromWorkspace: 'nonexistent' } });
      if (r.code === 'RATE_LIMITED') limited++;
    }
    expect(limited).toBe(10);
    // another peer keeps its own budget
    expect((await s.engine.handlePeerOp('daemon_mach_b', { op: 'agent_status', caller })).code).not.toBe('RATE_LIMITED');
  });
});
