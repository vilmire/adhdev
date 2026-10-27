import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionHostRegistry } from '@adhdev/session-host-core'
import type { SessionHostRecord } from '@adhdev/session-host-core'
import {
  SessionHostStorage,
  DEAD_SESSION_SNAPSHOT_MAX_CHARS,
} from '../src/storage.js'
import { buildRecoveredRecord, buildPayloadFromRecord } from '../src/session-lifecycle.js'

const CLI_ARGS = ['--model', 'sonnet', '--append-system-prompt', 'x'.repeat(2000)]
const ARGV = ['--session-id', 'abc', ...CLI_ARGS, '--verbose']

function record(over: Partial<SessionHostRecord> = {}): SessionHostRecord {
  return {
    sessionId: 'rt-1', runtimeKey: 'k', displayName: 'd', workspaceLabel: 'w', transport: 'pty',
    providerType: 'claude-cli', category: 'cli', workspace: '/tmp/ws',
    launchCommand: { command: 'claude', args: ARGV, env: { A: '1' }, envMode: 'launch_overrides' },
    createdAt: 1, lastActivityAt: 2, lifecycle: 'running', writeOwner: null, attachedClients: [],
    buffer: { scrollbackBytes: 0, snapshotSeq: 0 },
    meta: { cliArgs: CLI_ARGS, providerSessionId: 'p1', launchRecord: { a: 1 } },
    ...over,
  } as SessionHostRecord
}

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtrec-'))
  return { dir, storage: new SessionHostStorage({ rootDir: dir }) }
}
const file = (dir: string) => path.join(dir, 'runtimes', 'rt-1.json')

test('launch args appear once in the serialized record and round-trip to the same record', () => {
  const { dir, storage } = mk()
  const rec = record()
  storage.save(rec, { seq: 1, text: 'hi', truncated: false })
  const raw = fs.readFileSync(file(dir), 'utf8')
  assert.equal(raw.split('x'.repeat(2000)).length - 1, 1, 'long arg must be stored once')
  const [loaded] = storage.loadAll()
  assert.deepEqual(loaded.record, rec)
  assert.equal((loaded.record.meta as any).cliArgsRef, undefined)
})

test('old-format record (inline meta.cliArgs, pretty-printed) loads and restores identically', () => {
  const { dir, storage } = mk()
  const rec = record()
  fs.mkdirSync(path.join(dir, 'runtimes'), { recursive: true })
  fs.writeFileSync(file(dir), JSON.stringify({ record: rec, snapshot: { seq: 3, text: 'old', truncated: false }, updatedAt: 5 }, null, 2))
  const [loaded] = storage.loadAll()
  assert.deepEqual(loaded.record, rec)
  const { recoveredRecord } = buildRecoveredRecord(loaded)
  const registry = new SessionHostRegistry()
  registry.restoreSession(recoveredRecord, loaded.snapshot)
  assert.deepEqual(registry.getSession('rt-1')!.meta.cliArgs, CLI_ARGS)
  assert.deepEqual(buildPayloadFromRecord(recoveredRecord).launchCommand.args, ARGV)
})

test('cliArgs that are not a window of the argv stay inline (nothing lost)', () => {
  const { dir, storage } = mk()
  const rec = record({ meta: { cliArgs: ['--unrelated'], providerSessionId: 'p1' } })
  storage.save(rec, { seq: 1, text: '', truncated: false })
  assert.match(fs.readFileSync(file(dir), 'utf8'), /--unrelated/)
  assert.deepEqual(storage.loadAll()[0].record, rec)
})

test('dead session snapshot is pruned to a tail; identity, tombstone and launch data survive', () => {
  const { dir, storage } = mk()
  const text = 'A'.repeat(1_000_000) + 'TAIL'
  const rec = record({ lifecycle: 'stopped', termination: { exitCode: 0, signal: null, reason: 'exit', lifecycle: 'stopped', terminatedAt: 9 } })
  storage.save(rec, { seq: 42, text, truncated: false })
  storage.saveTombstone('rt-1', rec.termination!)
  const [loaded] = storage.loadAll()
  assert.equal(loaded.snapshot.seq, 42)
  assert.equal(loaded.snapshot.truncated, true)
  assert.equal(loaded.snapshot.text.length, DEAD_SESSION_SNAPSHOT_MAX_CHARS)
  assert.ok(loaded.snapshot.text.endsWith('TAIL'))
  assert.deepEqual(loaded.record, rec)
  assert.equal(storage.loadTombstone('rt-1')?.termination.exitCode, 0)
  const registry = new SessionHostRegistry()
  registry.restoreSession(buildRecoveredRecord(loaded).recoveredRecord, loaded.snapshot)
  assert.ok(registry.getSnapshot('rt-1')!.text.endsWith('TAIL'))
})

test('live session snapshot is never pruned', () => {
  const { storage } = mk()
  const text = 'B'.repeat(500_000)
  storage.save(record(), { seq: 7, text, truncated: false })
  assert.equal(storage.loadAll()[0].snapshot.text.length, text.length)
})

test('size before/after for a realistic stopped record', () => {
  const rec = record({ lifecycle: 'stopped', termination: { exitCode: 0, signal: null, reason: 'exit', lifecycle: 'stopped', terminatedAt: 9 } })
  const snapshot = { seq: 9, text: '\x1b[31mline of output\x1b[0m\r\n'.repeat(40000), truncated: false }
  const before = JSON.stringify({ record: rec, snapshot, updatedAt: 1 }, null, 2).length
  const { dir, storage } = mk()
  storage.save(rec, snapshot)
  const after = fs.statSync(file(dir)).size
  console.log(`# runtime record size before=${before} after=${after}`)
  assert.ok(after < before / 5)
})

test('listing summaries never read snapshot bodies', () => {
  const registry = new SessionHostRegistry()
  registry.restoreSession(record(), { seq: 1, text: 'x', truncated: false })
  const state = (registry as any).sessions.get('rt-1')
  state.buffer.snapshot = () => { throw new Error('snapshot body read during listing') }
  state.buffer.getState = () => { throw new Error('buffer read during listing') }
  assert.equal(registry.listSessionSummaries().length, 1)
  assert.equal(registry.listSessions().length, 1)
})
