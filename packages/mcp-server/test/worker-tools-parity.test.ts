/**
 * F1 parity gate: worker mode advertises exactly `WORKER_TOOLS`
 * (@adhdev/mesh-shared), in that order.
 *
 * The tuple is the contract both halves of the worker protocol are rendered
 * from — the footer every dispatched task carries and the coordinator prompt's
 * Workers section. If the published schemas drift from it, a worker is told
 * about a tool it cannot call (or holds one it was never told about) and the
 * adoption measurement in F6 becomes meaningless.
 *
 * Reliability note: this file imports only mcp-server src and @adhdev/mesh-shared
 * (built dist); it does not touch the daemon-core dist, so it is not affected by
 * daemon-core src edits that have not been rebuilt.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKER_TOOLS, isWorkerTool } from '@adhdev/mesh-shared';

import { ALL_WORKER_TOOLS, WORKER_GIT_TOOLS, resolveWorkerModeTools } from '../src/tools/worker-tools.js';
import { GIT_STATUS_TOOL } from '../src/tools/git-status.js';
import { GIT_LOG_TOOL } from '../src/tools/git-log.js';
import { GIT_DIFF_TOOL } from '../src/tools/git-diff.js';
import { buildMcpHelpText } from '../src/help.js';

test('ALL_WORKER_TOOLS ∪ {git_status, git_log, git_diff} equals WORKER_TOOLS exactly', () => {
  const published = new Set<string>([
    ...ALL_WORKER_TOOLS.map(t => t.name),
    GIT_STATUS_TOOL.name,
    GIT_LOG_TOOL.name,
    GIT_DIFF_TOOL.name,
  ]);
  const contract = new Set<string>(WORKER_TOOLS);
  assert.deepEqual([...published].sort(), [...contract].sort());
  // The git trio published by worker mode is the same trio the parity set names.
  assert.deepEqual(WORKER_GIT_TOOLS.map(t => t.name).sort(), ['git_diff', 'git_log', 'git_status']);
});

test('resolveWorkerModeTools publishes WORKER_TOOLS in tuple order, every entry annotated', () => {
  const tools = resolveWorkerModeTools();
  assert.deepEqual(tools.map(t => t.name), [...WORKER_TOOLS]);
  for (const tool of tools) {
    assert.ok(isWorkerTool(tool.name), `${tool.name} must be a WorkerTool`);
    assert.ok(tool.annotations, `${tool.name} must carry behavior annotations`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('a schema that is not in WORKER_TOOLS fails the startup assertion', () => {
  const bogus = { ...ALL_WORKER_TOOLS[0], name: 'bogus_worker_tool' };
  assert.throws(
    () => resolveWorkerModeTools([...ALL_WORKER_TOOLS, ...WORKER_GIT_TOOLS, bogus]),
    /schema not in WORKER_TOOLS \[bogus_worker_tool\]/,
  );
});

test('a WORKER_TOOLS entry with no schema fails the startup assertion', () => {
  const withoutReport = [...ALL_WORKER_TOOLS, ...WORKER_GIT_TOOLS].filter(t => t.name !== 'report_completion');
  assert.throws(
    () => resolveWorkerModeTools(withoutReport),
    /missing schema for \[report_completion\]/,
  );
});

test('a duplicated schema fails the startup assertion', () => {
  assert.throws(
    () => resolveWorkerModeTools([...ALL_WORKER_TOOLS, ...WORKER_GIT_TOOLS, ALL_WORKER_TOOLS[1]]),
    /defined twice/,
  );
});

test('help text lists the worker tools from the contract tuple', () => {
  const help = buildMcpHelpText();
  const line = help.split('\n').find(l => l.startsWith('Worker tools:'));
  assert.ok(line, 'help text must carry a Worker tools line');
  assert.equal(line!.replace(/^Worker tools:\s*/, ''), WORKER_TOOLS.join(', '));
});
