// Synthetic native JSON-RPC peer. No Codex binary, credentials, history, or owner runtime.
import { createInterface } from 'node:readline';
const threadId = '11111111-1111-4111-8111-111111111111';
let turnId = '';
let count = 0;
const received = [];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => emit({ method, params: method === 'item/completed' ? { completedAtMs: Date.now(), ...params } : params });
const result = (id, value) => emit({ id, result: value });
const question = (isBlocking = true) => emit({ id: 'request-1', method: 'item/tool/requestUserInput', params: {
  threadId, turnId, itemId: 'call-1', isBlocking, autoResolutionMs: null,
  questions: [
    { id: 'track', header: 'Track', question: 'Choose a sample track', isOther: true, isSecret: false,
      options: [{ label: 'Alpha', description: 'First synthetic track' }, { label: 'Beta', description: 'Second synthetic track' }] },
    { id: 'note', header: 'Note', question: 'Enter a sample note', isOther: false, isSecret: false, options: null },
  ],
} });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) {
    received.push(message);
    event('serverRequest/resolved', { threadId, requestId: message.id });
    event('item/completed', { threadId, turnId, item: { id: 'output-1', type: 'functionCallOutput', name: 'request_user_input', namespace: null, output: 'Synthetic question resolved' } });
    return;
  }
  switch (message.method) {
    case 'initialize': received.push({ method: message.method, params: message.params }); result(message.id, {}); break;
    case 'initialized': break;
    case 'thread/start': result(message.id, { thread: { id: threadId, turns: [] } }); break;
    case 'turn/start': {
      turnId = `turn-${++count}`;
      event('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      result(message.id, { turn: { id: turnId } });
      const text = message.params.input[0].text;
      event('item/completed', { threadId, turnId, item: { id: `user-${count}`, type: 'userMessage', content: message.params.input } });
      if (text === 'rpc') question();
      else if (text === 'async') event('item/completed', { threadId, turnId, item: { id: 'async-1', type: 'agentMessage', text: 'Synthetic async bundle', delivery: 'async', questions: [{ title: 'Choose a color', options: ['Blue', 'Green'] }, { title: 'Enter a label', options: null }] } });
      else if (text === 'permission') emit({ id: 'permission-1', method: 'item/permissions/requestApproval', params: { threadId, turnId, itemId: 'permission-item', permissions: { network: { enabled: true } } } });
      else if (text === 'complete-immediately') event('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
      break;
    }
    case 'turn/steer':
      if (message.params.expectedTurnId !== turnId) emit({ id: message.id, error: { code: -32600, message: 'Active turn mismatch' } });
      else {
        received.push({ method: message.method, params: message.params });
        event('item/completed', { threadId, turnId, item: { id: `reply-${received.length}`, type: 'userMessage', content: message.params.input } });
        result(message.id, { turnId });
      }
      break;
    case 'turn/interrupt':
      event('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', items: [] } });
      turnId = ''; result(message.id, {}); break;
    case 'thread/turns/list': result(message.id, { data: [{ id: 'historical-turn', items: [{ id: 'historic', type: 'agentMessage', text: 'Synthetic history page' }] }], nextCursor: null }); break;
    case 'test/emit': emit(message.params); result(message.id, {}); break;
    case 'test/replay': question(); result(message.id, {}); break;
    case 'test/nonblocking': question(false); result(message.id, {}); break;
    case 'test/observations': result(message.id, received); break;
    case 'test/terminalSkip': result(message.id, {}); break; // Native TUI skip emits no protocol event.
    case 'test/death': process.exit(0); break;
    case 'test/malformedOutput': process.stdout.write('invalid protocol\n'); break;
    default: emit({ id: message.id, error: { code: -32601, message: 'Unknown synthetic method' } });
  }
});
