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
