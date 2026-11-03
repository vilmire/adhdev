/**
 * Owner override for a quota-held queue task (owner request 2026-11-01): the decision, the one-task waiver
 * honoured by BOTH quota gates, the hard-limit refusal, who may (not) grant it, the request path, the
 * escalation, the stuck-approval notice and the cancel hint.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testConfigDir = join(tmpdir(), `adhdev-quota-override-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/assistant/assistant-registry.js', () => ({
    getAssistantRegistry: () => ({ read: () => ({ sessionId: 'assistant-session-1' }), reload: () => ({ sessionId: 'assistant-session-1' }) }),
}));
const detectCliMocks = vi.hoisted(() => ({ detected: new Set<string>() }));
vi.mock('../../src/detection/cli-detector.js', () => ({
    detectCLI: async (id: string) => detectCliMocks.detected.has(id) ? { id, installed: true, path: `/mock/${id}` } : null,
}));

import { DECISION_PUSH_RELAY_COMMAND, DECISION_PUSH_RELAY_SOURCE } from '@adhdev/mesh-shared';
import { __resolveUsableProviderForTests } from '../../src/mesh/mesh-queue-assignment.js';
import { __replaceMeshQueueForTests, __resetMeshRuntimeStoreForTests, getQueueEntryById } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { answerMissionDecision, buildOwnerDecisions } from '../../src/mesh/mesh-mission-decisions.js';
import { setMissionChangeListener } from '../../src/mesh/mesh-mission-change-notifier.js';
import { evaluateQuotaClaimGateForAssignment } from '../../src/mesh/mesh-queue-claim-gate.js';
import {
    applyQuotaOverrideAnswer, hasQuotaOverride, quotaBlockOverridable, raiseQuotaOverrideDecision,
    resetQuotaGateEvidenceForTests, quotaOverrideDecisionKey, QUOTA_OVERRIDE_LABELS,
} from '../../src/mesh/mesh-quota-override.js';
import { escalateQuotaHeldTasks, requestQuotaOverrideDecision, resetQuotaEscalationForTests } from '../../src/mesh/mesh-quota-hold-escalation.js';
import { notifyStuckAssignedWorkers, resetStuckApprovalNoticesForTests, UNREADABLE_APPROVAL_NOTICE_AFTER_MS } from '../../src/mesh/mesh-stuck-approval-notify.js';
import { noteWriterStopPending, writerCancelRefusalHint, resetWriterStopDiagnosticsForTests } from '../../src/mesh/mesh-writer-stop-diagnostics.js';
import { WRITER_UNKNOWN_ERROR } from '../../src/mesh/mesh-queue-retirement.js';
import { stopExactMeshWriter } from '../../src/commands/mesh-writer-stop.js';
import { resetRoutingDecisionLogForTests } from '../../src/mesh/mesh-routing-decision.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { drainPendingMeshCoordinatorEvents } from '../helpers/pending-notices.js';
import { LOG } from '../../src/logging/logger.js';

const MESH_ID = 'mesh_quota_override';
const NODE_ID = 'node_quota_override';
const MIN = 60_000;
const QUOTA_REASON = 'all_providers_quota_gated: claude-cli: provider_quota_weekly_low';
const store = () => MeshRuntimeStore.getInstance();

function makeComponents() {
    return { providerLoader: { resolveAlias: (t: string) => t, isMachineProviderEnabled: () => true, setCliDetectionResults: () => {} } } as any;
}
function nodeWith(slots: any[], quota?: Record<string, any>) {
    return { id: NODE_ID, daemonId: 'daemon-local', policy: { slots }, ...(quota ? { nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), quota } } : {}) };
}
const okQuota = (provider: string, over: Record<string, any> = {}) => ({
    provider, status: 'ok',
    session: { usedPercent: 50, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
    updatedAt: Date.now() - MIN, error: null, ...over,
});
/** Weekly window 95% used (5% left, below the reserve) with a known reset. */
const weeklyLow = (provider: string, resetsAt = Date.now() + 3 * 86_400_000) =>
    okQuota(provider, { weekly: { usedPercent: 95, windowMinutes: 10080, resetsAt } });
