import assert from 'node:assert/strict';
import test from 'node:test';

import { launchSession } from '../src/tools/launch-session.js';

// STAGE6-CANARY follow-up: MCP launch_session used to route by a type-string
// suffix heuristic (`-cli` / `-acp` / 'codex'), so the canonical CLI provider
// type `kimi` was misrouted to launch_ide and rejected with "IDE 'kimi' not
// found". Routing now comes from the daemon's authoritative provider catalog
// (list_provider_availability: type + aliases + category), resolving canonical
// types and manifest aliases to the correct launch verb, and failing closed on
// unknown types. The legacy heuristic only survives as a fallback for older
// daemons that do not answer the catalog command.

const CATALOG = {
  success: true,
  providers: [
    { type: 'kimi', category: 'cli', aliases: ['kimi-code', 'kimi-cli'] },
    { type: 'codex-cli', category: 'cli', aliases: ['codex'] },
    { type: 'hermes-cli', category: 'cli', aliases: ['hermes', 'hermes-agent'] },
    { type: 'claude-cli', category: 'cli', aliases: ['claude', 'claude-code'] },
    { type: 'claude-acp', category: 'acp', aliases: [] },
    { type: 'cursor', category: 'ide', aliases: [] },
  ],
};

function makeTransport(opts: { catalog?: unknown; catalogThrows?: boolean } = {}) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const transport = {
    command: async (command: string, args: Record<string, unknown> = {}) => {
      if (command === 'list_provider_availability') {
        if (opts.catalogThrows) throw new Error('unknown command');
        return opts.catalog === undefined ? CATALOG : opts.catalog;
      }
      calls.push({ command, args });
      if (command === 'launch_cli') return { success: true, id: 'sess-1' };
      if (command === 'launch_ide') return { success: true, id: 'ide-1' };
      throw new Error(`unexpected command: ${command}`);
    },
  } as any;
  return { transport, calls };
}

test('canonical CLI type kimi routes to launch_cli with the exact canonical type', async () => {
  const { transport, calls } = makeTransport();
  const out = await launchSession(transport, { type: 'kimi', workspace: '/tmp/repo' });
  assert.match(out, /Session launched/);
  const launch = calls.find((c) => c.command === 'launch_cli');
  assert.ok(launch, 'launch_cli was issued');
  assert.equal(launch!.args.cliType, 'kimi');
  assert.equal(launch!.args.dir, '/tmp/repo');
  assert.equal(calls.some((c) => c.command === 'launch_ide'), false);
});

test('manifest alias kimi-code resolves to canonical kimi', async () => {
  const { transport, calls } = makeTransport();
  await launchSession(transport, { type: 'kimi-code' });
  const launch = calls.find((c) => c.command === 'launch_cli');
  assert.ok(launch, 'launch_cli was issued');
  assert.equal(launch!.args.cliType, 'kimi');
});

test('existing alias codex still resolves to codex-cli (aliases unchanged)', async () => {
  const { transport, calls } = makeTransport();
  await launchSession(transport, { type: 'codex' });
  const launch = calls.find((c) => c.command === 'launch_cli');
  assert.ok(launch, 'launch_cli was issued');
  assert.equal(launch!.args.cliType, 'codex-cli');
});

test('canonical types hermes-cli / claude-cli keep their CLI route', async () => {
  const { transport, calls } = makeTransport();
  await launchSession(transport, { type: 'hermes-cli' });
  await launchSession(transport, { type: 'claude-cli' });
  const types = calls.filter((c) => c.command === 'launch_cli').map((c) => c.args.cliType);
  assert.deepEqual(types, ['hermes-cli', 'claude-cli']);
});

test('ACP provider claude-acp routes to launch_cli', async () => {
  const { transport, calls } = makeTransport();
  await launchSession(transport, { type: 'claude-acp', model: 'claude-opus-4-7' });
  const launch = calls.find((c) => c.command === 'launch_cli');
  assert.ok(launch, 'launch_cli was issued');
  assert.equal(launch!.args.cliType, 'claude-acp');
  assert.equal(launch!.args.model, 'claude-opus-4-7');
});

test('IDE type cursor routes to launch_ide', async () => {
  const { transport, calls } = makeTransport();
  await launchSession(transport, { type: 'cursor' });
  const launch = calls.find((c) => c.command === 'launch_ide');
  assert.ok(launch, 'launch_ide was issued');
  assert.equal(launch!.args.ideType, 'cursor');
  assert.equal(calls.some((c) => c.command === 'launch_cli'), false);
});

test('unknown provider type fails closed — no launch verb issued', async () => {
  const { transport, calls } = makeTransport();
  const out = await launchSession(transport, { type: 'definitely-not-a-provider' });
  assert.match(out, /Unknown provider type 'definitely-not-a-provider'/);
  assert.match(out, /kimi/); // error lists known types to help the operator
  assert.equal(calls.some((c) => c.command === 'launch_cli' || c.command === 'launch_ide'), false);
});

test('catalog unavailable → legacy suffix heuristic still routes -cli types (older daemons)', async () => {
  const { transport, calls } = makeTransport({ catalogThrows: true });
  await launchSession(transport, { type: 'claude-cli' });
  const launch = calls.find((c) => c.command === 'launch_cli');
  assert.ok(launch, 'launch_cli was issued via legacy fallback');
  assert.equal(launch!.args.cliType, 'claude-cli');
});

test('daemon-reported launch failure surfaces the daemon error', async () => {
  const { transport } = makeTransport();
  transport.command = async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'list_provider_availability') return CATALOG;
    if (command === 'launch_cli') return { success: false, error: 'Provider is disabled on this machine: kimi' };
    throw new Error(`unexpected command: ${command}`);
  };
  const out = await launchSession(transport, { type: 'kimi' });
  assert.match(out, /Provider is disabled on this machine: kimi/);
});
