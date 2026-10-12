import { describe, expect, it, vi } from 'vitest';
import { ProviderApprovalLifecycle, readDisplayedTrustDirectory, bindProviderApprovalAssignment, providerApprovalAssignment } from '../../src/providers/spec/provider-approval-lifecycle.js';
import { collectPendingApprovals, collectProviderDecisionAttention, buildMeshActiveWorkSummary } from '../../src/mesh/mesh-active-work.js';
import { matchesProviderApprovalTarget, projectProviderApproval } from '../../src/status/provider-approval.js';
import { handleResolveAction } from '../../src/commands/chat-commands.js';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { ev, makeAttempt, makeHold, POLICY, NOW } from '../turn-ledger/fixtures.js';
import { surfaceStageOfAttempt } from '../../src/mesh/mesh-turn-presentation.js';
import { SpecCliAdapter } from '../../src/providers/spec/cli-adapter.js';

const state = { id: 'approval', label: 'Tool permission', title: null, status: 'approval' as const };
const modal = { title: 'always-approve', kind: 'approval' as const, buttons: [{ index: 1, label: 'Yes, proceed' }, { index: 2, label: 'No' }] };

describe('typed provider approval projection', () => {
    it('stopped or failed runtime retracts its live permission resource', () => {
        for (const providerFailure of [null, { message: 'Provider unavailable' }]) {
            const lifecycle = new ProviderApprovalLifecycle(); lifecycle.observe(state, modal, 1000);
            const adapter = Object.assign(Object.create(SpecCliAdapter.prototype), {
                approvalLifecycle: lifecycle, runtimeSettings: {}, latestState: state, latestModal: modal,
                providerFailure, exited: !providerFailure, spawned: true, driver: { updateMeta: vi.fn() },
                maybeConfirmLiveAuthBillingSuspect: vi.fn(), refreshWirePendingQuestion: vi.fn(),
            });
            expect(adapter.getStatus().providerApproval).toMatchObject({ lifecycle: 'resolved', actionable: false, createdAt: 1000 });
            expect(adapter.driver.updateMeta).toHaveBeenCalledTimes(1);
        }
    });
    it('retains actual modal time across repaint; resolution and replacement fence replay', () => {
        const lifecycle = new ProviderApprovalLifecycle();
        lifecycle.observe(state, modal, 1000);
        const first = lifecycle.read()!;
        lifecycle.observe(state, null, 2000);
        expect(lifecycle.read()).toMatchObject({ evidence: 'unavailable', actionable: false, createdAt: 1000 });
        lifecycle.observe(state, modal, 3000);
        expect(lifecycle.read()).toMatchObject({ modalKey: first.modalKey, createdAt: 1000, description: '' });
        lifecycle.resolve(4000);
        const target = { modalKey: first.modalKey!, attemptId: 'a1', generation: 1 };
        expect(matchesProviderApprovalTarget({ ...lifecycle.read()!, attemptId: 'a1', generation: 1 }, target)).toBe(false);
        lifecycle.observe({ ...state, id: 'busy', status: 'busy' }, null, 5000);
        lifecycle.observe(state, modal, 6000);
        const next = { ...lifecycle.read()!, attemptId: 'a1', generation: 2 };
        expect(next.modalKey).not.toBe(first.modalKey);
        expect(matchesProviderApprovalTarget(next, target)).toBe(false);
        expect(matchesProviderApprovalTarget(next, { ...target, modalKey: next.modalKey!, generation: 2 })).toBe(true);
    });

    it('attaching a task to an already visible startup gate re-emits setup for the exact attempt', () => {
        const lifecycle = new ProviderApprovalLifecycle(); lifecycle.observe({ ...state, id: 'trust' }, { ...modal, kind: 'confirm' }, 1000);
        const adapter = Object.assign(Object.create(SpecCliAdapter.prototype), { approvalLifecycle: lifecycle, runtimeSettings: {}, driver: { updateMeta: vi.fn() }, notifyChange: vi.fn() });
        const settings = { meshActiveTaskId: 't', meshActiveAttemptId: 'a', meshActiveAttemptGeneration: 2 };
        adapter.updateRuntimeSettings(settings);
        expect(adapter.notifyChange).toHaveBeenCalledWith('fsm_state');
        expect(adapter.driver.updateMeta.mock.calls[0][0].providerApproval).toMatchObject({ type: 'provider_setup', attemptId: 'a', generation: 2, createdAt: 1000, actionable: false });
        adapter.updateRuntimeSettings(settings);
        expect(adapter.notifyChange).toHaveBeenCalledTimes(1);
    });

    it('pre-claim startup trust is setup, never an actionable tool command', () => {
        const lifecycle = new ProviderApprovalLifecycle();
        lifecycle.observe({ ...state, id: 'trust' }, { ...modal, kind: 'confirm' }, 1000);
        expect(lifecycle.read()).toMatchObject({ type: 'provider_setup', evidence: 'live', actionable: false });
        expect(lifecycle.read()?.taskId).toBeUndefined();
    });

    it('a confirmed preconsumption setup gate pauses delivery redrive without task acceptance', () => {
        const setup = reduce({ attempt: makeAttempt('delivered'), holds: [makeHold('await_consume'), makeHold('await_turn')], evidence: ev('suspension', { modal: 'approval', modalKey: 'modal:setup', providerSetup: true }), policy: POLICY, nowMs: NOW });
        expect(setup.attempt).toMatchObject({ state: 'delivered', consumedAt: null });
        expect(surfaceStageOfAttempt(setup.attempt!)).toBe('waiting_approval');
        expect(setup.holds.map(h => h.reason)).toEqual(['suspension_before_consumed']);
        expect(setup.effects.some(e => e.kind === 'redeliver' || e.kind === 'reclaim')).toBe(false);
        const beforeDelivery = reduce({ attempt: makeAttempt('accepted'), holds: [makeHold('await_delivery')], evidence: ev('suspension', { modal: 'approval', modalKey: 'modal:setup', providerSetup: true }), policy: POLICY, nowMs: NOW });
        const delivered = reduce({ attempt: beforeDelivery.attempt, holds: beforeDelivery.holds, evidence: ev('delivered', { messageId: 'msg1', outcome: 'delivered', via: 'local' }), policy: POLICY, nowMs: NOW });
        expect(delivered.attempt).toMatchObject({ state: 'delivered', consumedAt: null });
        expect(delivered.holds.map(h => h.reason)).toEqual(['suspension_before_consumed']);
        const closed = reduce({ attempt: setup.attempt, holds: setup.holds, evidence: ev('suspension_resolved', { resolution: 'dismissed', via: 'modal_disappeared', modalKey: 'modal:setup' }, { at: NOW + 1000 }), policy: POLICY, nowMs: NOW + 1000 });
        expect(closed.attempt).toMatchObject({ state: 'delivered', consumedAt: null });
        expect(surfaceStageOfAttempt(closed.attempt!)).toBe('delivered');
        expect(closed.holds.map(h => h.reason)).toEqual(['await_consume', 'await_turn']);
        const bare = reduce({ attempt: makeAttempt('delivered'), holds: [makeHold('await_consume')], evidence: ev('suspension', { modal: 'approval' }), policy: POLICY, nowMs: NOW });
        expect(bare.holds.some(h => h.reason === 'await_consume')).toBe(true);
    });

    it('keeps target and displayed trust directories distinct and lists taskless setup as attention', () => {
        const displayedDirectory = readDisplayedTrustDirectory('Do you trust the contents of this directory?\n\n/Users/owner/project\nYes, proceed  y\nNo, quit  n');
        expect(displayedDirectory).toBe('/Users/owner/project');
        expect(readDisplayedTrustDirectory('unrelated bundle text\n/private/elsewhere')).toBeNull();
        const lifecycle = new ProviderApprovalLifecycle();
        lifecycle.observe({ ...state, id: 'trust' }, { ...modal, kind: 'confirm' }, 1000, { runtimeDirectory: '/tmp/worktree', displayedDirectory });
        const attention = collectProviderDecisionAttention([{ nodeId: 'n', health: 'online', activeSessionDetails: [{ sessionId: 's', providerApproval: lifecycle.read() }] }]);
        expect(attention).toHaveLength(1);
        expect(attention[0]).toMatchObject({ nodeId: 'n', sessionId: 's', runtimeDirectory: '/tmp/worktree', displayedDirectory, actionable: false });
        expect(attention[0].taskId).toBeUndefined();
    });

    it('reattached/incomplete evidence never invents a suspension clock', () => {
        const lifecycle = new ProviderApprovalLifecycle(); lifecycle.observe(state, modal, null);
        expect(lifecycle.read()?.createdAt).toBeNull();
        const suspended = reduce({ attempt: makeAttempt('generating'), holds: [], evidence: ev('suspension', { modal: 'approval', modalKey: 'modal:reattached', clockUnknown: true }), policy: POLICY, nowMs: NOW });
        expect(suspended.attempt?.data.providerSuspension?.at).toBeNull();
    });

    it('remote assignment identity survives projection and cannot rebind a tool modal to a newer generation', () => {
        const settings = { meshNodeFor: 'm', meshNodeId: 'n', meshActiveTaskId: 't', meshActiveAttemptId: 'remote-a', meshActiveAttemptGeneration: 2 };
        const lifecycle = new ProviderApprovalLifecycle();
        lifecycle.observe(state, modal, 1000, undefined, providerApprovalAssignment(settings));
        const raw = bindProviderApprovalAssignment(lifecycle.read(), settings)!;
        const projected = projectProviderApproval(raw, 'remote-s', 'grok-cli')!;
        expect(projected).toMatchObject({ meshId: 'm', nodeId: 'n', taskId: 't', attemptId: 'remote-a', generation: 2 });
        expect(matchesProviderApprovalTarget(projected, { modalKey: raw.modalKey!, attemptId: 'remote-a', generation: 2 })).toBe(true);
        expect(bindProviderApprovalAssignment(lifecycle.read(), { ...settings, meshActiveAttemptGeneration: 3 })).toMatchObject({ actionable: false, evidence: 'unavailable', generation: 2 });
    });

    it('status-only waiting has no user-approval count; uses suspension clock without dispatch fallback', () => {
        const record = { taskId: 't', taskTitle: 'Worker', source: 'queue', status: 'awaiting_approval', nodeId: 'n', sessionId: 's', createdAt: new Date(1000).toISOString(), dispatchedAt: new Date(1000).toISOString(), elapsedMs: 9000 } as any;
        expect(collectPendingApprovals([record])).toEqual([]);
        expect(buildMeshActiveWorkSummary([record]).awaitingApprovalCount).toBe(0);
        const lifecycle = new ProviderApprovalLifecycle();
        lifecycle.observe(state, modal, 8000);
        record.providerApproval = lifecycle.read();
        expect(collectPendingApprovals([record])[0]).toMatchObject({ waitingSince: new Date(8000).toISOString(), waitingMs: 2000 });
        record.providerApproval.createdAt = null;
        expect(collectPendingApprovals([record])[0]).toMatchObject({ waitingSince: null, waitingMs: null });
        record.providerApproval.buttons = [];
        expect(collectPendingApprovals([record])).toEqual([]);
        record.providerApproval.evidence = 'cached';
        expect(collectPendingApprovals([record])).toEqual([]);
    });

    it('records content-free suspension clock and resolved lifecycle on the exact generation', () => {
        const suspended = reduce({ attempt: makeAttempt('generating'), holds: [], evidence: ev('suspension', { modal: 'approval', modalKey: 'modal:first' }, { at: NOW + 2000 }), policy: POLICY, nowMs: NOW + 2000 });
        expect(suspended.attempt?.data.providerSuspension).toMatchObject({ at: NOW + 2000, modalKey: 'modal:first', resolvedAt: null });
        const resolved = reduce({ attempt: suspended.attempt, holds: suspended.holds, evidence: ev('suspension_resolved', { resolution: 'approved', via: 'modal_button' }, { at: NOW + 3000 }), policy: POLICY, nowMs: NOW + 3000 });
        expect(resolved.attempt?.data.providerSuspension?.resolvedAt).toBe(NOW + 3000);
        expect(suspended.attempt?.data.providerSuspension?.resolvedAt).toBeNull();
        const resumedByActivity = reduce({ attempt: suspended.attempt, holds: suspended.holds, evidence: ev('turn_started', { retro: false }, { at: NOW + 3500 }), policy: POLICY, nowMs: NOW + 3500 });
        expect(resumedByActivity.attempt?.data.providerSuspension?.resolvedAt).toBe(NOW + 3500);
        const replay = reduce({ attempt: makeAttempt('suspended', { generation: 2, suspension: 'approval' }), holds: [], evidence: ev('suspension_resolved', { resolution: 'approved', via: 'modal_button' }), policy: POLICY, nowMs: NOW });
        expect(replay.attempt?.state).toBe('suspended');
        const staleModal = reduce({ attempt: { ...suspended.attempt!, data: { providerSuspension: { generation: 1, modalKey: 'modal:new', at: NOW + 2500, resolvedAt: null } } }, holds: [], evidence: ev('suspension_resolved', { resolution: 'approved', via: 'modal_button', modalKey: 'modal:first' }), policy: POLICY, nowMs: NOW + 3000 });
        expect(staleModal.attempt?.state).toBe('suspended');
        expect(staleModal.attempt?.data.providerSuspension?.resolvedAt).toBeNull();
    });

    it('stale exact Inbox target performs no modal or PTY write', async () => {
        const resolveModal = vi.fn();
        const lifecycle = new ProviderApprovalLifecycle(); lifecycle.observe(state, modal, 1000);
        const adapter = { getStatus: () => ({ status: 'waiting_approval', providerApproval: lifecycle.read(), activeModal: { message: 'Permission', buttons: ['Yes', 'No'] } }), resolveModal, writeRaw: vi.fn() };
        const helpers = { getProvider: () => ({ type: 'grok-cli', category: 'cli' }), getCliAdapter: () => adapter, currentSession: { transport: 'pty', providerType: 'grok-cli', sessionId: 's' }, ctx: { instanceManager: { getInstance: () => null } } } as any;
        const result = await handleResolveAction(helpers, { targetSessionId: 's', action: 'approve', approvalTarget: { modalKey: 'modal:old', attemptId: null, generation: null } });
        expect(result.success).toBe(false);
        expect(resolveModal).not.toHaveBeenCalled(); expect(adapter.writeRaw).not.toHaveBeenCalled();
        resolveModal.mockImplementation(() => lifecycle.resolve(2000));
        const liveTarget = { modalKey: lifecycle.read()!.modalKey!, attemptId: null, generation: null };
        const valid = await handleResolveAction(helpers, { targetSessionId: 's', action: 'approve', approvalTarget: liveTarget });
        expect(valid.success).toBe(true); expect(resolveModal).toHaveBeenCalledTimes(1);
        const replay = await handleResolveAction(helpers, { targetSessionId: 's', action: 'approve', approvalTarget: liveTarget });
        expect(replay.success).toBe(false); expect(resolveModal).toHaveBeenCalledTimes(1);
        const nonPty = await handleResolveAction({ ...helpers, currentSession: { transport: 'cdp-webview' } }, { action: 'approve', approvalTarget: liveTarget });
        expect(nonPty.success).toBe(false); expect(adapter.writeRaw).not.toHaveBeenCalled();
    });
});
