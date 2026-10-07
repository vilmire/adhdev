/**
 * Assistant-mode parity gate (docs/design/2026-10-07-assistant-layer.md §4.4):
 * `adhdev mcp --assistant` advertises exactly `ASSISTANT_TOOLS`
 * (@adhdev/mesh-shared), in order, every tool annotated, the write annotations
 * matching `ASSISTANT_WRITE_TOOLS`, and each tool calling
 * `ASSISTANT_TOOL_VERBS[tool]` with the caller's `assistantSessionId`.
 *
 * Mirrors worker-tools-parity.test.ts. Imports only mcp-server src and the
 * built @adhdev/mesh-shared dist — no daemon-core dist dependency.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_SESSION_ID_ARG,
  ASSISTANT_SESSION_ID_ENV,
  ASSISTANT_TOOLS,
  ASSISTANT_TOOL_VERBS,
  ASSISTANT_VERB,
  ASSISTANT_WRITE_TOOLS,
  CANONICAL_MESH_TOOL_NAMES,
  WORKER_TOOLS,
} from '@adhdev/mesh-shared';

import {
  ALL_ASSISTANT_TOOL_SCHEMAS,
  readAssistantSessionIdFromEnv,
  resolveAssistantModeTools,
} from '../src/tools/assistant-tools.js';
import { handleAssistantToolCall } from '../src/assistant-server.js';
import { McpCliArgsError, parseArgs } from '../src/cli-args.js';
import { buildMcpHelpText } from '../src/help.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

/** Minimal valid arguments per tool, so the arg gate passes and the verb is reached. */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  projects: {},
  project_status: { project: 'adhdev' },
  project_send: { project: 'adhdev', message: 'run the tests' },
  project_read: { project: 'adhdev' },
  project_add: { path: '/tmp/repo' },
  discover_repos: {},
  memory: { action: 'add', target: 'user', text: 'reports in one line' },
  skill_view: { name: 'list' },
  skill_manage: { action: 'archive', name: 'old-skill' },
  project_note: { project: 'adhdev', action: 'record', text: 'oss commits in English' },
};

function fakeTransport(reply: (type: string, args: Record<string, unknown>) => any = () => ({ success: true })) {
  const calls: Array<{ type: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async command(type: string, args: Record<string, unknown> = {}) {
      calls.push({ type, args });
      return reply(type, args);
    },
  };
}

// ─── Published list ────────────────────────────────────────────────────────

test('ListTools in --assistant mode equals ASSISTANT_TOOLS, in tuple order, every entry annotated', () => {
  const tools = resolveAssistantModeTools();
  assert.deepEqual(tools.map(t => t.name), [...ASSISTANT_TOOLS]);
  for (const tool of tools) {
    assert.ok(tool.annotations, `${tool.name} must carry behavior annotations`);
    assert.equal(tool.inputSchema.type, 'object');
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      assert.equal(typeof tool.annotations[key], 'boolean', `${tool.name}.${key}`);
    }
  }
});

test('write annotations match ASSISTANT_WRITE_TOOLS exactly; every other assistant tool is read-only', () => {
  const tools = resolveAssistantModeTools();
  const writes = tools.filter(t => !t.annotations.readOnlyHint).map(t => t.name).sort();
  assert.deepEqual(writes, [...ASSISTANT_WRITE_TOOLS].sort());
});

test('assistant tools share no name with mesh or worker tools', () => {
  const others = new Set<string>([...CANONICAL_MESH_TOOL_NAMES, ...WORKER_TOOLS]);
  for (const name of ASSISTANT_TOOLS) assert.ok(!others.has(name), `${name} collides with a mesh/worker tool`);
});

// ─── Startup assertion ─────────────────────────────────────────────────────

test('a schema that is not in ASSISTANT_TOOLS fails the startup assertion', () => {
  const bogus = { ...ALL_ASSISTANT_TOOL_SCHEMAS[0], name: 'bogus_assistant_tool' };
  assert.throws(
    () => resolveAssistantModeTools([...ALL_ASSISTANT_TOOL_SCHEMAS, bogus]),
    /schema not in ASSISTANT_TOOLS \[bogus_assistant_tool\]/,
  );
});

