import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'

// Source-shape guard over the standalone entry. Since wiring-unification B5 the
// topic registry is built by daemon-core's createDaemonHostRuntime (one copy
// for both hosts); standalone supplies only the WS transport.

const standaloneIndexPath = path.resolve(process.cwd(), 'src/index.ts')
const standaloneTransportPath = path.resolve(process.cwd(), 'src/standalone-host-transport.ts')
const standaloneHttpPath = path.resolve(process.cwd(), 'src/standalone-http.ts')

function source(): string {
  return fs.readFileSync(standaloneIndexPath, 'utf8')
}

function transportSource(): string {
  return fs.readFileSync(standaloneTransportPath, 'utf8')
}

function httpSource(): string {
  return fs.readFileSync(standaloneHttpPath, 'utf8')
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
  // Targeted first flush right after subscribe, scoped to the new subscription.
  assert.match(text, /await topics\.flushNow\(msg\.topic, connectionId, msg\.key\)/)
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
  // P-II-1 (wiring-unification): the 2s status/topic flush interval is gone —
  // workspace.git is flushed by the host runtime on its bus edge (the router's
  // command_executed invalidation), not polled by the host.
  assert.doesNotMatch(text, /STATUS_INTERVAL|statusTimer/)
  assert.doesNotMatch(text, /this\.flushTopic\('workspace\.git'\)/)
})

test('standalone command invalidation rides the router command_executed event, not a host table', () => {
  const text = source()

  // Which commands invalidate which topics is the command spec's `invalidates`
  // (daemon-core command registry); the router emits `command_executed` for
  // EVERY caller and the host runtime runs the topic invalidation. Standalone
  // adds only the fast-flush daemon.metadata push (the legacy `type:'status'`
  // push is gone — data-path audit 2026-09-29 P0-3).
  assert.doesNotMatch(text, /commandInvalidations/)
  assert.doesNotMatch(text, /SESSION_TARGET_COMMANDS/)
  assert.doesNotMatch(text, /ensureInteractionContext/)
  assert.doesNotMatch(text, /recentInteractionIdsBySession/)
  assert.match(transportSource(), /onCommandExecuted: \(e\) => \{[\s\S]*?e\.fastFlush && e\.success[\s\S]*?deps\.flushTopic\('daemon\.metadata'\)/)
  assert.doesNotMatch(transportSource(), /scheduleBroadcastStatus/)
  assert.doesNotMatch(text, /type: 'status', data/)
  // Command entry forwards the caller's routing source into the host runtime
  // instead of stamping a constant. The source is NOT cosmetic: it is derived
  // from owner authentication (`'standalone'` when the request authenticates as
  // the owner, `'ipc'` otherwise), so a hard-coded literal here would silently
  // promote unauthenticated callers to owner-sourced commands.
  assert.match(text, /private async executeCommand\(type: string, args: any, source: 'standalone' \| 'ipc'\)/)
  assert.match(text, /return this\.host\.execute\(type, args, source\)/)
  assert.doesNotMatch(text, /this\.host\.execute\(type, args, '(standalone|ipc)'\)/)
  // Both entries that mint the source derive it from owner authentication.
  assert.match(text, /this\.handleWsConnection\(ws, this\.http\.isOwnerRequestAuthenticated\(req, req\.url \|\| '\/'\) \? 'standalone' : 'ipc'\)/)
  // Every owner-reachable HTTP command entry must derive its source from
  // authentication. Asserted by count, not by "at least one match", so a single
  // site regressing to a literal cannot hide behind its siblings.
  const http = httpSource()
  const httpOwnerEntries = http.match(/this\.deps\.executeCommand\([^;]*?this\.isOwnerRequestAuthenticated\(req, url\) \? 'standalone' : 'ipc'\)/g) || []
  assert.equal(httpOwnerEntries.length, 2, `expected both owner-reachable HTTP command entries to derive source from owner auth, saw ${httpOwnerEntries.length}`)
  // No owner-reachable entry may stamp 'standalone' directly. The lone literal
  // 'ipc' call (apply_mesh_host_join) is the unauthenticated mesh-join path and
  // is deliberately the LEAST privileged source, so it is exempt.
  assert.doesNotMatch(http, /this\.deps\.executeCommand\([^;]*?,\s*'standalone'\)/)
  // The mesh relay is the one legitimate re-entry: it must carry the caller's
  // source through to the local execute rather than re-deriving or widening it.
  assert.match(text, /if \(type === MESH_RELAY_COMMAND\) return this\.relayMeshCommand\(args, source\)/)
  assert.match(text, /executeLocal: \(command, args\) => host\.execute\(command, args, source\)/)
  // The old local predicate must stay deleted (it diverged from cloud once already).
  assert.doesNotMatch(text, /function commandMayAffectMeshGraphStatus/)
  assert.doesNotMatch(text, /flushWsDaemonMetadataSubscriptions/)
  assert.doesNotMatch(text, /flushWsSessionModalSubscriptions/)
})
