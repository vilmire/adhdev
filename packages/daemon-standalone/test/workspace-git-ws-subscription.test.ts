import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'

// Source-shape guard over the standalone entry. Since wiring-unification B5 the
// topic registry is built by daemon-core's createDaemonHostRuntime (one copy
// for both hosts); standalone supplies only the WS transport.

const standaloneIndexPath = path.resolve(process.cwd(), 'src/index.ts')
const standaloneTransportPath = path.resolve(process.cwd(), 'src/standalone-host-transport.ts')

function source(): string {
  return fs.readFileSync(standaloneIndexPath, 'utf8')
}

function transportSource(): string {
  return fs.readFileSync(standaloneTransportPath, 'utf8')
}

test('standalone websocket serves workspace.git through the host runtime topic registry', () => {
  const text = source()

  // The engine (normalize/throttle/seq/refresh-concurrency) and its git monitor
  // are core-owned (createDaemonHostRuntime); standalone keeps only the WS sink.
  assert.match(text, /createDaemonHostRuntime\(this\.runtime, createStandaloneHostTransport\(\{/)
  assert.doesNotMatch(text, /new TopicSubscriptionRegistry\(/)
  assert.doesNotMatch(text, /createGitWorkspaceMonitor\(/)
  assert.match(text, /if \(topics\?\.handlesTopic\(msg\.topic\)\)/)
  assert.match(text, /topics\.subscribe\(connectionId, msg\)/)
  // Targeted first flush right after subscribe, scoped to the new connection.
  assert.match(text, /await topics\.flushNow\(msg\.topic, connectionId\)/)
  // The WS transport framing stays standalone's.
  assert.match(transportSource(), /ws\.send\(JSON\.stringify\(\{ type: 'topic_update', update \}\)\)/)
  // The old daemon-local engine must stay deleted.
  assert.doesNotMatch(text, /flushWsGitSubscriptions/)
  assert.doesNotMatch(text, /interface GitSubscriptionState/)
})

test('standalone workspace.git subscriptions are dropped on cleanup and unsubscribe', () => {
  const text = source()

  // Connection teardown (close AND error) releases registry-owned state.
  assert.match(text, /private releaseWsConnection\(ws: WebSocket\): void/)
  assert.match(text, /this\.host\?\.topics\.dropConnection\(id\)/)
  const releaseCalls = text.match(/this\.releaseWsConnection\(ws\)/g) || []
  assert.ok(releaseCalls.length >= 2, `expected releaseWsConnection wired on close and error handlers, saw ${releaseCalls.length}`)
  // Explicit unsubscribe routes into the registry.
  assert.match(text, /if \(topics\?\.handlesTopic\(msg\.topic\)\) \{[\s\S]*?topics\.unsubscribe\(connectionId, msg\)/)
})

test('standalone push-topic flushes only run while subscribers exist', () => {
  const text = source()

  assert.match(text, /if \(topics\?\.hasSubscriptions\(topic\)\) void topics\.flushNow\(topic\)/)
  assert.match(text, /this\.flushTopic\('workspace\.git'\)/)
})

test('standalone command invalidation rides the router command_executed event, not a host table', () => {
  const text = source()

  // Which commands invalidate which topics is the command spec's `invalidates`
  // (daemon-core command registry); the router emits `command_executed` for
  // EVERY caller and the host runtime runs the topic invalidation. Standalone
  // adds only its legacy `type:'status'` push.
  assert.doesNotMatch(text, /commandInvalidations/)
  assert.doesNotMatch(text, /SESSION_TARGET_COMMANDS/)
  assert.doesNotMatch(text, /ensureInteractionContext/)
  assert.doesNotMatch(text, /recentInteractionIdsBySession/)
  assert.match(transportSource(), /onCommandExecuted: \(e\) => \{[\s\S]*?e\.invalidates\.has\('daemon\.metadata'\)[\s\S]*?deps\.scheduleBroadcastStatus\(\)/)
  assert.match(text, /return this\.host\.execute\(type, args, 'standalone'\)/)
  // The old local predicate must stay deleted (it diverged from cloud once already).
  assert.doesNotMatch(text, /function commandMayAffectMeshGraphStatus/)
  assert.doesNotMatch(text, /flushWsDaemonMetadataSubscriptions/)
  assert.doesNotMatch(text, /flushWsSessionModalSubscriptions/)
})
