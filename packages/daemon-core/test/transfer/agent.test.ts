import * as fs from 'node:fs';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testConfigDir = join(tmpdir(), `adhdev-xfer-agent-${randomUUID().slice(0, 8)}`, '.adhdev');
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
import { LinkBroker, makeSide, readTree, waitFor, writeTree, type Side } from './helpers.js';

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

function setup(src: Record<string, string>, dst: Record<string, string> = {}, leavePolicyUnset = false) {
  const broker = new LinkBroker();
  const peers = new Map<string, Side>();
  const a = makeSide('daemon_mach_a', broker, peers);
  const b = makeSide('daemon_mach_b', broker, peers);
  a.engine.shutdown();
  a.engine = configureProjectTransfer(a.ports); // the process-wide engine is the requesting daemon
  cleanups.push(() => { a.engine.shutdown(); b.engine.shutdown(); });
  // The shipped default is ON (2026-11-08); the legacy 'asks the owner' tests pin an explicit off.
  if (!leavePolicyUnset) { a.engine.setAgentAutoApprove(false); b.engine.setAgentAutoApprove(false); }
  writeTree(a.ws.path, src);
  writeTree(b.ws.path, dst);
  setWorkspaceLookupForTest((q) => {
    if (q === a.ws.id || q === 'src') return { id: a.ws.id, path: a.ws.path, label: 'src' };
    if (q === b.ws.id || q === 'dst') return { id: b.ws.id, path: b.ws.path, label: 'dst' };
    return null;
  });
  // The mesh scope: each machine contributes only its own workspace; any known peer is on the roster.
  setMeshScopeResolverForTest((_mesh, machine, via) => {
    if (via && !peers.has(via)) return null;
    const side = peers.get(machine);
    return side ? { workspaces: [{ id: side.ws.id, path: side.ws.path, label: side.id === a.id ? 'src' : 'dst' }] } : null;
  });
  return { a, b };
}

const spec = (name: string) => getDaemonCommandRegistry().get(name)!;

async function agent(args: Record<string, unknown>, o: { session?: string; coordinator?: boolean; credential?: boolean } = {}) {
  const raw: Record<string, unknown> = { ...args };
  if (o.credential !== false) {
    const token = mintMcpSessionCredential({ sessionId: o.session ?? 'coord-session-1', meshId, isCoordinator: o.coordinator !== false });
    attachIpcMcpAuthority(raw, 'project_transfer_agent', { sessionCredential: token });
  }
  raw[COMMAND_SOURCE_ARG] = 'ipc';
  return (await (spec('project_transfer_agent').run as any)({}, raw)) as Record<string, any>;
}

const REQ = { action: 'request', fromWorkspace: 'src', selected: ['proj'], toDaemonId: 'daemon_mach_b', toWorkspace: 'dst', finalName: 'incoming' };

