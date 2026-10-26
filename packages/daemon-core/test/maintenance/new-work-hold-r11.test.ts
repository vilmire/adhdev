import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { resetProcessInstanceContextForTests } from '../../src/config/instance-context.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import type { CancelDispatchRequest } from '../../src/mesh/turn-ledger/effects.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { dispatch, evd } from '../turn-ledger/ledger-harness.js';
import { deliverTaskToSession } from '../../src/mesh/mesh-queue-dispatch.js';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { restartHostedSession, sessionHostHandlers } from '../../src/commands/low-family/session-host.js';
import {
    setNewWorkHold, releaseNewWorkHold, evaluateNewWorkHold,
    resetNewWorkHoldForTests, clearNewWorkHoldMemoryCacheForTests,
    collectNewWorkHoldDrainSummary, admitRouterCommandUnderNewWorkHold,
} from '../../src/maintenance/new-work-hold.js';

let root: string;
let previousConfig: string | undefined;
let store: MeshRuntimeStore;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-r11-'));
    previousConfig = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = root;
    resetProcessInstanceContextForTests();
    MeshRuntimeStore.resetForTests();
    resetNewWorkHoldForTests();
    store = MeshRuntimeStore.getInstance();
});
afterEach(() => {
    vi.restoreAllMocks();
    setActiveTurnLedger(null);
    resetNewWorkHoldForTests();
    MeshRuntimeStore.resetForTests();
    if (previousConfig === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfig;
    resetProcessInstanceContextForTests();
    fs.rmSync(root, { recursive: true, force: true });
});
function row(id: string, status: string) {
    store.insertQueueEntry({ id, meshId: 'held-mesh', status: status as any, message: id,
        assignedNodeId: status === 'assigned' ? 'n1' : undefined,
        assignedSessionId: status === 'assigned' ? 's1' : undefined,
        difficulty: 'simple', priority: 'normal', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

it('queries only nonterminal queue rows through the status index', () => {
    row('finished', 'completed'); row('running', 'assigned'); row('waiting', 'pending');
    const prepare = vi.spyOn(store.db, 'prepare');
    const summary = collectNewWorkHoldDrainSummary();
    expect(summary.activeClaims.map(r => r.id)).toEqual(['running']);
    expect(summary.heldPendingQueue.map(r => r.id)).toEqual(['waiting']);
    const sql = prepare.mock.calls.map(([sql]) => String(sql)).find(sql => sql.includes('FROM mesh_queue'))!;
    // Plan evidence pins bounded status-index reads, rather than a cosmetic WHERE.
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
    expect(plan.some(p => /SEARCH mesh_queue USING INDEX idx_mesh_queue_status_updated/.test(p.detail))).toBe(true);
    expect(plan.some(p => /SCAN mesh_queue/.test(p.detail))).toBe(false);
});

it('avoids admission census before expiry and file reads on unchanged active or released state', () => {
    const t0 = Date.now();
    setNewWorkHold({ holdId: 'cached', now: t0 });
    clearNewWorkHoldMemoryCacheForTests();
    evaluateNewWorkHold({ now: t0 + 1 }); // Prime a real disk read.
    row('running-after-set', 'assigned');
    const read = vi.spyOn(fs, 'readFileSync');
    const prepare = vi.spyOn(store.db, 'prepare');
    for (let i = 0; i < 20; i++) expect(evaluateNewWorkHold({ now: t0 + 2 + i }).held).toBe(true);
    expect(read.mock.calls.filter(([file]) => String(file).endsWith('new-work-hold.json'))).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(evaluateNewWorkHold({ now: t0 + 50 }).drain.activeClaims.map(r => r.id)).toEqual(['running-after-set']);
    releaseNewWorkHold({ holdId: 'cached', now: t0 + 100 });
    evaluateNewWorkHold({ now: t0 + 101 }); // Prime the released file's identity.
    read.mockClear(); prepare.mockClear();
    for (let i = 0; i < 20; i++) expect(evaluateNewWorkHold({ now: t0 + 102 + i }).held).toBe(false);
    expect(read.mock.calls.filter(([file]) => String(file).endsWith('new-work-hold.json'))).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
});

it('invalidates disk cache on mtime, size and atomic replacement inode, and recovers from corruption', () => {
    const t0 = Date.now();
    setNewWorkHold({ holdId: 'cache-id', reason: 'aaa', now: t0 });
    const file = path.join(root, 'new-work-hold.json');
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    evaluateNewWorkHold({ now: t0 + 1 });
    const originalStat = fs.statSync(file);
    // Same-size in-place edit: mtime must invalidate.
    fs.writeFileSync(file, JSON.stringify({ ...original, reason: 'bbb' }, null, 2) + '\n');
    fs.utimesSync(file, originalStat.atime, new Date(originalStat.mtimeMs + 2000));
    expect(evaluateNewWorkHold({ now: t0 + 2 }).hold.reason).toBe('bbb');
    // Same mtime and size, different inode: an atomic writer must invalidate.
    const beforeReplace = fs.statSync(file);
    const replacement = file + '.external';
    fs.writeFileSync(replacement, JSON.stringify({ ...original, reason: 'ccc' }, null, 2) + '\n');
    fs.utimesSync(replacement, beforeReplace.atime, beforeReplace.mtime);
    fs.renameSync(replacement, file);
    expect(evaluateNewWorkHold({ now: t0 + 3 }).hold.reason).toBe('ccc');
    // Size changes are visible even with the old mtime.
    const beforeSize = fs.statSync(file);
    fs.writeFileSync(file, JSON.stringify({ ...original, reason: 'longer external reason' }));
    fs.utimesSync(file, beforeSize.atime, beforeSize.mtime);
    expect(evaluateNewWorkHold({ now: t0 + 4 }).hold.reason).toBe('longer external reason');
    fs.writeFileSync(file, '{broken');
    expect(evaluateNewWorkHold({ now: t0 + 5 }).hold.persistenceWarning).toBeTruthy();
    fs.writeFileSync(file, JSON.stringify({ ...original, active: false, revision: 100 }));
    expect(evaluateNewWorkHold({ now: t0 + 6 }).held).toBe(false);
});

it.each(['local-fence', 'remote-refusal'] as const)('retires an accepted claim and its holds on %s without spending reclaim budget', async source => {
    row('held-task', 'assigned');
    // Explicitly park the native checkpoint: a retirement request alone is
    // never proof that a session's writer has stopped.
    let confirmCheckpoint: (() => void) | undefined;
    const cancelDispatch = vi.fn((request: CancelDispatchRequest) => new Promise(resolve => {
        confirmCheckpoint = () => resolve({ ...request, success: true, quiescent: true, incarnation: 'fixture-native-writer' });
    }));
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: null, ports: { cancelDispatch } });
    setActiveTurnLedger(ledger);
    const accepted = dispatch({ scope: 'mesh_queue', meshId: 'held-mesh', taskId: 'held-task' });
    accepted.at = Date.now();
    const result = ledger.observe(accepted);
    expect(result.verdict).toBe('applied');
    expect(ledger.getAttempt('a1')?.terminal).toBeNull();
    expect(ledger.store.activeHolds('a1').map(h => h.reason)).toContain('await_delivery');
    if (source === 'local-fence') setNewWorkHold({ meshId: 'held-mesh' });
    const thunk = vi.fn(async () => ({ success: false, code: 'new_work_held', holdId: 'remote-hold', revision: 1, expiresAt: Date.now() + 10000 }));
    deliverTaskToSession(thunk, { components: { turnLedger: ledger } as any,
        meshId: 'held-mesh', nodeId: 'n1', sessionId: 's1', providerType: 'claude-cli',
        task: store.findQueueEntryById('held-mesh', 'held-task')!, transport: 'local',
        attemptRef: { attemptId: 'a1', generation: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    expect(cancelDispatch).toHaveBeenCalledOnce();
    expect(ledger.getAttempt('a1')?.state).toBe('stopping');
    expect(store.findQueueEntryById('held-mesh', 'held-task')?.status).toBe('assigned');
    confirmCheckpoint!();
    await new Promise(resolve => setImmediate(resolve));
    expect(ledger.getAttempt('a1')?.terminal?.reason).toBe('superseded');
    expect(ledger.store.activeHolds('a1')).toHaveLength(0);
    const queued = store.findQueueEntryById('held-mesh', 'held-task')!;
    expect(queued.status).toBe('pending');
    expect(queued.requeueCount ?? 0).toBe(0);
    expect(queued.dispatchFailureCount ?? 0).toBe(0);
    expect(ledger.getAttempt('a1')?.reclaimCount ?? 0).toBe(0);
    if (source === 'local-fence') expect(thunk).not.toHaveBeenCalled();
    else expect(thunk).toHaveBeenCalledOnce();
});

it('preserves already-consumed work when non-force retirement refuses a held dispatch', () => {
    row('running-task', 'assigned');
    const cancelDispatch = vi.fn();
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: null, ports: { cancelDispatch } });
    setActiveTurnLedger(ledger);
    const accepted = dispatch({ scope: 'mesh_queue', meshId: 'held-mesh', taskId: 'running-task' });
    accepted.at = Date.now();
    ledger.observe(accepted);
    ledger.observe(evd('delivered', {}, { at: Date.now(), source: 'dispatch', observedBy: 'dc' }));
    ledger.observe(evd('turn_started', { retro: false }, { at: Date.now(), observedBy: 'dc' }));
    expect(ledger.getAttempt('a1')?.state).toBe('generating');
    setNewWorkHold({ meshId: 'held-mesh' });
    deliverTaskToSession(async () => ({}), { components: { turnLedger: ledger } as any,
        meshId: 'held-mesh', nodeId: 'n1', sessionId: 's1', providerType: 'claude-cli',
        task: store.findQueueEntryById('held-mesh', 'running-task')!, transport: 'local',
        attemptRef: { attemptId: 'a1', generation: 0 } });
    expect(ledger.getAttempt('a1')?.state).toBe('generating');
    expect(store.findQueueEntryById('held-mesh', 'running-task')?.status).toBe('assigned');
    expect(cancelDispatch).not.toHaveBeenCalled();
});

it.each(['meshNodeFor', 'meshCoordinatorFor'] as const)('fences session-only router and direct restart/resume paths using %s', async key => {
    setNewWorkHold({ meshId: 'held-mesh' });
    const instanceManager: any = { getInstance: (id: string) => ({ getState: () => ({ settings: { [key]: id === 'held-session' ? 'held-mesh' : 'other-mesh' } }) }) };
    for (const command of ['restart_session', 'session_host_restart_session', 'session_host_resume_session']) {
        expect(admitRouterCommandUnderNewWorkHold(command, { sessionId: 'held-session' }, [], { instanceManager } as any)?.code).toBe('new_work_held');
        expect(admitRouterCommandUnderNewWorkHold(command, { sessionId: 'other-session' }, [], { instanceManager } as any)).toBeNull();
    }
    const deps: any = { instanceManager, sessionHostControl: {
        listSessions: vi.fn(async () => []), resumeSession: vi.fn(async (sessionId: string) => ({ sessionId })),
        restartSession: vi.fn(),
    }, cliManager: { restoreHostedSessions: vi.fn() } };
    expect(await restartHostedSession(deps, { sessionId: 'held-session' })).toMatchObject({ code: 'new_work_held' });
    expect(deps.sessionHostControl.listSessions).not.toHaveBeenCalled();
    expect(await sessionHostHandlers.session_host_resume_session({ deps } as any, { sessionId: 'held-session' })).toMatchObject({ code: 'new_work_held' });
    expect(deps.sessionHostControl.resumeSession).not.toHaveBeenCalled();
    expect(await sessionHostHandlers.session_host_resume_session({ deps } as any, { sessionId: 'other-session' })).toMatchObject({ success: true });
    const manager: any = Object.create(DaemonCliManager.prototype);
    manager.deps = { getInstanceManager: () => instanceManager };
    expect(await manager.restartSession({ targetSessionId: 'held-session' })).toMatchObject({ code: 'new_work_held' });
});

it.each([
    ['missing instance', undefined],
    ['missing getState and settings', {}],
    ['missing state', { getState: () => undefined }],
    ['missing settings', { getState: () => ({}) }],
    ['uninitialized state projection', { getState: () => { throw new TypeError('state not initialized'); } }],
] as const)('keeps F4 session-only admission safe with %s', (_label, instance) => {
    const components = { instanceManager: { getInstance: () => instance } } as any;
    expect(setNewWorkHold({ holdId: 'unbound-scoped', meshId: 'held-mesh' })).toMatchObject({ success: true, hold: { scope: 'mesh' } });
    expect(admitRouterCommandUnderNewWorkHold('restart_session', { sessionId: 'unbound' }, [], components)).toBeNull();
    expect(releaseNewWorkHold({ holdId: 'unbound-scoped' })).toMatchObject({ success: true });
    expect(setNewWorkHold({ holdId: 'unbound-global' })).toMatchObject({ success: true, hold: { scope: 'daemon' } });
    expect(admitRouterCommandUnderNewWorkHold('restart_session', { sessionId: 'unbound' }, [], components)).toMatchObject({ code: 'new_work_held' });
});
