import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshLaunchSession } from '../src/tools/mesh-tools.js';
import { checkDirectDispatchQuotaGate } from '../src/tools/mesh-remote-dispatch.js';
import { summarizeNodeQuota } from '../src/tools/mesh-compact.js';

// Review REJECT follow-up (fix/agy-quota-model-groups): direct dispatch, manual
// launch and the mesh_status compact line must judge an Antigravity session by
// its own model group, not the blended worst-pool headline.
// Owner shape: Gemini weekly 0% left (5h window disabled); Claude/GPT weekly
// 55.65% left, 5h 100% left.

const MIN = 60_000;
const GEMINI = 'Gemini 4 Argon (Medium)';
const CLAUDE = 'Claude Opus 4.6 (Thinking)';

function agyQuota(now = Date.now()) {
    const bucket = (group: string, name: string, usedPercent: number, windowMinutes: number) => ({
        name, group, usedPercent, windowMinutes,
        resetsAt: now + (windowMinutes === 10080 ? 2000 : 60) * MIN,
    });
    return {
        provider: 'antigravity-cli',
        status: 'ok',
        // Blended headline = WORST pool.
        session: { usedPercent: 0, windowMinutes: 300, resetsAt: now + 60 * MIN },
        weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: now + 2000 * MIN },
        buckets: [
            bucket('gemini', 'Gemini Models · Weekly Limit Remaining', 100, 10080),
            bucket('claude-gpt', 'Claude and GPT models · Weekly Limit Remaining', 44.35, 10080),
            bucket('claude-gpt', 'Claude and GPT models · Five Hour Limit Remaining', 0, 300),
        ],
        updatedAt: now,
        error: null,
    };
}

function node(now = Date.now(), policy: Record<string, unknown> = {}) {
    return {
        id: 'node-a', workspace: '/repo', repoRoot: '/repo', userOverrides: {}, policy,
        nodeFacts: { schemaVersion: 1, reportedAt: now, quota: { 'antigravity-cli': agyQuota(now) } },
    } as any;
}

test('direct dispatch: Claude/GPT session passes, Gemini session is refused, no model keeps the blended gate', () => {
    const n = node();
    assert.equal(checkDirectDispatchQuotaGate(n, 'antigravity-cli', null, CLAUDE), null);
    const gemini = checkDirectDispatchQuotaGate(n, 'antigravity-cli', null, GEMINI);
    assert.equal(gemini?.block.group, 'gemini');
    assert.equal(gemini?.block.window, 'weekly');
    assert.equal(typeof gemini?.resetsAt, 'number', 'names the group window reset');
    // Legacy callers without a model retain the headline decision.
    assert.ok(checkDirectDispatchQuotaGate(n, 'antigravity-cli', null));
});

function makeLaunchCtx(policy: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const transport = new IpcTransport() as any;
    const launchCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const n = { ...node(Date.now(), policy), ...extra };
    const mesh = {
        id: 'mesh-agy', name: 'AGY', repoIdentity: 'example/repo', policy: {}, coordinator: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodes: [n],
    };
    transport.command = async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'trigger_mesh_queue') return { success: true, trigger: { success: true } };
        if (command === 'launch_cli') { launchCalls.push({ command, args }); return { success: true, sessionId: 'session-1' }; }
        if (command === 'detect_provider') return { success: true, detected: true };
        throw new Error(`unexpected direct command: ${command}`);
    };
    transport.meshCommand = async (_d: string, command: string) => {
        if (command === 'get_status_metadata') return { success: true, result: { status: { sessions: [] } } };
        if (command === 'detect_provider') return { success: true, result: { success: true, detected: true } };
        return { success: true, result: { success: true } };
    };
    return { ctx: { mesh, transport, localDaemonId: 'daemon-a' } as any, launchCalls };
}

test('launch type detection: a Claude/GPT-only AGY slot launches despite the 100%-used blended weekly', async () => {
    const { ctx, launchCalls } = makeLaunchCtx({ slots: [{ provider: 'antigravity-cli', model: CLAUDE }] });
    const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
    assert.notEqual(result.success, false, JSON.stringify(result));
    assert.equal(launchCalls.find(c => c.command === 'launch_cli')?.args.cliType, 'antigravity-cli');
});

test('launch type detection: a Gemini-only AGY slot is gated by its own exhausted pool', async () => {
    const { ctx, launchCalls } = makeLaunchCtx({ slots: [{ provider: 'antigravity-cli', model: GEMINI }] });
    const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(launchCalls.length, 0, 'nothing launched onto the exhausted Gemini pool');
});

test('explicit type warning follows the slot model: warns for Gemini, silent for Claude/GPT', async () => {
    const gemini = makeLaunchCtx({ slots: [{ provider: 'antigravity-cli', model: GEMINI }] });
    const warned = JSON.parse(await meshLaunchSession(gemini.ctx, { node_id: 'node-a', type: 'antigravity-cli' }));
    assert.ok(warned.quotaWarning, JSON.stringify(warned));
    const claude = makeLaunchCtx({ slots: [{ provider: 'antigravity-cli', model: CLAUDE }] });
    const quiet = JSON.parse(await meshLaunchSession(claude.ctx, { node_id: 'node-a', type: 'antigravity-cli' }));
    assert.equal(quiet.quotaWarning, undefined, JSON.stringify(quiet));
});

test('mesh_status compact line shows per-group values, not the blended 7d 100%', () => {
    const line = summarizeNodeQuota({ 'antigravity-cli': agyQuota() })?.['antigravity-cli'] ?? '';
    assert.match(line, /gemini 7d 100% 5h —/);
    assert.match(line, /claude-gpt 7d 44% 5h 0%/);
    assert.doesNotMatch(line, /^7d 100%/);
});
