import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshLaunchSession } from '../src/tools/mesh-tools.js';

// mesh_launch_session without `type` on a node that declares neither slots nor
// providerPriority (and carries no facts bundle — a standalone node) used to refuse
// with "has no providerPriority policy". The queue auto-launch launches on such a node
// because the DAEMON's routing (resolveUsableProvider) falls back to the machine's
// enabled providers. The manual launch now asks that same routing via
// `mesh_resolve_launch_provider` instead of keeping a second copy of the policy.

function makeCtx(opts: { resolve: (args: any) => unknown }) {
  const transport = new IpcTransport() as any;
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'get_mesh') return { success: true, mesh: (args as any).inlineMesh || mesh };
    if (command === 'trigger_mesh_queue') return { success: true, trigger: { success: true } };
    if (command === 'tool_call_record') return { success: true, rateLimitExceeded: false, callsInWindow: 1, advisory: null };
    if (command === 'record_local') return { success: true, eventId: 'evt-1', storedLocally: true, published: false };
    if (command === 'launch_cli') return { success: true, sessionId: 'session-1' };
    if (command === 'mesh_resolve_launch_provider') return opts.resolve(args);
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async () => ({ success: true, result: { success: true } });
  const mesh = {
    id: 'mesh-routed', name: 'M', repoIdentity: 'example/repo', policy: {}, coordinator: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [{ id: 'node-bare', workspace: '/repo', repoRoot: '/repo', userOverrides: {}, policy: {} }],
  };
  return { ctx: { mesh, transport, localDaemonId: 'daemon-a' } as any, calls };
}

test('no type + no providerPriority: launches on the provider the daemon routing picks', async () => {
  const { ctx, calls } = makeCtx({ resolve: () => ({ success: true, providerType: 'claude-cli', model: 'opus', thinkingLevel: 'high' }) });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-bare', force: true }));
  assert.equal(result.success !== false, true, JSON.stringify(result));
  const route = calls.find(c => c.command === 'mesh_resolve_launch_provider');
  assert.deepEqual(route?.args, { meshId: 'mesh-routed', nodeId: 'node-bare' });
  const launch = calls.find(c => c.command === 'launch_cli');
  assert.equal(launch?.args.cliType, 'claude-cli');
  assert.equal(launch?.args.initialModel, 'opus');
  assert.equal(launch?.args.initialThinkingLevel, 'high');
  assert.equal(result.resolvedProviderType, 'claude-cli');
});

test('daemon routing finds nothing: the legacy refusal stays and carries the routing reason', async () => {
  const { ctx, calls } = makeCtx({ resolve: () => ({ success: false, code: 'mesh_launch_provider_unresolved', reason: 'missing_provider_priority' }) });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-bare', force: true }));
  assert.equal(result.success, false);
  assert.match(result.error, /no providerPriority policy/);
  assert.equal(result.routingReason, 'missing_provider_priority');
  assert.equal(calls.some(c => c.command === 'launch_cli'), false);
});

test('an older daemon without the command keeps the legacy refusal', async () => {
  const { ctx, calls } = makeCtx({ resolve: () => { throw new Error('unknown command'); } });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-bare', force: true }));
  assert.equal(result.success, false);
  assert.match(result.error, /no providerPriority policy/);
  assert.equal(calls.some(c => c.command === 'launch_cli'), false);
});

test('an explicit type never consults the routing (pin + warning behaviour unchanged)', async () => {
  const { ctx, calls } = makeCtx({ resolve: () => ({ success: true, providerType: 'kimi' }) });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-bare', type: 'codex-cli', force: true }));
  assert.equal(result.success !== false, true, JSON.stringify(result));
  assert.equal(calls.some(c => c.command === 'mesh_resolve_launch_provider'), false);
  assert.equal(calls.find(c => c.command === 'launch_cli')?.args.cliType, 'codex-cli');
  assert.deepEqual(result.providerPinWarnings?.[0]?.requestedProviders, ['codex-cli']);
});