describe('agent transfer request (owner decision 2026-11-02 section 6)', () => {
  it('creates a preview and raises an owner decision, but never approves', async () => {
    const { a, b } = setup({ 'proj/secret-name-report.txt': 'x', 'proj/b.txt': 'yy' });
    const r = await agent(REQ);
    expect(r).toMatchObject({ success: true, autoApproved: false, awaitingOwner: true, files: 2, state: 'previewed' });
    const rec = a.engine.get(r.transferId)!;
    expect(rec.localApproval).toBeUndefined();
    expect(rec.requestedBy).toEqual({ role: 'coordinator', sessionId: 'coord-session-1' });
    expect(b.engine.get(r.transferId)!.requestedBy?.role).toBe('coordinator');
    const [d] = buildOwnerDecisions(meshId);
    expect(d!.itemId).toBe(r.decisionItemId);
    expect(d!.transferId).toBe(r.transferId);
    expect(d!.options.map((o) => o.label)).toEqual(['Approve', 'Reject']);
    expect(d!.recommended).toBeUndefined(); // nothing for the push relay to choose
    // no file names or paths in anything that can reach a push or the server
    expect(`${d!.question} ${d!.context}`).not.toMatch(/secret-name|proj\/|\.txt/);
    expect(d!.question.length).toBeLessThanOrEqual(120);
  });

  it('completes only after the owner approves BOTH daemons; the decision answer itself approves nothing', async () => {
    const { a, b } = setup({ 'proj/a.txt': 'hello' });
    const r = await agent(REQ);
    const id = r.transferId as string;
    expect(answerMissionDecision({ meshId, itemId: r.decisionItemId, optionId: buildOwnerDecisions(meshId)[0]!.options[0]!.id }, { by: 'owner', via: 'dashboard' }).ok).toBe(true);
    expect(a.engine.get(id)!.state).toBe('previewed'); // recorded answer alone approves nothing
    const rec = a.engine.get(id)!;
    expect((await a.engine.approve(id, rec.selectionDigest)).ok).toBe(true);
    expect((await b.engine.approve(id, rec.selectionDigest)).ok).toBe(true);
    await waitFor(() => a.engine.get(id)?.state === 'completed' && b.engine.get(id)?.state === 'completed');
    expect(readTree(b.ws.path)['incoming/proj/a.txt']).toBe('hello');
    const st = await agent({ action: 'status', transferId: id });
    expect(st).toMatchObject({ success: true, state: 'completed' });
  });

  it('the assistant and the push relay cannot answer a transfer decision', async () => {
    setup({ 'proj/a.txt': 'x' });
    const r = await agent(REQ);
    const opt = buildOwnerDecisions(meshId)[0]!.options[0]!.id;
    for (const via of ['assistant', 'push'] as const) {
      const res = answerMissionDecision({ meshId, itemId: r.decisionItemId, optionId: opt }, { by: 'owner', via });
      expect(res).toMatchObject({ ok: false, code: 'transfer_decision_dashboard_only' });
    }
  });

  it('cancel withdraws the decision; expiry cancels the transfer and withdraws it too', async () => {
    const { a } = setup({ 'proj/a.txt': 'x' });
    const r1 = await agent(REQ);
    expect((await agent({ action: 'cancel', transferId: r1.transferId })).success).toBe(true);
    expect(buildOwnerDecisions(meshId)).toHaveLength(0);
    const r2 = await agent(REQ);
    expect(buildOwnerDecisions(meshId)).toHaveLength(1);
    a.ports.now = () => Date.now() + 16 * 60_000;
    a.engine.sweep();
    expect(a.engine.get(r2.transferId)!.state).toBe('expired');
    expect(buildOwnerDecisions(meshId)).toHaveLength(0);
  });

  it('cancel and status only reach the requester\'s own requests', async () => {
    const { a } = setup({ 'proj/a.txt': 'x' });
    const r = await agent(REQ);
    const other = await agent({ action: 'cancel', transferId: r.transferId }, { session: 'coord-session-2' });
    expect(other).toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(await agent({ action: 'status', transferId: r.transferId }, { session: 'coord-session-2' })).toMatchObject({ success: false });
    expect((await agent({ action: 'status' }, { session: 'coord-session-2' })).transfers).toEqual([]);
    expect(a.engine.get(r.transferId)!.state).toBe('previewed');
    // an owner-created transfer is not cancellable by an agent either
    const owner = await a.engine.create({ workspaceId: a.ws.id, selected: ['proj'], targetDaemonId: 'daemon_mach_b', targetWorkspaceId: 'ws-daemon_mach_b', finalName: 'o' });
    if (!owner.ok) throw new Error(owner.code);
    expect(await agent({ action: 'cancel', transferId: owner.transferId })).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });

  it('refuses callers that are not a coordinator session, and the status view hides file names', async () => {
    setup({ 'proj/a.txt': 'x' });
    expect(await agent(REQ, { credential: false })).toMatchObject({ success: false, code: 'transfer_agent_not_allowed' });
    expect(await agent(REQ, { session: 'worker-session-9', coordinator: false })).toMatchObject({ success: false, code: 'transfer_agent_not_allowed' });
    const r = await agent(REQ);
    expect(JSON.stringify(await agent({ action: 'status', transferId: r.transferId }))).not.toMatch(/a\.txt/);
  });

  it('an agent can call none of the owner verbs (approve / relay / auto-approve / revert / create)', async () => {
    const { a } = setup({ 'proj/a.txt': 'x' });
    for (const name of ['project_transfer_approve', 'project_transfer_set_relay', 'project_transfer_set_agent_auto_approve', 'project_transfer_revert', 'project_transfer_create', 'project_transfer_revoke_approval']) {
      expect(spec(name).sources, name).toEqual(['p2p', 'standalone']);
      const raw: Record<string, unknown> = { transferId: 'x', allow: true, allowRelay: true };
      const token = mintMcpSessionCredential({ sessionId: 'coord-session-1', meshId, isCoordinator: true });
      attachIpcMcpAuthority(raw, name, { sessionCredential: token });
      raw[COMMAND_SOURCE_ARG] = 'ipc';
      expect(await (spec(name).run as any)({}, raw), name).toMatchObject({ success: false, code: 'OWNER_INGRESS_REQUIRED' });
    }
    expect(spec('project_transfer_agent').sources).toEqual(['ipc']);
    expect(a.engine.agentAutoApproveAllowed()).toBe(false); // owner commands must not change the policy
  });
});

