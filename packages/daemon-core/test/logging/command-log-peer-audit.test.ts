import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getCommandLogPath, getRecentCommands, logCommand } from '../../src/logging/command-log'

// SEND-CHAT AUDIT (2026-09-10 investigation gap): a src:'p2p' command entry
// carried no peer identifier, so "which dashboard peer sent this" could not be
// answered from the audit log. `peerId` (the DataChannel connection id) is now
// recorded as `peer` — identifier ONLY. The pre-existing content boundary is
// unchanged: `message`/`content`/`text` args stay masked as `[N chars]`.

const ORIGINAL = process.env.ADHDEV_CONFIG_DIR
const created: string[] = []

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = ORIGINAL
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true })
})

function useTempConfigDir(): void {
  const dir = mkdtempSync(join(tmpdir(), 'adhdev-cmdlog-peer-'))
  created.push(dir)
  process.env.ADHDEV_CONFIG_DIR = dir
}

describe('command-log P2P peer attribution', () => {
  it('records the peer identifier while the message body stays masked', () => {
    useTempConfigDir()
    const secret = 'the user typed this and it must never reach the audit log'
    logCommand({
      ts: new Date().toISOString(),
      cmd: 'send_chat',
      source: 'p2p',
      peerId: 'peer_178f00ba11',
      args: { message: secret, targetSessionId: 'sess-1' },
    })

    const raw = readFileSync(getCommandLogPath(), 'utf-8')
    const entry = JSON.parse(raw.trim().split('\n').pop()!)
    expect(entry.src).toBe('p2p')
    expect(entry.peer).toBe('peer_178f00ba11')
    // Content boundary: the body is length-masked, and the raw line never
    // contains the original text anywhere (not smuggled via the peer field).
    expect(entry.args.message).toBe(`[${secret.length} chars]`)
    expect(raw).not.toContain(secret)
  })

  it('round-trips peerId through getRecentCommands and omits it when absent', () => {
    useTempConfigDir()
    logCommand({ ts: new Date().toISOString(), cmd: 'send_chat', source: 'p2p', peerId: 'peer_abc123' })
    logCommand({ ts: new Date().toISOString(), cmd: 'send_chat', source: 'ws' })

    const recent = getRecentCommands(10)
    const p2p = recent.find((e) => e.source === 'p2p')
    const ws = recent.find((e) => e.source === 'ws')
    expect(p2p?.peerId).toBe('peer_abc123')
    expect(ws?.peerId).toBeUndefined()

    // The ws line carries no peer field at all (not an empty placeholder).
    const rawLines = readFileSync(getCommandLogPath(), 'utf-8').trim().split('\n')
    expect(rawLines.filter((l) => l.includes('"peer"'))).toHaveLength(1)
  })
})
