import assert from 'node:assert/strict';
import test from 'node:test';

import { CANONICAL_MESH_TOOL_NAMES } from '@adhdev/daemon-core';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import {
  MESH_TOOL_DISPATCH,
  MESH_ALIAS_DISPATCH,
  resolveMeshToolHandler,
} from '../src/tools/mesh-tool-dispatch.js';

/**
 * PUBLISHED ⇒ DISPATCHABLE.
 *
 * Before the dispatch registry existed, publishing a mesh tool took two
 * unrelated edits — `ALL_MESH_TOOLS` (what ListTools advertises) and a `switch`
 * in server.ts (what CallTool runs) — with nothing tying them together. A tool
 * added to the registry but missed in the switch stayed fully visible to a
 * coordinator and answered `Unknown tool: <name>` when called.
 *
 * Measured before the change (2026-09-18): deleting the `mesh_record_note`
 * (now `mesh_note`) case left `tsc --noEmit` clean and all 786 mcp-server tests green.
 *
 * `MESH_TOOL_DISPATCH` is now a `Record<CanonicalMeshToolName, …>`, so the
 * compiler rejects a missing handler (TS2741) and an unknown key (TS2353).
 * That is the primary gate and it fires before any test runs. These tests
 * cover what types cannot: that the handler wired to each name INVOKES THE
 * MATCHING IMPLEMENTATION, and that the runtime resolver actually reaches it.
 *
 * ★These assert dispatch BEHAVIOUR, never a count. A test that only compared
 * `Object.keys(...).length` to `ALL_MESH_TOOLS.length` would pass on a table
 * where every tool routed to the wrong handler.
 */

test('every published mesh tool resolves to a handler (no published-but-undispatchable tool)', () => {
  const unroutable = ALL_MESH_TOOLS
    .map(tool => tool.name)
    .filter(name => resolveMeshToolHandler(name) === undefined);
  // Named, not counted: a failure has to say WHICH tool a coordinator could
  // call and get "Unknown tool" for.
  assert.deepEqual(unroutable, [], `published tools with no dispatch handler: ${unroutable.join(', ')}`);
});

test('the canonical registry and the dispatch table cover exactly the same names', () => {
  assert.deepEqual(
    Object.keys(MESH_TOOL_DISPATCH).sort(),
    [...CANONICAL_MESH_TOOL_NAMES].sort(),
  );
});

test('aliases stay dispatchable but are NOT published', () => {
  const published = new Set(ALL_MESH_TOOLS.map(tool => tool.name));
  for (const alias of Object.keys(MESH_ALIAS_DISPATCH)) {
    // The alias contract: callable for pre-consolidation callers, invisible in
    // ListTools so it cannot become a second public surface.
    assert.equal(published.has(alias), false, `${alias} must not be published`);
    assert.equal(typeof resolveMeshToolHandler(alias), 'function', `${alias} must stay dispatchable`);
  }
});

test('an unknown tool name resolves to no handler', () => {
  assert.equal(resolveMeshToolHandler('mesh_not_a_real_tool'), undefined);
  assert.equal(resolveMeshToolHandler(''), undefined);
});

/**
 * ★The behavioural core: each name must reach ITS OWN implementation.
 *
 * Every handler is invoked with a context whose `transport.command` records the
 * call and throws a sentinel, so nothing touches a daemon. Two different tools
 * that mistakenly shared one implementation — the failure a name/handler table
 * is most prone to, and one no type can catch — would produce identical
 * evidence here and be caught by the distinctness assertion below.
 */
test('each tool name dispatches to a distinct, correctly-wired implementation', async () => {
  const CALLS_PER_TOOL = new Map<string, string[]>();

  function contextFor(toolName: string): any {
    const seen: string[] = [];
    CALLS_PER_TOOL.set(toolName, seen);
    const transport = {
      command: async (command: string, _payload?: unknown) => {
        seen.push(command);
        throw new Error('__probe_stop__');
      },
      getStatus: async () => {
        seen.push('get_status');
        throw new Error('__probe_stop__');
      },
      ping: async () => true,
    };
    return {
      transport,
      mesh: { id: 'mesh_probe', name: 'probe', repoIdentity: 'probe', nodes: [] },
      localDaemonId: 'daemon_probe',
      localMachineId: 'mach_probe',
      coordinatorHostname: 'probe-host',
    };
  }

  // A handler either reaches the transport (recording a command name) or fails
  // earlier on its own argument validation. Both prove it ran real code — what
  // must never happen is the resolver handing back nothing at all.
  const ran: string[] = [];
  for (const name of CANONICAL_MESH_TOOL_NAMES) {
    const handler = resolveMeshToolHandler(name);
    assert.equal(typeof handler, 'function', `${name} has no handler`);
    try {
      await handler!(contextFor(name), {});
    } catch {
      // Expected: the sentinel, or the tool's own validation error.
    }
    ran.push(name);
  }
  assert.equal(ran.length, CANONICAL_MESH_TOOL_NAMES.length);

  // Handler identity: no two canonical names may share the same function
  // reference. This is what catches a copy-paste that points two tools at one
  // implementation — the table would still be exhaustive and still typecheck.
  const byRef = new Map<unknown, string[]>();
  for (const [name, handler] of Object.entries(MESH_TOOL_DISPATCH)) {
    const names = byRef.get(handler) ?? [];
    names.push(name);
    byRef.set(handler, names);
  }
  const shared = [...byRef.values()].filter(names => names.length > 1);
  assert.deepEqual(shared, [], `these tools share one handler reference: ${JSON.stringify(shared)}`);
});

/**
 * Regression pin for the exact defect measured above. `mesh_record_note` was the
 * tool whose case deletion was shown to be invisible to both the compiler and the
 * suite; since the 2026-09-26 consolidation it is `mesh_note` action=record.
 */
test('mesh_note (was mesh_record_note — the tool whose silent omission was measured) is dispatchable', () => {
  assert.equal(typeof resolveMeshToolHandler('mesh_note'), 'function');
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_note'), true);
});