test('an ASSISTANT_TOOLS entry with no schema fails the startup assertion', () => {
  const withoutMemory = ALL_ASSISTANT_TOOL_SCHEMAS.filter(t => t.name !== 'memory');
  assert.throws(() => resolveAssistantModeTools(withoutMemory), /missing schema for \[memory\]/);
});

test('a duplicated schema fails the startup assertion', () => {
  assert.throws(
    () => resolveAssistantModeTools([...ALL_ASSISTANT_TOOL_SCHEMAS, ALL_ASSISTANT_TOOL_SCHEMAS[2]]),
    /defined twice/,
  );
});

// ─── Verb + session id forwarding ──────────────────────────────────────────

test('each tool calls ASSISTANT_TOOL_VERBS[tool] and forwards assistantSessionId', async () => {
  const tools = resolveAssistantModeTools();
  assert.deepEqual(Object.keys(MINIMAL_ARGS).sort(), [...ASSISTANT_TOOLS].sort(), 'fixture covers every tool');
  for (const name of ASSISTANT_TOOLS) {
    const transport = fakeTransport();
    const res = await handleAssistantToolCall(transport, tools, 'sess-assistant-1', name, MINIMAL_ARGS[name]);
    assert.equal(res.isError, undefined, `${name}: ${res.content[0]?.text}`);
    const toolCall = transport.calls[0];
    assert.ok(toolCall, `${name} made no daemon call`);
    assert.equal(toolCall.type, ASSISTANT_TOOL_VERBS[name], `${name} must call its verb`);
    assert.equal(toolCall.args[ASSISTANT_SESSION_ID_ARG], 'sess-assistant-1', `${name} must forward the session id`);
    for (const [key, value] of Object.entries(MINIMAL_ARGS[name])) {
      assert.deepEqual(toolCall.args[key], value, `${name} passes ${key} through`);
    }
  }
});

test('assistantSessionId is omitted when the env var is absent, and a tool argument cannot set it', async () => {
  const tools = resolveAssistantModeTools();
  const transport = fakeTransport();
  await handleAssistantToolCall(transport, tools, undefined, 'projects', {});
  assert.equal(Object.prototype.hasOwnProperty.call(transport.calls[0].args, ASSISTANT_SESSION_ID_ARG), false);

  const forged = fakeTransport();
  const res = await handleAssistantToolCall(forged, tools, 'sess-real', 'projects', { [ASSISTANT_SESSION_ID_ARG]: 'sess-forged' });
  assert.equal(res.isError, true, 'undeclared assistantSessionId argument is rejected');
  assert.equal(forged.calls.length, 0);
});

test('readAssistantSessionIdFromEnv reads ADHDEV_ASSISTANT_SESSION_ID (trimmed, blank → undefined)', () => {
  assert.equal(ASSISTANT_SESSION_ID_ENV, 'ADHDEV_ASSISTANT_SESSION_ID');
  assert.equal(readAssistantSessionIdFromEnv({ [ASSISTANT_SESSION_ID_ENV]: '  sess-9 ' } as NodeJS.ProcessEnv), 'sess-9');
  assert.equal(readAssistantSessionIdFromEnv({ [ASSISTANT_SESSION_ID_ENV]: '   ' } as NodeJS.ProcessEnv), undefined);
  assert.equal(readAssistantSessionIdFromEnv(EMPTY_ENV), undefined);
});

test('argument gate: unknown key, bad enum value and missing required key never reach the daemon', async () => {
  const tools = resolveAssistantModeTools();
  for (const [name, args, pattern] of [
    ['memory', { action: 'add', target: 'user', txt: 'x' }, /Unknown parameter/],
    ['memory', { action: 'delete', target: 'user' }, /Invalid value for "action"/],
    ['project_send', { project: 'adhdev' }, /Missing required parameter.*"message"/],
    ['nonexistent_tool', {}, /Unknown tool/],
  ] as const) {
    const transport = fakeTransport();
    const res = await handleAssistantToolCall(transport, tools, 'sess', name, args as Record<string, unknown>);
    assert.equal(res.isError, true, name);
    assert.match(res.content[0].text, pattern);
    assert.equal(transport.calls.length, 0, `${name} must not reach the daemon`);
  }
});

