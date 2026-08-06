import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getCommandLogPath, getRecentCommands, logCommand } from '../../src/logging/command-log'

// The command log used to snapshot ADHDEV_CONFIG_DIR at MODULE IMPORT time, so
// an override assigned afterwards (the normal shape of a test, or a daemon that
// pins its instance dir during boot) was silently ignored and entries landed in
// the wrong instance home. Resolution is lazy now — these tests pin that down.

const ORIGINAL = process.env.ADHDEV_CONFIG_DIR
const created: string[] = []

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = ORIGINAL
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true })
})

describe('command-log lazy config-dir resolution', () => {
  it('honors an ADHDEV_CONFIG_DIR assigned AFTER module import', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-cmdlog-'))
    created.push(dir)
    process.env.ADHDEV_CONFIG_DIR = dir

    logCommand({ ts: new Date().toISOString(), cmd: 'send_chat', source: 'ws' })

    const today = new Date().toISOString().slice(0, 10)
    const expected = join(dir, 'logs', `commands-${today}.jsonl`)
    expect(getCommandLogPath()).toBe(expected)
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected, 'utf-8')).toContain('send_chat')
  })

  it('follows the override again when it changes between writes', () => {
    const first = mkdtempSync(join(tmpdir(), 'adhdev-cmdlog-a-'))
    const second = mkdtempSync(join(tmpdir(), 'adhdev-cmdlog-b-'))
    created.push(first, second)

    process.env.ADHDEV_CONFIG_DIR = first
    logCommand({ ts: new Date().toISOString(), cmd: 'send_chat', source: 'ws' })

    process.env.ADHDEV_CONFIG_DIR = second
    logCommand({ ts: new Date().toISOString(), cmd: 'set_cli_view_mode', source: 'api' })

    expect(getCommandLogPath().startsWith(second)).toBe(true)
    const recent = getRecentCommands(10)
    expect(recent.some((e) => e.cmd === 'set_cli_view_mode')).toBe(true)
  })
})