const exhausted = (provider: string) => okQuota(provider, {
    status: 'error', session: null, weekly: null, error: 'usage limit reached', metadata: { source: 'oauth', failureKind: 'quota-exhausted' },
});
function row(id: string, over: Record<string, any> = {}) {
    const now = new Date().toISOString();
    return { id, meshId: MESH_ID, message: `task ${id}`, status: 'pending', difficulty: 'medium', createdAt: now, updatedAt: now, ...over };
}
const owner = { by: 'owner' as const, via: 'dashboard' as const };
const resolve = (node: any, taskId: string, requiredTags?: string[]) => __resolveUsableProviderForTests(
    makeComponents(), NODE_ID, node, MESH_ID, requiredTags, { difficulty: 'medium', requiredTags }, null, undefined, taskId);

beforeEach(() => {
    detectCliMocks.detected.clear();
    setMissionChangeListener(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setMissionChangeListener(null);
    resetQuotaGateEvidenceForTests(); resetQuotaEscalationForTests(); resetStuckApprovalNoticesForTests();
    resetWriterStopDiagnosticsForTests(); resetRoutingDecisionLogForTests();
    __resetMeshRuntimeStoreForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

const claudeOnly = (quota: Record<string, any>) => {
    detectCliMocks.detected.add('claude-cli');
    return nodeWith([{ provider: 'claude-cli', model: 'opus', difficulty: ['medium'], maxParallel: 2 }], { 'claude-cli': quota });
};

describe('quotaGateOverride is honoured by auto-launch for that one task only', () => {
    it('gated without the override, launchable with it, and the neighbouring task stays gated', async () => {
        const node = claudeOnly(weeklyLow('claude-cli'));
        __replaceMeshQueueForTests(MESH_ID, [
            row('plain'),
            row('waived', { quotaGateOverride: { by: 'owner', at: new Date().toISOString(), decisionId: 'item-1' } }),
        ] as any);
        const plain = await resolve(node, 'plain');
        expect(plain.providerType).toBeUndefined();
        expect(plain.reason).toContain('all_providers_quota_gated');
        const waived = await resolve(node, 'waived');
        expect(waived.providerType).toBe('claude-cli');
        expect((await resolve(node, 'plain')).providerType).toBeUndefined();
    });

    it('never lifts a provider at its own hard limit (fresh quota-exhausted verdict)', async () => {
        const node = claudeOnly(exhausted('claude-cli'));
        __replaceMeshQueueForTests(MESH_ID, [row('waived', { quotaGateOverride: { by: 'owner', at: new Date().toISOString(), decisionId: 'item-1' } })] as any);
        const r = await resolve(node, 'waived');
        expect(r.providerType).toBeUndefined();
        expect(r.reason).toContain('provider_quota_exhausted');
        expect(quotaBlockOverridable({ reason: 'provider_quota_exhausted', remainingPercent: 0 })).toBe(false);
        expect(quotaBlockOverridable({ reason: 'provider_quota_weekly_low', remainingPercent: 0 })).toBe(false);
        expect(quotaBlockOverridable({ reason: 'provider_quota_weekly_low', remainingPercent: 5 })).toBe(true);
    });
});

describe('quotaGateOverride is honoured by the claim gate for that one task only', () => {
    const NODE_WS = '/repo/quota-override';
    const claimNode = () => ({
        id: NODE_ID, daemonId: 'daemon-local', workspace: NODE_WS, repoRoot: NODE_WS, policy: {},
        nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), quota: { 'claude-cli': weeklyLow('claude-cli') } },
    });
    const gate = (over: Record<string, unknown> = {}) => {
        const node = claimNode();
        const quotaOverrideOnly = { on: false };
        const blocked = evaluateQuotaClaimGateForAssignment({
            meshId: MESH_ID, nodeId: NODE_ID, sessionId: 's1', providerType: 'claude-cli', trigger: 'idle_claim_scan',
            node, mesh: { id: MESH_ID, policy: {}, nodes: [node] }, providerLoader: makeComponents().providerLoader, quotaOverrideOnly, ...over,
        } as any);
        return { blocked, quotaOverrideOnly };
    };

    it('refuses with no waived task, and lets only the waived row through when one exists', () => {
        const waivedAt = { by: 'owner', at: new Date().toISOString(), decisionId: 'item-1' };
        __replaceMeshQueueForTests(MESH_ID, [row('older-plain', { createdAt: '2026-11-01T00:00:00.000Z' }), row('waived', { quotaGateOverride: waivedAt })] as any);
        // No waived task yet (replace again without the flag): blocked.
        __replaceMeshQueueForTests(MESH_ID, [row('older-plain', { createdAt: '2026-11-01T00:00:00.000Z' }), row('waived-not-yet')] as any);
        expect(gate()).toEqual({ blocked: true, quotaOverrideOnly: { on: false } });
        __replaceMeshQueueForTests(MESH_ID, [row('older-plain', { createdAt: '2026-11-01T00:00:00.000Z' }), row('waived', { createdAt: '2026-11-01T01:00:00.000Z', quotaGateOverride: waivedAt })] as any);
        const open = gate();
        expect(open.blocked).toBe(false);
        expect(open.quotaOverrideOnly.on).toBe(true);
        // The claim restricted to waived rows takes the NEWER waived task, not the older plain one.
        const claimed = store().claimNextQueueTask(MESH_ID, NODE_ID, 's1', [], { onlyQuotaOverridden: true });
        expect(claimed?.id).toBe('waived');
        expect(getQueueEntryById(MESH_ID, 'older-plain')?.status).toBe('pending');
    });

    it('a pin to another provider does not make a waived task claimable here', () => {
        __replaceMeshQueueForTests(MESH_ID, [row('waived', { requiredTags: ['provider=codex-cli'], quotaGateOverride: { by: 'owner', at: new Date().toISOString(), decisionId: 'i' } })] as any);
        expect(gate().blocked).toBe(true);
    });
});

describe('the owner decision', () => {
    const held = (id: string, over: Record<string, any> = {}) => row(id, {
        hold: { reason: QUOTA_REASON, since: new Date().toISOString(), blockingTaskIds: [], detail: {} }, ...over,
    });
    const taskOf = (id: string) => store().findQueueEntryById(MESH_ID, id)!;
    const itemOf = (itemId: string) => store().missionItems().getItem(MESH_ID, itemId)!;

    it('offers Wait (recommended), Run anyway, and Use another provider only when the task is pinned AND one exists', () => {
        __replaceMeshQueueForTests(MESH_ID, [held('pinned', { requiredTags: ['provider=claude-cli'] }), held('free')] as any);
        const withAlt = raiseQuotaOverrideDecision(MESH_ID, taskOf('pinned'), QUOTA_REASON, { alternatives: ['codex-cli'] });
        expect(withAlt).toMatchObject({ options: [QUOTA_OVERRIDE_LABELS.wait, QUOTA_OVERRIDE_LABELS.runAnyway, QUOTA_OVERRIDE_LABELS.otherProvider] });
        const d = buildOwnerDecisions(MESH_ID).find(e => e.itemId === (withAlt as any).itemId)!;
        expect(d.recommended).toBe('a');
        expect(d.options.map(o => o.id)).toEqual(['a', 'b', 'c']);
        // push-safe: provider labels and a percent, never the task body
        expect(d.question).not.toContain('task pinned');

        const noPin = raiseQuotaOverrideDecision(MESH_ID, taskOf('free'), QUOTA_REASON, { alternatives: ['codex-cli'] });
        expect((noPin as any).options).toEqual([QUOTA_OVERRIDE_LABELS.wait, QUOTA_OVERRIDE_LABELS.runAnyway]);
        const noAlt = raiseQuotaOverrideDecision(MESH_ID, taskOf('pinned'), QUOTA_REASON, { alternatives: [] });
        expect((noAlt as any).options).toEqual([QUOTA_OVERRIDE_LABELS.wait, QUOTA_OVERRIDE_LABELS.runAnyway]);
        // idempotent: asking again returns the same open decision
        expect(raiseQuotaOverrideDecision(MESH_ID, taskOf('pinned'), QUOTA_REASON, { alternatives: ['codex-cli'] })).toMatchObject({ deduped: true });
    });

    it('a provider at its hard limit with no alternative raises nothing; with an alternative it offers only Wait and Use another', () => {
        const hard = 'all_providers_quota_gated: claude-cli: provider_quota_exhausted';
        __replaceMeshQueueForTests(MESH_ID, [held('hard', { requiredTags: ['provider=claude-cli'], hold: { reason: hard, since: new Date().toISOString(), blockingTaskIds: [], detail: {} } })] as any);
        expect(raiseQuotaOverrideDecision(MESH_ID, taskOf('hard'), hard, { alternatives: [] })).toMatchObject({ error: expect.stringContaining('hard limit') });
        const alt = raiseQuotaOverrideDecision(MESH_ID, taskOf('hard'), hard, { alternatives: ['codex-cli'] });
        expect((alt as any).options).toEqual([QUOTA_OVERRIDE_LABELS.wait, QUOTA_OVERRIDE_LABELS.otherProvider]);
    });

    it('the owner answering Run anyway sets the override; changing back revokes it; Use another drops the pin', () => {
        __replaceMeshQueueForTests(MESH_ID, [held('t1', { requiredTags: ['provider=claude-cli', 'os=darwin'] })] as any);
        const { itemId } = raiseQuotaOverrideDecision(MESH_ID, taskOf('t1'), QUOTA_REASON, { alternatives: ['codex-cli'] }) as { itemId: string };
        expect(hasQuotaOverride(taskOf('t1'))).toBe(false);

        expect(answerMissionDecision({ meshId: MESH_ID, itemId, optionId: 'b' }, owner)).toMatchObject({ ok: true, action: 'answered' });
        expect(taskOf('t1').quotaGateOverride).toMatchObject({ by: 'owner', decisionId: itemId });

        expect(answerMissionDecision({ meshId: MESH_ID, itemId, optionId: 'a' }, owner)).toMatchObject({ ok: true, action: 'changed' });
        expect(hasQuotaOverride(taskOf('t1'))).toBe(false);

        answerMissionDecision({ meshId: MESH_ID, itemId, optionId: 'b' }, owner);
        expect(hasQuotaOverride(taskOf('t1'))).toBe(true);
        answerMissionDecision({ meshId: MESH_ID, itemId, undo: true }, owner);
        expect(hasQuotaOverride(taskOf('t1'))).toBe(false);

        answerMissionDecision({ meshId: MESH_ID, itemId, optionId: 'c' }, owner);
        expect(taskOf('t1').requiredTags).toEqual(['os=darwin']);
        expect(taskOf('t1').hold).toBeUndefined();
        expect(itemOf(itemId).dedupeKey).toBe(`k:${quotaOverrideDecisionKey('t1')}`);
    });

    it('records grant and pin-drop in the ledger', async () => {
        __replaceMeshQueueForTests(MESH_ID, [held('t1')] as any);
        const { itemId } = raiseQuotaOverrideDecision(MESH_ID, taskOf('t1'), QUOTA_REASON) as { itemId: string };
        answerMissionDecision({ meshId: MESH_ID, itemId, optionId: 'b' }, owner);
        const { readLocalRecords } = await import('../../src/mesh/mesh-local-records.js');
        const phases = readLocalRecords(MESH_ID, { kind: ['quota_gate_override'] }).map(e => (e.payload as any).phase);
        expect(phases).toEqual(expect.arrayContaining(['decision_raised', 'granted']));
    });

    it('COORDINATOR/ASSISTANT/PUSH cannot grant: only Wait is accepted from them', () => {
        __replaceMeshQueueForTests(MESH_ID, [held('t1', { requiredTags: ['provider=claude-cli'] })] as any);
        const { itemId } = raiseQuotaOverrideDecision(MESH_ID, taskOf('t1'), QUOTA_REASON, { alternatives: ['codex-cli'] }) as { itemId: string };
        for (const via of ['assistant', 'push'] as const) {
            for (const optionId of ['b', 'c']) {
                expect(answerMissionDecision({ meshId: MESH_ID, itemId, optionId, interpretedFrom: 'yes do it' }, { by: 'owner', via })).toMatchObject({ ok: false, code: 'quota_override_owner_only' });
            }
        }
        expect(hasQuotaOverride(taskOf('t1'))).toBe(false);
        expect(taskOf('t1').requiredTags).toEqual(['provider=claude-cli']);
        expect(answerMissionDecision({ meshId: MESH_ID, itemId, optionId: 'a' }, { by: 'owner', via: 'push' })).toMatchObject({ ok: true });
    });

    it('the push relay cannot grant: Run anyway is not the recommended option', async () => {
        __replaceMeshQueueForTests(MESH_ID, [held('t1')] as any);
        const { itemId } = raiseQuotaOverrideDecision(MESH_ID, taskOf('t1'), QUOTA_REASON) as { itemId: string };
        const spec = getDaemonCommandRegistry().get(DECISION_PUSH_RELAY_COMMAND)!;
        const run = (optionId: string) => spec.run({} as any, { _commandSource: DECISION_PUSH_RELAY_SOURCE, meshId: MESH_ID, itemId, optionId } as any) as Promise<any>;
        expect(await run('b')).toMatchObject({ success: false, code: 'option_not_relayable' });
        expect(hasQuotaOverride(taskOf('t1'))).toBe(false);
        expect(await run('a')).toMatchObject({ success: true });
        expect(hasQuotaOverride(taskOf('t1'))).toBe(false);
    });

    it('the assistant nudge reads the same store: the decision shows up in the owner-decision projection', () => {
        __replaceMeshQueueForTests(MESH_ID, [held('t1')] as any);
        const { itemId } = raiseQuotaOverrideDecision(MESH_ID, taskOf('t1'), QUOTA_REASON) as { itemId: string };
        expect(buildOwnerDecisions(MESH_ID).map(e => e.itemId)).toContain(itemId);
    });

    it('applyQuotaOverrideAnswer ignores every other decision and tasks that already left pending', () => {
        __replaceMeshQueueForTests(MESH_ID, [held('t1')] as any);
        const { itemId } = raiseQuotaOverrideDecision(MESH_ID, taskOf('t1'), QUOTA_REASON) as { itemId: string };
        answerMissionDecision({ meshId: MESH_ID, itemId, optionId: 'b' }, owner);
        __replaceMeshQueueForTests(MESH_ID, [held('t1', { status: 'assigned' })] as any);
        expect(applyQuotaOverrideAnswer(MESH_ID, itemId)).toMatchObject({ applied: 'none' });
        expect(applyQuotaOverrideAnswer(MESH_ID, 'no-such-item')).toEqual({ applied: 'none' });
    });
});

describe('request and escalation', () => {
    const heldAt = (since: number) => ({ reason: QUOTA_REASON, since: new Date(since).toISOString(), blockingTaskIds: [] as string[], detail: {} });

    it('a coordinator request raises the decision at once, grants nothing, and refuses when nothing is quota-held', async () => {
        __replaceMeshQueueForTests(MESH_ID, [row('held', { hold: heldAt(Date.now()) }), row('free')] as any);
        const asked = await requestQuotaOverrideDecision(null, MESH_ID, 'held', null, { findAlternatives: async () => [] });
        expect(asked).toMatchObject({ ok: true, deduped: false });
        expect(hasQuotaOverride(store().findQueueEntryById(MESH_ID, 'held'))).toBe(false);
        expect(await requestQuotaOverrideDecision(null, MESH_ID, 'free', null)).toMatchObject({ ok: false, code: 'not_quota_held' });
        expect(await requestQuotaOverrideDecision(null, MESH_ID, 'nope', null)).toMatchObject({ ok: false, code: 'task_not_found' });
    });

    it('raises one decision after the threshold, never twice, and withdraws it when the hold clears', async () => {
        const now = Date.now();
        __replaceMeshQueueForTests(MESH_ID, [row('young', { hold: heldAt(now - 2 * MIN) }), row('old', { hold: heldAt(now - 11 * MIN) })] as any);
        const find = vi.fn(async () => []);
        const first = await escalateQuotaHeldTasks(null, MESH_ID, null, { now, afterMs: 10 * MIN, findAlternatives: find });
        expect(first).toHaveLength(1);
        expect(find).toHaveBeenCalledTimes(1);
        expect(await escalateQuotaHeldTasks(null, MESH_ID, null, { now: now + 5000, afterMs: 10 * MIN, findAlternatives: find })).toEqual([]);
        expect(buildOwnerDecisions(MESH_ID)).toHaveLength(1);
        // the provider recovered: hold gone -> decision withdrawn
        __replaceMeshQueueForTests(MESH_ID, [row('young', { hold: heldAt(now - 2 * MIN) }), row('old')] as any);
        await escalateQuotaHeldTasks(null, MESH_ID, null, { now: now + 6000, afterMs: 10 * MIN, findAlternatives: find });
        expect(buildOwnerDecisions(MESH_ID)).toHaveLength(0);
    });

    it('does not escalate holds that are not quota holds, or tasks the owner already waived', async () => {
        const now = Date.now();
        __replaceMeshQueueForTests(MESH_ID, [
            row('paths', { hold: { reason: 'owned_paths_conflict', since: new Date(now - 30 * MIN).toISOString(), blockingTaskIds: [], detail: {} } }),
            row('waived', { hold: heldAt(now - 30 * MIN), quotaGateOverride: { by: 'owner', at: new Date().toISOString(), decisionId: 'x' } }),
        ] as any);
        expect(await escalateQuotaHeldTasks(null, MESH_ID, null, { now, afterMs: 10 * MIN, findAlternatives: async () => [] })).toEqual([]);
    });
});

describe('stuck assigned worker on an approval modal the daemon cannot read', () => {
    const components = (state: any) => ({ instanceManager: { getInstance: () => ({ getState: () => state }) } }) as any;
    const unreadable = { providerApproval: { lifecycle: 'pending', evidence: 'unavailable', modalKey: null, resolvedAt: null } };

    it('pages the coordinator once after the grace period, naming the session and the ways out', () => {
        __replaceMeshQueueForTests(MESH_ID, [row('c883', { status: 'assigned', assignedSessionId: 'sess-grok', assignedNodeId: NODE_ID, assignedProviderType: 'grok-cli' })] as any);
        const t0 = Date.now();
        expect(notifyStuckAssignedWorkers(components(unreadable), MESH_ID, t0)).toBe(0);
        expect(notifyStuckAssignedWorkers(components(unreadable), MESH_ID, t0 + UNREADABLE_APPROVAL_NOTICE_AFTER_MS)).toBe(1);
        expect(notifyStuckAssignedWorkers(components(unreadable), MESH_ID, t0 + 5 * MIN)).toBe(0);
        const [event] = drainPendingMeshCoordinatorEvents(MESH_ID, 'test-machine') as any[];
        expect(event.coordinatorMessage).toContain('sess-grok');
        expect(event.coordinatorMessage).toContain('mesh_cleanup_sessions');
        expect(event.metadataEvent).toMatchObject({ source: 'mesh_worker_approval_unreadable', taskId: 'c883' });
    });

    it('stays silent for a readable modal, and re-arms after the prompt clears', () => {
        __replaceMeshQueueForTests(MESH_ID, [row('c883', { status: 'assigned', assignedSessionId: 'sess-grok', assignedNodeId: NODE_ID })] as any);
        const t0 = Date.now();
        const live = { providerApproval: { lifecycle: 'pending', evidence: 'live', modalKey: 'modal:1', resolvedAt: null } };
        expect(notifyStuckAssignedWorkers(components(live), MESH_ID, t0 + 10 * MIN)).toBe(0);
        notifyStuckAssignedWorkers(components(unreadable), MESH_ID, t0);
        notifyStuckAssignedWorkers(components({}), MESH_ID, t0 + MIN); // cleared
        expect(notifyStuckAssignedWorkers(components(unreadable), MESH_ID, t0 + 2 * MIN)).toBe(0); // grace restarts
    });
});

describe('cancel refusal for a worker that is alive but stuck', () => {
    it('names the session, the host\'s own last answer, and the stop that lets the cancel settle', async () => {
        const request = { sessionId: 'sess-grok', providerType: 'grok-cli' } as any;
        await stopExactMeshWriter({ adapters: new Map(), deps: {} } as any, request);
        const hint = writerCancelRefusalHint({ assignedSessionId: 'sess-grok', assignedNodeId: NODE_ID });
        expect(hint).toContain('sess-grok');
        expect(hint).toContain('missing_identity');
        expect(WRITER_UNKNOWN_ERROR + hint).toMatch(/retained\. Worker session /);
        expect(hint).toContain('mesh_cleanup_sessions');
        expect(hint).toContain(`node_id:"${NODE_ID}"`);
        expect(writerCancelRefusalHint({})).toBe('');
        noteWriterStopPending('x', 'native_ownership_unconfirmed');
        expect(writerCancelRefusalHint({ assignedSessionId: 'x' })).toContain('native_ownership_unconfirmed');
    });
});

describe('ROUTING DECISION log noise', () => {
    it('logs a held outcome once while it is unchanged, and again when it changes', async () => {
        const info = vi.spyOn(LOG, 'info');
        const node = claudeOnly(weeklyLow('claude-cli'));
        __replaceMeshQueueForTests(MESH_ID, [row('held-log')] as any);
        const decisions = () => info.mock.calls.filter(c => String(c[1]).startsWith('ROUTING DECISION')).length;
        await resolve(node, 'held-log'); await resolve(node, 'held-log'); await resolve(node, 'held-log');
        expect(decisions()).toBe(1);
        const healthy = claudeOnly(okQuota('claude-cli'));
        await resolve(healthy, 'held-log');
        expect(decisions()).toBe(2);
        await resolve(healthy, 'held-log'); // a decision that picks a provider is a real dispatch input: always logged
        expect(decisions()).toBe(3);
    });
});