test('project_send accepts the daemon\'s supplement and messageId and passes them through unchanged', async () => {
  const tools = resolveAssistantModeTools();
  const send = tools.find(t => t.name === 'project_send')!;
  for (const key of ['supplement', 'messageId'] as const) {
    assert.equal((send.inputSchema.properties[key] as { type?: string })?.type, 'string', `project_send.${key} is declared`);
  }
  assert.deepEqual(send.inputSchema.required, ['project', 'message'], 'supplement and messageId stay optional');
  assert.match(send.description, /duplicate/, 'the description documents the duplicate status');
  const args = { project: 'adhdev', message: '테스트 돌려줘', supplement: 'Context: CI was red yesterday.', messageId: 'turn3-1' };
  const transport = fakeTransport();
  const res = await handleAssistantToolCall(transport, tools, 'sess', 'project_send', args);
  assert.equal(res.isError, undefined, res.content[0]?.text);
  const call = transport.calls[0];
  assert.equal(call.type, ASSISTANT_TOOL_VERBS.project_send);
  for (const [key, value] of Object.entries(args)) assert.deepEqual(call.args[key], value, `passes ${key} through`);
});

test('a daemon refusal (or an unknown verb) is returned as an error with the daemon payload', async () => {
  const tools = resolveAssistantModeTools();
  const transport = fakeTransport((type) => type === ASSISTANT_VERB.projects
    ? { success: false, error: 'Unknown command: assistant_projects' }
    : { success: false });
  const res = await handleAssistantToolCall(transport, tools, 'sess', 'projects', {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Unknown command: assistant_projects/);
});

// ─── MCP-only relay attachment ─────────────────────────────────────────────

test('pending relays are attached as assistantEvents to a JSON tool response', async () => {
  const tools = resolveAssistantModeTools();
  const events = [{ project: 'adhdev', text: 'tests green' }];
  const transport = fakeTransport((type) => type === ASSISTANT_VERB.pendingRelays
    ? { success: true, assistantEvents: events }
    : { success: true, result: 'applied' });
  const res = await handleAssistantToolCall(transport, tools, 'sess-1', 'memory', MINIMAL_ARGS.memory);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.result, 'applied');
  assert.deepEqual(body.assistantEvents, events);
  const pull = transport.calls.find(c => c.type === ASSISTANT_VERB.pendingRelays);
  assert.equal(pull?.args[ASSISTANT_SESSION_ID_ARG], 'sess-1');
});

test('a failed relay pull (older daemon) attaches nothing and does not fail the tool', async () => {
  const tools = resolveAssistantModeTools();
  const transport = fakeTransport((type) => {
    if (type === ASSISTANT_VERB.pendingRelays) throw new Error('Unknown command: assistant_pending_relays');
    return { success: true, result: 'ok' };
  });
  const res = await handleAssistantToolCall(transport, tools, 'sess', 'skill_view', MINIMAL_ARGS.skill_view);
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(res.content[0].text), { success: true, result: 'ok' });
});

// ─── CLI flag ──────────────────────────────────────────────────────────────

test('--assistant selects assistant mode and drops an env-inherited meshId', () => {
  const parsed = parseArgs(['node', 'idx', '--mode', 'ipc', '--assistant'], { ADHDEV_MESH_ID: 'mesh_abc' } as NodeJS.ProcessEnv);
  assert.equal(parsed.assistant, true);
  assert.equal(parsed.mode, 'ipc');
  assert.equal(parsed.meshId, undefined);
  assert.equal(parsed.worker, undefined);
});

test('--worker wins over --assistant', () => {
  const parsed = parseArgs(['node', 'idx', '--assistant', '--worker'], EMPTY_ENV);
  assert.equal(parsed.worker, true);
  assert.equal(parsed.assistant, undefined);
});

test('--assistant with --repo-mesh is refused (index.ts exits 1)', () => {
  assert.throws(() => parseArgs(['node', 'idx', '--assistant', '--repo-mesh', 'mesh_abc'], EMPTY_ENV), McpCliArgsError);
  assert.throws(() => parseArgs(['node', 'idx', '--repo-mesh=mesh_abc', '--assistant'], EMPTY_ENV), /--assistant cannot be combined with --repo-mesh/);
});

test('help text lists the assistant tools from the contract tuple', () => {
  const line = buildMcpHelpText().split('\n').find(l => l.startsWith('Assistant tools:'));
  assert.ok(line, 'help text must carry an Assistant tools line');
  assert.equal(line!.replace(/^Assistant tools:\s*/, ''), ASSISTANT_TOOLS.join(', '));
});
