import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionHostServer } from '../src/server.js';

test('bounded census never clones or transfers prompts, logs or large inactive inventories', async () => {
  const server = new SessionHostServer({ appName: `adhdev-test-census-${process.pid}` });
  const registry = (server as any).registry;
  const prompt = 'prompt'.repeat(200_000);
  for (let i = 0; i < 2000; i++) {
    registry.createSession({ sessionId: `session-${i}`, providerType: 'claude-cli', category: 'cli', workspace: '/tmp/fixture',
      launchCommand: { command: 'fixture', args: [prompt] }, meta: { prompt: 'secret prompt' } });
    if (i > 0) registry.markStopped(`session-${i}`, 'stopped');
  }
  registry.listSessions = () => { throw new Error('full inventory must not be read'); };
  registry.getSession = () => { throw new Error('full record must not be cloned'); };
  const result = await server.handleRequest({ type: 'get_session_census', payload: { sessionIds: ['session-0', 'session-1', 'absent'] } });
  assert.equal(result.success, true);
  assert.deepEqual((result.result as any).liveSessionIds, ['session-0']);
  assert.ok((result.result as any).hostStartedAt > 0);
  assert.equal((result.result as any).hasOtherAssistantCandidates, false);
  assert.ok(JSON.stringify(result).length < 1024);
  assert.doesNotMatch(JSON.stringify(result), /prompt|recentLogs|launchCommand|meta/);
  registry.createSession({ sessionId: 'new-assistant', providerType: 'claude-cli', category: 'cli', workspace: '/tmp/fixture',
    launchCommand: { command: 'fixture', args: [prompt] }, meta: { launchRecord: { launchedBy: 'assistant' } } });
  const raced = await server.handleRequest({ type: 'get_session_census', payload: { sessionIds: ['absent'] } });
  assert.equal((raced.result as any).hasOtherAssistantCandidates, true);
  assert.deepEqual((raced.result as any).liveSessionIds, []);
  const oversized = await server.handleRequest({ type: 'get_session_census', payload: { sessionIds: Array(129).fill('session-0') } });
  assert.equal(oversized.success, false);
  const malformed = await server.handleRequest({ type: 'get_session_census', payload: { sessionIds: ['x'.repeat(257)] } });
  assert.equal(malformed.success, false);
});
