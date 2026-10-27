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
  // (Since the owner-auth refactor — 79a8bb99f "trusted owner ingress" and the
  // follow-ups that added `opts` — executeCommand also takes an options bag and
  // owner authority additionally requires `ownerVerified === true`.)
  assert.match(text, /private async executeCommand\(\s*type: string,\s*args: any,\s*source: 'standalone' \| 'ipc',\s*opts\?: \{/)
  assert.match(text, /return this\.host\.execute\(type, args, source, \{/)
  assert.doesNotMatch(text, /this\.host\.execute\(type, args, '(standalone|ipc)'/)
  // A 'standalone' source alone is not owner authority: the trusted ingress proof
  // is only minted when BOTH the source is 'standalone' AND the caller verified.
  assert.match(text, /const isOwner = source === 'standalone' && opts\?\.ownerVerified === true/)
  assert.match(text, /const ownerProof = isOwner\s*\?\s*\(opts\?\.ownerProof \?\? issueTrustedOwnerIngressProof\(\{[\s\S]*?\}\)\)\s*:\s*null/)
  // WS upgrade: the connection source is derived from a captured owner-auth guard
  // (null for unauthenticated / MCP-credentialed / internal-scope callers).
  assert.match(text, /const ownerGuard = this\.http\.captureOwnerAuthGuard\(req, req\.url \|\| '\/'\);/)
  assert.match(text, /this\.handleWsConnection\(\s*ws,\s*ownerGuard \? 'standalone' : 'ipc',\s*ownerGuard \?\? undefined,/)
  // WS per-message: authority is re-evaluated LIVE on every command (logout /
  // password change / token removal revokes an open socket), only a
  // 'standalone' connection can hold the captured guard, and the effective
  // source is minted from the live result, never from the upgrade-time source.
  assert.match(text, /const ownerGuard = source === 'standalone'\s*&& typeof isOwnerAuthorized === 'function'\s*&& isOwnerAuthorized\(\)\s*\? isOwnerAuthorized\s*:\s*captureReadGuard\?\.\(type\) \?\? undefined/)
  assert.match(text, /const liveOwnerAuthorized = Boolean\(ownerGuard && ownerGuard\(\)\)/)
  assert.match(text, /const effectiveSource: 'standalone' \| 'ipc' = liveOwnerAuthorized \? 'standalone' : 'ipc'/)
  assert.match(text, /ownerVerified: liveOwnerAuthorized,\s*verifyCurrentOwner: liveOwnerAuthorized \? ownerGuard : undefined/)
  const http = httpSource()
  // Owner authority never extends to MCP-credentialed or internal-scope callers.
  assert.match(http, /isOwnerRequestAuthenticated\(req: IncomingMessage, rawUrl: string\): boolean \{\s*return this\.hasAnyAuth\(\)\s*&& !this\.hasMcpCredentialHeader\(req\)\s*&& !this\.resolveInternalAuthScope\(req\)\s*&& this\.isRequestAuthenticated\(req, rawUrl\);/)
  // Owner-reachable HTTP entries that mint a source from auth directly (provider
  // REST + interactive prompt API). Asserted by count, not "at least one", so a
  // single site regressing to a literal cannot hide behind its siblings.
  const httpDirectOwnerEntries = http.match(/this\.isOwnerRequestAuthenticated\(req, url\) \? 'standalone' : 'ipc'/g) || []
  assert.equal(httpDirectOwnerEntries.length, 2, `expected both direct-auth HTTP entries to derive source from owner auth, saw ${httpDirectOwnerEntries.length}`)
  assert.match(http, /await this\.deps\.executeCommand\(cmdType, body, this\.isOwnerRequestAuthenticated\(req, url\) \? 'standalone' : 'ipc'\)/)
  assert.match(http, /commandSource: this\.isOwnerRequestAuthenticated\(req, url\) \? 'standalone' : 'ipc'/)
  // /api/v1/command: guard is null for MCP-header / internal-scope callers, the
  // owner flag is the LIVE guard result, and the source derives from it.
  assert.match(http, /const ownerGuard = internalScope === null && !hasMcpHeader\s*\?\s*\(this\.captureOwnerAuthGuard\(req, url\) \?\? this\.captureUnauthenticatedArtifactReadGuard\(req, type\)\)\s*:\s*null/)
  assert.match(http, /const isOwner = Boolean\(ownerGuard && ownerGuard\(\)\)/)
  const cmdEntries = http.match(/this\.deps\.executeCommand\(\s*type,\s*commandPayload,\s*isOwner \? 'standalone' : 'ipc',\s*\{[^}]*?verifyCurrentOwner: ownerGuard \?\? undefined/g) || []
  assert.equal(cmdEntries.length, 1, `expected the /api/v1/command entry to derive source from the live owner guard, saw ${cmdEntries.length}`)
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
