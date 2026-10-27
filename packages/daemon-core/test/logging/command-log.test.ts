import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getCommandLogPath,
  getRecentCommands,
  logCommand,
  shouldLogCommand,
} from '../../src/logging/command-log'

describe('command-log noise filter', () => {
  it('skips high-frequency read and seen commands', () => {
    expect(shouldLogCommand('heartbeat')).toBe(false)
    expect(shouldLogCommand('status_report')).toBe(false)
    expect(shouldLogCommand('read_chat')).toBe(false)
    expect(shouldLogCommand('mark_session_seen')).toBe(false)
  })

  it('keeps user-visible control commands loggable', () => {
    expect(shouldLogCommand('send_chat')).toBe(true)
    expect(shouldLogCommand('set_cli_view_mode')).toBe(true)
  })

  it('Finding 3 & Residual: masks underscore-prefixed object/array args and raw/base64/percent-encoded mcp_sess_* values on disk and in getRecentCommands', () => {
    const prevConfigDir = process.env.ADHDEV_CONFIG_DIR
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-cmd-log-r5-'))
    process.env.ADHDEV_CONFIG_DIR = tempDir
    try {
      const liveCred = 'mcp_sess_a1b2c3d4e5f60718293a4b5c6d7e8f90'
      const b64Cred = Buffer.from(liveCred, 'utf8').toString('base64')
      const pctCred = 'mcp%5Fsess%5Fa1b2c3d4e5f60718293a4b5c6d7e8f90'

      logCommand('assistant_artifact_list', 'ipc', {
        project: 'demo',
        _diagnostic: { value: liveCred, nestedArr: [liveCred, { deep: liveCred }] },
        _diagnosticArray: [liveCred],
        neutralB64: b64Cred,
        neutralPct: pctCred,
      })

      const diskText = fs.readFileSync(getCommandLogPath(), 'utf8')
      expect(diskText).not.toContain(liveCred)
      expect(diskText).not.toContain(b64Cred)
      expect(diskText).not.toContain(pctCred)

      // Also verify getRecentCommands masks legacy/unmasked lines if present on disk
      fs.appendFileSync(
        getCommandLogPath(),
        JSON.stringify({
          ts: new Date().toISOString(),
          cmd: 'legacy_cmd',
          src: 'ipc',
          args: {
            _diagnostic: { value: liveCred },
            _diagnosticArr: [liveCred],
            encoded: b64Cred,
          },
          ok: true,
        }) + '\n',
        'utf8',
      )

      const recentSerialized = JSON.stringify(getRecentCommands(20))
      expect(recentSerialized).not.toContain(liveCred)
      expect(recentSerialized).not.toContain(b64Cred)
      expect(recentSerialized).not.toContain(pctCred)
    } finally {
      if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = prevConfigDir
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
