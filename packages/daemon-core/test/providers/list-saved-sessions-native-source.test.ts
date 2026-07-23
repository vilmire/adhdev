import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { executeNativeHistoryList } from '../../src/providers/spec/native-history-executor.js'
import type { NativeHistoryConfig } from '../../src/providers/spec/types.js'

// These fixtures exercise the enumerator against REAL on-disk transcript files,
// covering the three session-id extraction shapes the declarative jsonl sources
// use in production:
//   - claude  → cwd-templated dir + `{session_id}.jsonl` leaf   (filename_uuid)
//   - kimi    → `session_<uuid>/…/wire.jsonl`                    (dir_uuid)
//   - cursor  → glob dir + `<uuid>.jsonl` leaf                   (filename_uuid)
// The pre-existing chat-history stub test only covered a hand-written
// listNativeHistory fn (codex-style script), so it never touched this path and
// the "list always empty" gap slipped through. Here we drive the executor
// directly so a regression in the directory-walk / id-extraction surfaces.

let tmpRoot = ''

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-list-'))
})

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best effort */ }
})

function writeJsonl(filePath: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

// ── claude: `<projects>/<cwd-slug>/{session_id}.jsonl`, filename_uuid ──────────
function claudeConfig(): NativeHistoryConfig {
  return {
    source: {
      kind: 'jsonl',
      path: path.join(tmpRoot, 'claude', 'projects', '{cwd_claude_project}', '{session_id}.jsonl'),
      session_id_from: 'filename_uuid',
      message_filter: { where: "$.type == 'user' || $.type == 'assistant'" },
      message_map: {
        role: '$.message.role',
        content: '$.message.content',
        timestamp_ms: '$.timestamp',
      },
    },
  }
}

function writeClaudeSession(slug: string, sessionId: string, msgs: Array<{ role: string; content: string; ts: number }>): void {
  const file = path.join(tmpRoot, 'claude', 'projects', slug, `${sessionId}.jsonl`)
  writeJsonl(file, msgs.map(m => ({
    type: m.role,
    timestamp: m.ts,
    message: { role: m.role, content: m.content },
  })))
}

// ── kimi: `sessions/*/session_<uuid>/agents/main/wire.jsonl`, dir_uuid ─────────
function kimiConfig(): NativeHistoryConfig {
  return {
    source: {
      kind: 'jsonl',
      path: path.join(tmpRoot, 'kimi-code', 'sessions', '*', 'session_*', 'agents', 'main'),
      file_pattern: 'wire.jsonl',
      session_id_from: 'dir_uuid',
      workspace_from_sidecar: { rel_path: '../../state.json', workspace_path: '$.workDir' },
      records: [
        { where: '$.type == "turn.prompt"', message_map: { role: 'user', content: '$.input', timestamp_ms: '$.time' } },
        {
          where: '$.type == "context.append_loop_event" && $.event.type == "content.part" && $.event.part.type == "text"',
          message_map: { role: 'assistant', content: '$.event.part.text', timestamp_ms: '$.time' },
        },
      ],
    },
  }
}

function writeKimiSession(wdKey: string, sessionId: string, workDir: string, turns: Array<{ role: 'user' | 'assistant'; text: string; ts: number }>): void {
  const sessionDir = path.join(tmpRoot, 'kimi-code', 'sessions', wdKey, `session_${sessionId}`)
  const wire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl')
  writeJsonl(wire, turns.map(t => t.role === 'user'
    ? { type: 'turn.prompt', time: t.ts, input: t.text }
    : { type: 'context.append_loop_event', time: t.ts, event: { type: 'content.part', part: { type: 'text', text: t.text } } }))
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ workDir }), 'utf8')
}

// ── cursor: `projects/*/agent-transcripts/<uuid>/<uuid>.jsonl`, filename_uuid ──
function cursorConfig(): NativeHistoryConfig {
  return {
    source: {
      kind: 'jsonl',
      path: path.join(tmpRoot, 'cursor', 'projects', '*', 'agent-transcripts', '*'),
      file_pattern: '*.jsonl',
      session_id_from: 'filename_uuid',
      workspace_from_input: true,
      message_map: { role: '$.role', content: '$.message.content' },
    },
  }
}

function writeCursorSession(slug: string, sessionId: string, msgs: Array<{ role: string; content: string }>): void {
  // cursor's on-disk layout nests each transcript in its own uuid dir:
  // agent-transcripts/<uuid>/<uuid>.jsonl (the trailing `*` in the source path).
  const file = path.join(tmpRoot, 'cursor', 'projects', slug, 'agent-transcripts', sessionId, `${sessionId}.jsonl`)
  writeJsonl(file, msgs.map(m => ({ role: m.role, message: { content: m.content } })))
}

