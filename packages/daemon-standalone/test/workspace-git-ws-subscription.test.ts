import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'

const standaloneIndexPath = path.resolve(process.cwd(), 'src/index.ts')

function source(): string {
  return fs.readFileSync(standaloneIndexPath, 'utf8')
}

test('standalone websocket exposes workspace.git subscriptions through daemon-core git monitor', () => {
  const text = source()

  assert.match(text, /createGitWorkspaceMonitor/)
  assert.match(text, /normalizeGitWorkspaceSubscriptionParams/)
  assert.match(text, /wsGitSubscriptions = new Map<WebSocket, Map<string, GitSubscriptionState>>\(\)/)
  assert.match(text, /if \(msg\.topic === 'workspace\.git'\)/)
  assert.match(text, /this\.gitWorkspaceMonitor\.createSubscription\(normalized\)/)
  assert.match(text, /await this\.flushWsGitSubscriptions\(ws\)/)
  assert.match(text, /ws\.send\(JSON\.stringify\(\{ type: 'topic_update', update \}\)\)/)
})

test('standalone workspace.git subscriptions are disposed on cleanup and unsubscribe', () => {
  const text = source()

  assert.match(text, /private clearWsGitSubscriptions\(ws: WebSocket\): void/)
  assert.match(text, /sub\.subscription\.dispose\(\)/)
  assert.match(text, /this\.clearWsGitSubscriptions\(ws\)/)
  assert.match(text, /if \(msg\.topic === 'workspace\.git'\) \{[\s\S]*?sub\?\.subscription\.dispose\(\)[\s\S]*?this\.wsGitSubscriptions\.get\(ws\)\?\.delete\(msg\.key\)/)
})

test('standalone workspace.git subscriptions only flush while subscribers exist', () => {
  const text = source()

  assert.match(text, /private hasWsGitSubscriptions\(targetWs\?: WebSocket\): boolean/)
  assert.match(text, /if \(this\.hasWsGitSubscriptions\(\)\) void this\.flushWsGitSubscriptions\(\)/)
  assert.match(text, /if \(!this\.hasWsGitSubscriptions\(targetWs\)\) return/)
})

test('standalone command flush gate consumes the core-owned invalidation table', () => {
  const text = source()

  // Which commands invalidate which topics is core-owned (daemon-core
  // commandInvalidations) — standalone must not re-hardcode the list.
  assert.match(text, /commandInvalidations,/)
  assert.match(text, /const invalidated = commandInvalidations\(type\)/)
  assert.match(text, /invalidated\.has\('daemon\.metadata'\)\) \{[\s\S]*?this\.scheduleBroadcastStatus\(\)[\s\S]*?void this\.flushWsDaemonMetadataSubscriptions\(\)/)
  assert.match(text, /if \(invalidated\.has\('session_host\.diagnostics'\)\) void this\.flushWsSessionHostDiagnosticsSubscriptions\(\)/)
  assert.match(text, /if \(invalidated\.has\('session\.modal'\)\) void this\.flushWsSessionModalSubscriptions\(\)/)
  assert.match(text, /if \(invalidated\.has\('workspace\.git'\) && this\.hasWsGitSubscriptions\(\)\) void this\.flushWsGitSubscriptions\(\)/)
  // The old local predicate must stay deleted (it diverged from cloud once already).
  assert.doesNotMatch(text, /function commandMayAffectMeshGraphStatus/)
})
