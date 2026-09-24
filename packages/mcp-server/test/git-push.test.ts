import assert from 'node:assert/strict';
import test from 'node:test';

import { gitPush } from '../src/tools/git-push.js';

// The tool description promises "If the branch has no upstream configured,
// sets it automatically" — but the daemon (git-commands.ts git_push case) only
// honors that when the caller sends `setUpstream: true`; without it, the daemon
// only retries with --set-upstream AFTER a plain push fails for lack of
// upstream, so a first push naming an explicit remote+branch succeeded with no
// tracking branch set up at all. This pins that the tool always sends the flag.

function fakeTransport(reply: any, capture?: { last?: any }) {
  return {
    async command(_type: string, args: any) {
      if (capture) capture.last = args;
      return reply;
    },
    async ping() { return true; },
  } as any;
}

test('git_push always sends setUpstream:true, even on a first push naming remote+branch', async () => {
  const capture: { last?: any } = {};
  await gitPush(
    fakeTransport({ success: true, branch: 'feature/x', remote: 'origin', newBranch: true }, capture),
    { workspace: '/tmp/repo', remote: 'origin', branch: 'feature/x' },
  );
  assert.equal(capture.last.workspace, '/tmp/repo');
  assert.equal(capture.last.remote, 'origin');
  assert.equal(capture.last.branch, 'feature/x');
  assert.equal(capture.last.setUpstream, true);
});

test('git_push defaults remote to origin and still sends setUpstream:true', async () => {
  const capture: { last?: any } = {};
  await gitPush(fakeTransport({ success: true, branch: 'main', remote: 'origin' }, capture), { workspace: '/tmp/repo' });
  assert.equal(capture.last.remote, 'origin');
  assert.equal(capture.last.setUpstream, true);
});

test('git_push surfaces a daemon-reported error', async () => {
  const result = await gitPush(
    fakeTransport({ success: false, error: 'authentication failed' }),
    { workspace: '/tmp/repo' },
  );
  assert.match(result, /Git push error: authentication failed/);
});
