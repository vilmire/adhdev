import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'

const standaloneIndexPath = path.resolve(process.cwd(), 'src/index.ts')

function source(): string {
  return fs.readFileSync(standaloneIndexPath, 'utf8')
}

test('standalone websocket serves workspace.git through the core topic registry engine', () => {
  const text = source()

  // The engine (normalize/throttle/seq/refresh-concurrency) is core-owned
  // (daemon-core TopicSubscriptionRegistry); standalone keeps only the WS sink.
  assert.match(text, /createGitWorkspaceMonitor/)
  assert.match(text, /TopicSubscriptionRegistry,/)
  assert.match(text, /new TopicSubscriptionRegistry\(\{/)
  assert.match(text, /gitMonitor: this\.gitWorkspaceMonitor/)
  assert.match(text, /if \(this\.topicRegistry\.handlesTopic\(msg\.topic\)\)/)
  assert.match(text, /this\.topicRegistry\.subscribe\(connectionId, msg\)/)
  // Targeted first flush right after subscribe, scoped to the new connection.
  assert.match(text, /await this\.topicRegistry\.flushNow\(msg\.topic, connectionId\)/)
  // The WS transport framing stays standalone's.
  assert.match(text, /ws\.send\(JSON\.stringify\(\{ type: 'topic_update', update \}\)\)/)
  // The old daemon-local engine must stay deleted.
  assert.doesNotMatch(text, /flushWsGitSubscriptions/)
  assert.doesNotMatch(text, /interface GitSubscriptionState/)
})

test('standalone workspace.git subscriptions are dropped on cleanup and unsubscribe', () => {
  const text = source()

  // Connection teardown (close AND error) releases registry-owned state.
  assert.match(text, /private releaseWsConnection\(ws: WebSocket\): void/)
  assert.match(text, /this\.topicRegistry\.dropConnection\(id\)/)
  const releaseCalls = text.match(/this\.releaseWsConnection\(ws\)/g) || []
  assert.ok(releaseCalls.length >= 2, `expected releaseWsConnection wired on close and error handlers, saw ${releaseCalls.length}`)
  // Explicit unsubscribe routes into the registry.
  assert.match(text, /if \(this\.topicRegistry\.handlesTopic\(msg\.topic\)\) \{[\s\S]*?this\.topicRegistry\.unsubscribe\(connectionId, msg\)/)
})

test('standalone workspace.git subscriptions only flush while subscribers exist', () => {
  const text = source()

  assert.match(text, /if \(this\.topicRegistry\.hasSubscriptions\('workspace\.git'\)\) void this\.topicRegistry\.flushNow\('workspace\.git'\)/)
})

test('standalone command flush gate consumes the core-owned invalidation table', () => {
  const text = source()

  // Which commands invalidate which topics is core-owned (daemon-core
  // commandInvalidations) — standalone must not re-hardcode the list.
  assert.match(text, /commandInvalidations,/)
  assert.match(text, /const invalidated = commandInvalidations\(type\)/)
  // Metadata topic flush now rides the registry's invalidate consumption; only
  // the standalone-specific legacy `type:'status'` broadcast stays local.
  assert.match(text, /invalidated\.has\('daemon\.metadata'\)\) \{[\s\S]*?this\.scheduleBroadcastStatus\(\)/)
  assert.doesNotMatch(text, /flushWsDaemonMetadataSubscriptions/)
  // session.modal / session_host.diagnostics invalidation flushes now ride the
  // registry's invalidate consumption — no daemon-local flush branches remain.
  assert.doesNotMatch(text, /flushWsSessionModalSubscriptions/)
  assert.doesNotMatch(text, /flushWsSessionHostDiagnosticsSubscriptions/)
  assert.doesNotMatch(text, /flushWsMachineRuntimeSubscriptions/)
  // Registry-migrated cohorts (workspace.git) consume the set via the registry.
  assert.match(text, /void this\.topicRegistry\.invalidate\(invalidated\)/)
  // The old local predicate must stay deleted (it diverged from cloud once already).
  assert.doesNotMatch(text, /function commandMayAffectMeshGraphStatus/)
})
