import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const testTmpDir = path.join(tmpdir(), `adhdev-light-cont-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => { if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true }); return testConfigDir; },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
}));

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}));
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}));

import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { continueLightSourceToIntegration } from '../../src/mesh/light-source-continuation.js';
import { captureLightTaskResult } from '../../src/mesh/light-task-result.js';
import { setLightWorkspaceFingerprint } from '../../src/mesh/mesh-light-workspace-store.js';
import { prepareLightWorkspace } from '../../src/mesh/light-workspace.js';
import { takeLightCheckoutFingerprint } from '../../src/mesh/light-checkout-fingerprint.js';
import { validateLightWorkspaceConfig } from '../../src/mesh/light-workspace-config.js';
import { setStageArtifactRegistrar } from '../../src/mesh/stage-ports-default.js';
import { registerSessionArtifact } from '../../src/artifacts/artifact-store.js';
import { lightContinuationIpcHandlers } from '../../src/commands/low-family/light-continuation-ipc.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

describe('light source → integration continuation (Contract A)', () => {
  let tmp: string, checkout: string, cfg: any, meshId: string;
  beforeEach(() => {
    setStageArtifactRegistrar((input) => registerSessionArtifact(MeshRuntimeStore.getInstance().db as never, input).record.artifactId);
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'lw-cont-')));
    const subSrc = path.join(tmp, 'sub-src'); fs.mkdirSync(subSrc); git(subSrc, 'init', '-q', '-b', 'main');
    write(path.join(subSrc, 'a.txt'), 'sub\n'); git(subSrc, 'add', '.'); git(subSrc, 'commit', '-q', '-m', 'sub');
    checkout = path.join(tmp, 'checkout'); fs.mkdirSync(checkout); git(checkout, 'init', '-q', '-b', 'main');
    write(path.join(checkout, '.gitignore'), 'node_modules/\n');
    write(path.join(checkout, 'src.txt'), 'line1\n');
    git(checkout, 'submodule', 'add', '-q', subSrc, 'oss'); git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'root');
    const v = validateLightWorkspaceConfig({ version: 1, baseDir: path.join(tmp, 'lwbase'), linkNodeModules: [], minFreeBytes: 1 });
    if (!v.ok) throw new Error(v.message);
    cfg = v.config;
    meshId = `mesh_cont_${randomUUID().slice(0, 8)}`;
    meshConfigMocks.getMesh.mockReturnValue({ id: meshId, repoIdentity: 'github.com/example/repo', nodes: [{ id: 'node_alpha', daemonId: 'daemon_test', workspace: checkout }] });
  });
  afterEach(() => {
    __clearMeshQueueForTests(meshId);
    __resetMeshRuntimeStoreForTests();
    meshConfigMocks.getMesh.mockReset();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  async function setupDirty() {
    const row = enqueueTask(meshId, 'light work', { taskMode: 'code_change', difficulty: 'easy', ownedPaths: ['src.txt', 'oss/**'], light: true, lightBaseNodeId: 'node_alpha', missionId: 'mission' });
    const store = MeshRuntimeStore.getInstance();
    const ws = await prepareLightWorkspace({ meshId, taskId: row.id, checkoutRoot: checkout, config: cfg, db: store.db });
    setLightWorkspaceFingerprint(store.db, ws.workspaceId, await takeLightCheckoutFingerprint(checkout, cfg.linkNodeModules, ['oss']));
    const fresh = store.findQueueEntryById(meshId, row.id)!;
    Object.assign(fresh, { lightWorkspaceId: ws.workspaceId, targetSessionId: `sess_${row.id}`, assignedSessionId: `sess_${row.id}`, status: 'assigned', revision: 0 });
    store.updateQueueEntry(fresh);
    write(path.join(ws.path, 'oss', 'a.txt'), 'dirty-oss\n');
    const res = await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'completed', testsRun: [{ command: 'vitest run x', exit: 0 }] } });
    expect(res?.sourceCandidate?.readiness).toBe('uncommitted');
    const decision = {
      question: 'Continue this light source in integration?',
      options: [{ id: 'a', label: 'Continue' }, { id: 'b', label: 'Keep blocked' }],
      answer: { optionId: 'a', by: 'owner', via: 'dashboard', at: new Date().toISOString() },
      answerRevision: 1, allowFreeText: false, onDue: 'remind', urgency: 'normal',
    } as const;
    const approval = {
      id: 'fixture-owner-decision', meshId, missionId: 'mission', kind: 'decision' as const, state: 'answered' as const,
      text: decision.question, refs: [{ kind: 'task' as const, value: row.id }],
      decision: { ...decision, options: [...decision.options] },
    };
    store.missionItems().insertItem(approval);
    return { row: store.findQueueEntryById(meshId, row.id)!, ws, store, approval };
  }

  const host = () => ({
    actor: 'daemon_test', repoIdentity: 'github.com/example/repo', machineId: 'test-machine',
    nodeId: 'node_alpha', workspace: checkout, ownerDecisionId: 'fixture-owner-decision',
    ownerOptionId: 'a', ownerAnswerRevision: 1,
  });

  it('dry-run attests and plans a successor with zero mutations', async () => {
    const { row, store } = await setupDirty();
    const beforeRev = row.revision ?? 0;
    const out = await continueLightSourceToIntegration(
      { meshId, sourceTaskId: row.id, expectedRevision: beforeRev },
      { ...host(), dryRun: true },
    );
    expect(out.plan.dryRun).toBe(true);
    expect(out.plan.phase).toBe('integration');
    expect(out.plan.readiness).toBe('uncommitted');
    expect(store.findQueueEntryById(meshId, out.plan.successorTaskId)).toBeFalsy();
    expect(store.findQueueEntryById(meshId, row.id)!.revision).toBe(beforeRev);
    expect(store.findQueueEntryById(meshId, row.id)!.lightResult?.sourceCandidate?.integrationTaskId || '').toBe('');
  });

  it('apply mints one successor, links integrationTaskId, preserves source history idempotently', async () => {
    const { row, store } = await setupDirty();
    const beforeRev = store.findQueueEntryById(meshId, row.id)!.revision ?? 0;
    const out = await continueLightSourceToIntegration(
      { meshId, sourceTaskId: row.id, expectedRevision: beforeRev },
      host(),
    );
    expect(out.plan.idempotent).toBe(false);
    const successor = store.findQueueEntryById(meshId, out.successor.id)!;
    expect(successor.phase).toBe('integration');
    expect(successor.lightWorkspaceId).toBe(row.lightWorkspaceId);
    expect(successor.dependsOn).toEqual([row.id]);
    const source = store.findQueueEntryById(meshId, row.id)!;
    expect(source.lightResult?.sourceCandidate?.integrationTaskId).toBe(successor.id);
    expect(source.revision).toBe(beforeRev + 1);
    expect(source.status).toBe('blocked'); // capture blocked the source; status unchanged by continuation
    expect(source.revisionHistory?.slice(0, -1)).toEqual(row.revisionHistory ?? []);
    expect(source.lightResult?.sourceCandidate).toEqual({ ...row.lightResult?.sourceCandidate, integrationTaskId: successor.id });

    const again = await continueLightSourceToIntegration(
      { meshId, sourceTaskId: row.id, expectedRevision: source.revision ?? 0 },
      host(),
    );
    expect(again.plan.idempotent).toBe(true);
    expect(again.successor.id).toBe(successor.id);
    expect(store.getQueueEntries(meshId).filter(t => t.id.endsWith(':integration:1'))).toHaveLength(1);
  });

  it('rejects unproven owner answers at the actual host IPC without queue mutations', async () => {
    const { row, store, approval } = await setupDirty();
    const items = store.missionItems();
    const ctx = {
      deps: { statusInstanceId: 'daemon_test' },
      getMeshForCommand: async () => ({ mesh: meshConfigMocks.getMesh() }),
    } as unknown as Parameters<typeof lightContinuationIpcHandlers.light_continue_integration>[0];
    const ownerAnswer = { decisionId: approval.id, optionId: 'a', revision: 1 };
    const args = { meshId, sourceTaskId: row.id, expectedRevision: row.revision, ownerAnswer, dryRun: true };
    const invoke = (overrides = {}) => lightContinuationIpcHandlers.light_continue_integration(ctx, { ...args, ...overrides });
    expect(await invoke()).toMatchObject({ success: true, dryRun: true });
    expect(await invoke({ ownerAnswer: undefined, ownerDecisionId: approval.id })).toMatchObject({ success: false, code: 'owner_decision_required' });
    expect(await invoke({ ownerAnswer: { ...ownerAnswer, by: 'owner' } })).toMatchObject({ success: false, code: 'owner_decision_required' });
    for (const overrides of [{ optionId: 'b' }, { decisionId: 'forged' }, { revision: 2 }]) {
      expect(await invoke({ ownerAnswer: { ...ownerAnswer, ...overrides } })).toMatchObject({ success: false, code: 'owner_authorization_required' });
    }
    for (const patch of [
      { state: 'open' as const },
      { missionId: 'another-mission' },
      { refs: [{ kind: 'task' as const, value: 'other-task' }] },
      { refs: [...approval.refs, { kind: 'task' as const, value: 'other-task' }] },
      { decision: { ...approval.decision, answer: { ...approval.decision.answer, by: 'auto_recommended' as const } } },
    ]) {
      const { state, missionId, refs, decision } = approval;
      items.updateItem(meshId, approval.id, { state, missionId, refs, decision, ...patch });
      expect(await invoke({ dryRun: false })).toMatchObject({ success: false, code: 'owner_authorization_required' });
    }
    expect(store.findQueueEntryById(meshId, row.id)).toEqual(row);
    expect(store.findQueueEntryById(meshId, `${row.id}:integration:1`)).toBeFalsy();
  });

  it('rechecks owner answer and source CAS under the apply lock', async () => {
    const { row, store, approval } = await setupDirty();
    const items = store.missionItems();
    const getItem = items.getItem.bind(items);
    const request = { meshId, sourceTaskId: row.id, expectedRevision: row.revision ?? 0 };
    for (const changed of ['answer', 'source']) {
      const read = vi.spyOn(items, 'getItem').mockImplementationOnce((...args) => {
        const prior = getItem(...args);
        if (changed === 'answer') {
          items.updateItem(meshId, approval.id, { decision: { ...approval.decision, answerRevision: 2 } });
        } else {
          store.updateQueueEntry({ ...row });
        }
        return prior;
      });
      try {
        await expect(continueLightSourceToIntegration(request, host())).rejects.toThrow(
          changed === 'answer' ? 'owner_authorization_required' : 'stale_revision',
        );
      } finally {
        read.mockRestore();
        items.updateItem(meshId, approval.id, { decision: approval.decision });
      }
    }
    expect(store.findQueueEntryById(meshId, `${row.id}:integration:1`)).toBeFalsy();
  });

  it('refuses stale CAS, missing owner decision, and missing candidate', async () => {
    const { row, store } = await setupDirty();
    const rev = store.findQueueEntryById(meshId, row.id)!.revision ?? 0;
    await expect(continueLightSourceToIntegration(
      { meshId, sourceTaskId: row.id, expectedRevision: 99 }, host(),
    )).rejects.toThrow(/stale_revision/);
    await expect(continueLightSourceToIntegration(
      { meshId, sourceTaskId: row.id, expectedRevision: rev },
      { ...host(), ownerDecisionId: '' },
    )).rejects.toThrow(/owner_decision_required/);
    const plain = enqueueTask(meshId, 'no candidate', { taskMode: 'code_change', difficulty: 'easy', ownedPaths: ['src.txt'], light: true, lightBaseNodeId: 'node_alpha' } as any);
    Object.assign(plain, { lightWorkspaceId: row.lightWorkspaceId, status: 'blocked' });
    store.updateQueueEntry(plain);
    const plainRev = store.findQueueEntryById(meshId, plain.id)!.revision ?? 0;
    await expect(continueLightSourceToIntegration(
      { meshId, sourceTaskId: plain.id, expectedRevision: plainRev }, host(),
    )).rejects.toThrow(/source_candidate_required/);
  });
});
