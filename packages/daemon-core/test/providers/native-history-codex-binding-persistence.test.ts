import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createNativeHistoryDispatcher, clearCodexRuntimeBinding } from '../../src/providers/native-history/dispatcher.js'

// The dispatcher reads ~/.codex/sessions via os.homedir(); redirect it to a temp
// root. os.homedir is non-configurable on this runtime, so spy on the module
// binding rather than assigning to the property.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, default: actual, homedir: vi.fn(actual.homedir) }
})

// FLOOR-TIMING-WEDGE (fix 2 — binding persistence).
//
// findCodexPathByRuntime is a TIMEBOXED search: it only considers rollout files whose
// mtime falls within RECENT_WINDOW_MS (5 min) and whose session_meta timestamp is
// within SPAWN_BIND_GRACE_MS of this session's spawn. Those are properties of the
// SEARCH, not of the binding — so a session that resolved correctly at minute 2 stops
// resolving at minute 6 purely because its rollout mtime aged out, even though it is
// the same file, still on disk, still this session's transcript.
//
// Once the transcript stops resolving, every completion probe reads null: no proof of
// turn end, and (pre-fix-1) a permanent 'generating' wedge. Making the binding sticky
// removes that second, independent path into the same wedge.
describe('codex rollout binding persistence', () => {
  let root: string
  let sessionsRoot: string
  let workspace: string

  // The codex reader requires a real session uuid (meta id and filename uuid must
  // agree) and at least one parsed message, so the fixture mirrors a genuine
  // rollout's opening records rather than a minimal stub.
  function writeRollout(uuid: string, cwd: string, timestampMs: number, mtimeMs: number): string {
    const dir = path.join(sessionsRoot, '2026', '08', '17')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `rollout-2026-08-17T05-16-24-${uuid}.jsonl`)
    const ts = new Date(timestampMs).toISOString()
    const lines = [
      { type: 'session_meta', payload: { id: uuid, cwd, timestamp: ts } },
      { type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: 'do the thing' } },
      { type: 'event_msg', timestamp: ts, payload: { type: 'agent_message', message: 'done: committed' } },
      { type: 'event_msg', timestamp: ts, payload: { type: 'task_complete', last_agent_message: 'done: committed' } },
    ]
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
    return file
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bind-'))
    sessionsRoot = path.join(root, '.codex', 'sessions')
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ws-'))
    vi.mocked(os.homedir).mockReturnValue(root)
    clearCodexRuntimeBinding()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearCodexRuntimeBinding()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('keeps resolving this session\'s rollout after its mtime ages out of the recency window', () => {
    const spawnedAt = Date.now()
    // Fresh on the first read: mtime is "now", meta timestamp matches the spawn.
    const file = writeRollout('01a00e1b-1111-4222-8333-444455556666', workspace, spawnedAt, Date.now())
    const read = createNativeHistoryDispatcher('codex-cli')

    // First read binds through the strict timing rules.
    const first = read({ workspace, sessionStartedAtMs: spawnedAt })
    expect(first?.sourcePath).toBe(file)

    // The session then goes quiet (a long tool call / a long model turn) and the
    // rollout's mtime ages past RECENT_WINDOW_MS (5 min). Nothing about the binding
    // changed — only the clock.
    const aged = Date.now() - 20 * 60 * 1000
    fs.utimesSync(file, new Date(aged), new Date(aged))

    const second = read({ workspace, sessionStartedAtMs: spawnedAt })

    // Pre-fix this returned null (the timebox rejected the aged file), which is the
    // second independent route into the permanent 'generating' wedge.
    expect(second?.sourcePath).toBe(file)
    expect(second?.turnTerminalMarkers?.length).toBeGreaterThan(0)
  })

  it('does not leak a binding across sessions in the same workspace', () => {
    const spawnA = Date.now()
    const fileA = writeRollout('01a00e1b-1111-4222-8333-444455556666', workspace, spawnA, Date.now())
    const read = createNativeHistoryDispatcher('codex-cli')
    expect(read({ workspace, sessionStartedAtMs: spawnA })?.sourcePath).toBe(fileA)

    // A DIFFERENT session in the same workspace (distinct spawn stamp) must resolve
    // its own rollout, never inherit A's pin.
    const spawnB = spawnA + 60_000
    const fileB = writeRollout('02b11f2c-2222-4333-8444-555566667777', workspace, spawnB, Date.now())
    expect(read({ workspace, sessionStartedAtMs: spawnB })?.sourcePath).toBe(fileB)
    // A still resolves to A.
    expect(read({ workspace, sessionStartedAtMs: spawnA })?.sourcePath).toBe(fileA)
  })

  it('falls back to a fresh search when the pinned rollout disappears', () => {
    const spawnedAt = Date.now()
    const file = writeRollout('01a00e1b-1111-4222-8333-444455556666', workspace, spawnedAt, Date.now())
    const read = createNativeHistoryDispatcher('codex-cli')
    expect(read({ workspace, sessionStartedAtMs: spawnedAt })?.sourcePath).toBe(file)

    // Rotated/deleted: the stale pin must be dropped rather than returned.
    fs.rmSync(file)
    expect(read({ workspace, sessionStartedAtMs: spawnedAt })).toBeNull()
  })
})
