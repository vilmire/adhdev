/**
 * Contract versioning (Cut A) — the MCP surface.
 *   - worker tools forward only the daemon-minted credential + the exact args (no task id)
 *     and render daemon refusals as content-free codes;
 *   - `mesh_contract` is published only with a contract capability, which it forwards
 *     to the daemon but never echoes;
 *   - `mesh_send_task` refuses a strict-bound mission (pins need the queue claim path).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { contractReadTool, contractObserveTool, contractCurrentTool, CONTRACT_READ_TOOL, CONTRACT_OBSERVE_TOOL, CONTRACT_CURRENT_TOOL } from '../src/tools/worker-tools.js';
import { MESH_CONTRACT_TOOL, meshContract, readContractCapability, CONTRACT_CAPABILITY_ENV } from '../src/tools/mesh-contract-tool.js';
import { meshSendTask } from '../src/tools/mesh-tools.js';
import { upsertMeshMission, getQueue } from '@adhdev/daemon-core';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

function recorder(answer: (verb: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ verb: string; args: Record<string, unknown> }> = [];
  return { calls, transport: { command: async (verb: string, args: Record<string, unknown> = {}) => { calls.push({ verb, args }); return answer(verb, args); } } as any };
}

test('contract worker tools take no task/attempt/session id', () => {
  for (const tool of [CONTRACT_READ_TOOL, CONTRACT_OBSERVE_TOOL, CONTRACT_CURRENT_TOOL]) {
    const props = Object.keys((tool.inputSchema as any).properties ?? {});
    for (const forbidden of ['task_id', 'taskId', 'attempt_id', 'session_id', 'generation']) assert.ok(!props.includes(forbidden), `${tool.name} ${forbidden}`);
  }
});

test('contract_read forwards the credential and exact range; content is framed, refusal is a code', async () => {
  const ok = recorder(() => ({ success: true, unitId: 'api', revisionId: 'rev_x', unitDigest: 'd'.repeat(64), unitLength: 3, rangeStart: 0, rangeEnd: 3, encoding: 'utf8', content: 'abc', fullCoverage: true }));
  const r = await contractReadTool(ok.transport, { bind: 'wsb_x' }, { binding_id: ' bnd_1 ', unit_id: 'api', range_start: 0, range_end: 3 });
  assert.deepEqual(ok.calls, [{ verb: 'worker_contract_read', args: { bind: 'wsb_x', bindingId: 'bnd_1', unitId: 'api', rangeStart: 0, rangeEnd: 3 } }]);
  assert.match(r.text, /full_coverage=true/);
  assert.match(r.text, /BEGIN CONTRACT UNIT BYTES -----\nabc\n-----/);
  const no = recorder(() => ({ success: false, code: 'binding_not_active', error: 'binding_not_active' }));
  const refused = await contractReadTool(no.transport, { token: 'wtk_y' }, { binding_id: 'b', unit_id: 'api' });
  assert.equal(refused.isError, true);
  assert.equal(refused.text, 'contract_read refused (binding_not_active).');
});

test('contract_observe is a claim; contract_current reports unscoped tasks plainly', async () => {
  const ok = recorder((verb) => verb === 'worker_contract_observe' ? { success: true, claimId: 'clm_1' } : { success: true, scoped: false, notices: [] });
  const o = await contractObserveTool(ok.transport, { bind: 'wsb_x' }, { binding_id: 'bnd_1', units: [{ unit_id: 'api', unit_digest: 'd' }] });
  assert.match(o.text, /claim clm_1/);
  assert.match(o.text, /not a proof/);
  assert.deepEqual(ok.calls[0].args, { bind: 'wsb_x', bindingId: 'bnd_1', units: [{ unitId: 'api', unitDigest: 'd' }] });
  const c = await contractCurrentTool(ok.transport, { bind: 'wsb_x' });
  assert.equal(c.text, 'This task is not pinned to any contract.');
});

test('mesh_contract: only a csb_ capability enables it; the capability is forwarded, never echoed', async () => {
  assert.equal(readContractCapability({} as NodeJS.ProcessEnv), null);
  assert.equal(readContractCapability({ [CONTRACT_CAPABILITY_ENV]: 'not-a-capability' } as NodeJS.ProcessEnv), null);
  assert.equal(readContractCapability({ [CONTRACT_CAPABILITY_ENV]: ' csb_abc ' } as NodeJS.ProcessEnv), 'csb_abc');
  assert.deepEqual((MESH_CONTRACT_TOOL.inputSchema as any).required, ['action', 'namespace_id']);
  const prev = process.env[CONTRACT_CAPABILITY_ENV];
  process.env[CONTRACT_CAPABILITY_ENV] = 'csb_SECRETCANARY0000000000';
  try {
    const rec = recorder(() => ({ success: false, code: 'scope_mismatch', error: 'scope_mismatch' }));
    const out = await meshContract({ transport: rec.transport, mesh: { id: 'm1' }, coordinatorSessionId: 'coord-1' } as any, { action: 'status', namespace_id: 'ns_1' });
    assert.equal(rec.calls[0].verb, 'contract_coordinator');
    assert.equal(rec.calls[0].args.capability, 'csb_SECRETCANARY0000000000');
    assert.equal(rec.calls[0].args.coordinatorSessionId, 'coord-1');
    assert.ok(!out.includes('SECRETCANARY'));
  } finally {
    if (prev === undefined) delete process.env[CONTRACT_CAPABILITY_ENV]; else process.env[CONTRACT_CAPABILITY_ENV] = prev;
  }
});

test('mesh_send_task refuses a strict-bound mission before anything is dispatched', async () => {
  const meshId = `mesh_contract_send_${randomUUID().slice(0, 8)}`;
  const mission = upsertMeshMission(meshId, { title: 'pilot' });
  const ctx = {
    mesh: { id: meshId, nodes: [{ id: 'node_a', workspace: '/repo/a', daemonId: 'daemon_a' }], policy: {} },
    localDaemonId: 'daemon_a',
    transport: {
      command: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'contract_mission_scope') return { success: true, strict: args.missionId === mission.id };
        if (isTurnIpcCommand(cmd)) return answerTurnIpc(cmd, args);
        return { success: true };
      },
      getStatus: async () => ({ sessions: [] }),
    },
  } as any;
  const res = JSON.parse(await meshSendTask(ctx, { node_id: 'node_a', session_id: 'sess_1', message: 'do it', difficulty: 'easy', mission_id: mission.id } as any));
  assert.equal(res.success, false);
  assert.equal(res.code, 'contract_strict_requires_queue');
  assert.equal(getQueue(meshId).length, 0);
});