describe('executeNativeHistoryList — declarative jsonl enumeration', () => {
  it('enumerates claude sessions via cwd-templated dir + filename uuid', () => {
    writeClaudeSession('-workspaces-alpha', UUID_A, [
      { role: 'user', content: 'hello alpha', ts: 1_800_000_001_000 },
      { role: 'assistant', content: 'alpha reply', ts: 1_800_000_002_000 },
    ])
    // A second workspace's transcript — enumeration must span all cwd slugs.
    writeClaudeSession('-workspaces-beta', UUID_B, [
      { role: 'user', content: 'hello beta', ts: 1_800_000_010_000 },
      { role: 'assistant', content: 'beta reply', ts: 1_800_000_011_000 },
    ])

    const result = executeNativeHistoryList(claudeConfig())
    expect(result).not.toBeNull()
    const ids = result!.sessions.map(s => s.historySessionId).sort()
    expect(ids).toEqual([UUID_A, UUID_B].sort())

    // Newest lastMessageAt first.
    expect(result!.sessions[0].historySessionId).toBe(UUID_B)

    const alpha = result!.sessions.find(s => s.historySessionId === UUID_A)!
    expect(alpha.messageCount).toBe(2)
    expect(alpha.preview).toBe('alpha reply')
    expect(alpha.sessionTitle).toBe('alpha reply')
    expect(alpha.firstMessageAt).toBe(1_800_000_001_000)
    expect(alpha.lastMessageAt).toBe(1_800_000_002_000)
    expect(alpha.sourcePath.endsWith(`${UUID_A}.jsonl`)).toBe(true)
    expect(alpha.sourceMtimeMs).toBeGreaterThan(0)
  })

  it('extracts kimi session id from the parent directory (dir_uuid) and workspace from the sidecar', () => {
    writeKimiSession('wd_alpha_abc', UUID_A, '/workspaces/kimi-alpha', [
      { role: 'user', text: 'kimi q', ts: 1_800_000_020_000 },
      { role: 'assistant', text: 'kimi a', ts: 1_800_000_021_000 },
    ])

    const result = executeNativeHistoryList(kimiConfig())
    expect(result).not.toBeNull()
    expect(result!.sessions).toHaveLength(1)
    const s = result!.sessions[0]
    // Session id comes from the `session_<uuid>` DIRECTORY, not the fixed
    // `wire.jsonl` filename.
    expect(s.historySessionId).toBe(UUID_A)
    expect(s.messageCount).toBe(2)
    expect(s.preview).toBe('kimi a')
    expect(s.workspace).toBe('/workspaces/kimi-alpha')
    expect(s.sourcePath.endsWith(path.join('main', 'wire.jsonl'))).toBe(true)
  })

  it('extracts cursor session id from the filename across a project glob', () => {
    writeCursorSession('-workspaces-cursor-x-1a2b3c4', UUID_A, [
      { role: 'user', content: 'cursor q' },
      { role: 'assistant', content: 'cursor a' },
    ])
    writeCursorSession('-workspaces-cursor-y-9f8e7d6', UUID_B, [
      { role: 'user', content: 'cursor q2' },
    ])

    const result = executeNativeHistoryList(cursorConfig())
    expect(result).not.toBeNull()
    const ids = result!.sessions.map(s => s.historySessionId).sort()
    expect(ids).toEqual([UUID_A, UUID_B].sort())
    const a = result!.sessions.find(s => s.historySessionId === UUID_A)!
    expect(a.messageCount).toBe(2)
    expect(a.preview).toBe('cursor a')
  })

  it('returns an empty list for an empty store', () => {
    const result = executeNativeHistoryList(claudeConfig())
    expect(result).toEqual({ sessions: [] })
  })

  it('ignores files that do not match the leaf/file pattern', () => {
    // A valid claude session…
    writeClaudeSession('-workspaces-alpha', UUID_A, [
      { role: 'user', content: 'keep me', ts: 1_800_000_030_000 },
    ])
    // …plus noise that must not be enumerated: a non-uuid .jsonl and a
    // wrong-extension file next to it.
    const projectDir = path.join(tmpRoot, 'claude', 'projects', '-workspaces-alpha')
    fs.writeFileSync(path.join(projectDir, 'not-a-uuid.txt'), 'ignored', 'utf8')
    writeJsonl(path.join(projectDir, 'notuuid.jsonl'), [{ type: 'user', timestamp: 1, message: { role: 'user', content: 'x' } }])

    const result = executeNativeHistoryList(claudeConfig())!
    // `notuuid.jsonl` matches the `*.jsonl` leaf glob but yields no uuid, so it
    // is dropped by session-id extraction; the .txt never matches at all.
    expect(result.sessions.map(s => s.historySessionId)).toEqual([UUID_A])
  })

  it('returns null for a sqlite source (enumerated through its own query, not here)', () => {
    const cfg: NativeHistoryConfig = {
      source: {
        kind: 'sqlite',
        path: path.join(tmpRoot, 'state.db'),
        session_query: 'SELECT 1',
        message_query: 'SELECT 1',
        message_map: { role: '$.role', content: '$.content' },
      },
    }
    expect(executeNativeHistoryList(cfg)).toBeNull()
  })

  it('returns null when no source is declared', () => {
    expect(executeNativeHistoryList({} as NativeHistoryConfig)).toBeNull()
  })
})