describe('A2: per-machine "auto-approve agent transfers" (default on since 2026-11-08, both machines must allow)', () => {
  it('unset defaults to allowed: a new-folder agent request proceeds without asking', async () => {
    const { a, b } = setup({ 'proj/a.txt': 'dflt' }, {}, true);
    expect(a.engine.agentAutoApproveAllowed()).toBe(true);
    expect(b.engine.agentAutoApproveAllowed()).toBe(true);
    const r = await agent(REQ);
    expect(r).toMatchObject({ success: true, autoApproved: true });
    expect(buildOwnerDecisions(meshId)).toHaveLength(0);
  });

  it('an explicit owner off on either machine is respected and the request asks', async () => {
    const { a, b } = setup({ 'proj/a.txt': 'x' }, {}, true);
    a.engine.setAgentAutoApprove(false);
    expect(b.engine.agentAutoApproveAllowed()).toBe(true);
    expect((await agent(REQ)).autoApproved).toBe(false);
    expect(buildOwnerDecisions(meshId).length).toBeGreaterThan(0);
  });

  it('an unset overwrite request still asks (overwrites always ask)', async () => {
    const { a, b } = setup({ 'proj/a.txt': 'NEW' }, { 'proj/a.txt': 'OLD' }, true);
    expect(a.engine.agentAutoApproveAllowed()).toBe(true);
    const r = await agent({ ...REQ, targetMode: 'existing_path', targetDir: '' });
    expect(r).toMatchObject({ success: true, autoApproved: false, replacedFiles: 1 });
    expect(fs.readFileSync(`${b.ws.path}/proj/a.txt`, 'utf8')).toBe('OLD');
  });

  it('both machines on: the daemons approve and the transfer completes with no owner decision', async () => {
    const { a, b } = setup({ 'proj/a.txt': 'auto' });
    a.engine.setAgentAutoApprove(true);
    b.engine.setAgentAutoApprove(true);
    const r = await agent(REQ);
    expect(r).toMatchObject({ success: true, autoApproved: true });
    expect(buildOwnerDecisions(meshId)).toHaveLength(0);
    await waitFor(() => b.engine.get(r.transferId)?.state === 'completed');
    expect(readTree(b.ws.path)['incoming/proj/a.txt']).toBe('auto');
  });

  it('only one machine on falls back to the owner decision (either side)', async () => {
    for (const [srcOn, dstOn] of [[true, false], [false, true]]) {
      const { a, b } = setup({ 'proj/a.txt': 'x' });
      a.engine.setAgentAutoApprove(srcOn!);
      b.engine.setAgentAutoApprove(dstOn!);
      const r = await agent(REQ);
      expect(r.autoApproved, `${srcOn}/${dstOn}`).toBe(false);
      expect(a.engine.get(r.transferId)!.localApproval).toBeUndefined();
      expect(b.engine.get(r.transferId)!.localApproval).toBeUndefined();
      expect(buildOwnerDecisions(meshId).length).toBeGreaterThan(0);
      resetProjectTransferForTest(); while (cleanups.length) cleanups.pop()!();
      try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* ignore */ }
    }
  });

  it('the target checks ITS OWN setting: a forged auto-approve request is refused', async () => {
    const { a, b } = setup({ 'proj/a.txt': 'x' });
    a.engine.setAgentAutoApprove(true); // requester claims everything is fine; target is off
    b.engine.setAgentAutoApprove(false);
    const r = await agent(REQ);
    expect(r.autoApproved).toBe(false);
    const rec = a.engine.get(r.transferId)!;
    const forged = await b.engine.handlePeerOp('daemon_mach_a', { op: 'agent_approve', transferId: r.transferId, selectionDigest: rec.selectionDigest, autoApprove: true, agentAutoApprove: true });
    expect(forged).toMatchObject({ ok: false, code: 'AUTO_APPROVE_NOT_ALLOWED' });
    expect(b.engine.get(r.transferId)!.localApproval).toBeUndefined();
  });

  it('an owner-created transfer can never be auto-approved, even with both machines on', async () => {
    const { a, b } = setup({ 'proj/a.txt': 'x' });
    a.engine.setAgentAutoApprove(true);
    b.engine.setAgentAutoApprove(true);
    const c = await a.engine.create({ workspaceId: a.ws.id, selected: ['proj'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'o' });
    if (!c.ok) throw new Error(c.code);
    const forged = await b.engine.handlePeerOp('daemon_mach_a', { op: 'agent_approve', transferId: c.transferId, selectionDigest: c.record.selectionDigest });
    expect(forged).toMatchObject({ ok: false, code: 'AUTO_APPROVE_NOT_ALLOWED' });
    expect(await a.engine.tryAgentAutoApprove(c.transferId, true)).toBe(false);
  });

  it('A2 on both machines + a transfer that REPLACES files still asks the owner', async () => {
    const { a, b } = setup({ 'proj/a.txt': 'NEW' }, { 'proj/a.txt': 'OLD' });
    a.engine.setAgentAutoApprove(true);
    b.engine.setAgentAutoApprove(true);
    const r = await agent({ ...REQ, targetMode: 'existing_path', targetDir: '' });
    expect(r).toMatchObject({ success: true, autoApproved: false, replacedFiles: 1, newFiles: 0 });
    expect(a.engine.get(r.transferId)!.localApproval).toBeUndefined();
    expect(b.engine.get(r.transferId)!.localApproval).toBeUndefined();
    expect(buildOwnerDecisions(meshId)).toHaveLength(1);
    // the target also refuses a forged agent_approve for an overwrite
    const rec = a.engine.get(r.transferId)!;
    expect(await b.engine.handlePeerOp('daemon_mach_a', { op: 'agent_approve', transferId: r.transferId, selectionDigest: rec.selectionDigest, replaceDigest: rec.overwrite!.digest })).toMatchObject({ ok: false, code: 'AUTO_APPROVE_NOT_ALLOWED' });
    expect(fs.readFileSync(`${b.ws.path}/proj/a.txt`, 'utf8')).toBe('OLD');
  });

  it('A2 on both machines + existing_path with zero replacements is auto-approved', async () => {
    const { a, b } = setup({ 'proj/a.txt': 'NEW' }, { 'other.txt': 'o' });
    a.engine.setAgentAutoApprove(true);
    b.engine.setAgentAutoApprove(true);
    const r = await agent({ ...REQ, targetMode: 'existing_path', targetDir: '' });
    expect(r).toMatchObject({ success: true, autoApproved: true });
    await waitFor(() => b.engine.get(r.transferId)?.state === 'completed');
    expect(readTree(b.ws.path)['proj/a.txt']).toBe('NEW');
  });

  it('the setting is owner-only and persists next to allowRelay without clobbering it', async () => {
    const { a } = setup({ 'proj/a.txt': 'x' });
    a.engine.setRelayAllowed(false);
    a.engine.setAgentAutoApprove(true);
    expect(a.engine.relayAllowed()).toBe(false);
    expect(a.engine.agentAutoApproveAllowed()).toBe(true);
    a.engine.setRelayAllowed(true);
    expect(a.engine.agentAutoApproveAllowed()).toBe(true);
    expect(spec('project_transfer_set_agent_auto_approve').sources).toEqual(['p2p', 'standalone']);
  });
});
