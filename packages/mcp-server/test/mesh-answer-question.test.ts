import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshAnswerQuestion, MESH_ANSWER_QUESTION_TOOL } from '../src/tools/mesh-tools.js';

// mesh_answer_question (mission f1d25e11): the coordinator answers a delegated worker's
// AskUserQuestion (waiting_choice). The MCP handler is a thin forwarder — it maps the tool
// call to the daemon's existing `interactive_prompt_response` command, carrying the promptId +
// friendly answer array. The daemon resolves the option labels/indexes against its authoritative
// active prompt (resolveInteractivePromptResponse); the tool must NOT map to resolve_action
// (that is mesh_approve's yes/no path and cannot answer a question).

function makeCtx() {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command, args = {}) => {
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'interactive_prompt_response') {
      calls.push({ command, args });
      return { success: true };
    }
    if (command === 'resolve_action') { calls.push({ command, args }); return { success: true }; }
    return { success: true };
  };
  transport.meshCommand = async (_daemonId, command, args = {}) => {
    if (command === 'get_status_metadata') return { success: true, result: { status: { sessions: [] } } };
    calls.push({ command, args });
    return { success: true, result: { success: true } };
  };

  const mesh = {
    id: 'mesh-q',
    name: 'Q Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{ id: 'node-mac', workspace: '/repo', repoRoot: '/repo', userOverrides: {}, policy: {} }],
  };
  const ctx = { mesh, transport, localDaemonId: 'daemon-mac' } as any;
  return { ctx, calls };
}

test('mesh_answer_question forwards interactive_prompt_response with promptId + answers (not resolve_action)', async () => {
  const { ctx, calls } = makeCtx();
  const result = JSON.parse(await meshAnswerQuestion(ctx, {
    node_id: 'node-mac',
    session_id: 'sess-1',
    promptId: 'ask-1',
    answers: [{ questionId: 'scope', select: 'broadcast' }],
  }));

  assert.equal(result.success, true, JSON.stringify(result));
  const forwarded = calls.filter(c => c.command === 'interactive_prompt_response');
  assert.equal(forwarded.length, 1, 'interactive_prompt_response issued once');
  // Never the approval path.
  assert.equal(calls.some(c => c.command === 'resolve_action'), false);

  const args = forwarded[0].args as any;
  assert.equal(args.targetSessionId, 'sess-1');
  assert.equal(args.response.promptId, 'ask-1');
  assert.deepEqual(args.response.answers, [{ questionId: 'scope', select: 'broadcast' }]);
});

test('mesh_answer_question rejects a missing promptId / non-array answers before forwarding', async () => {
  const { ctx, calls } = makeCtx();
  const noPrompt = JSON.parse(await meshAnswerQuestion(ctx, {
    node_id: 'node-mac', session_id: 'sess-1', promptId: '', answers: [],
  } as any));
  assert.equal(noPrompt.success, false);

  const badAnswers = JSON.parse(await meshAnswerQuestion(ctx, {
    node_id: 'node-mac', session_id: 'sess-1', promptId: 'ask-1', answers: 'nope',
  } as any));
  assert.equal(badAnswers.success, false);

  assert.equal(calls.some(c => c.command === 'interactive_prompt_response'), false, 'no forward on invalid input');
});

test('MESH_ANSWER_QUESTION_TOOL schema requires node_id, session_id, promptId, answers', () => {
  assert.equal(MESH_ANSWER_QUESTION_TOOL.name, 'mesh_answer_question');
  assert.deepEqual(MESH_ANSWER_QUESTION_TOOL.inputSchema.required, ['node_id', 'session_id', 'promptId', 'answers']);
  assert.equal((MESH_ANSWER_QUESTION_TOOL.inputSchema.properties as any).answers.type, 'array');
});
