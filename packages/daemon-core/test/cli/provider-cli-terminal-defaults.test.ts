import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_HOST_COLS,
  DEFAULT_SESSION_HOST_ROWS,
  resolveSessionHostCols,
  resolveSessionHostRows,
} from '@adhdev/session-host-core'
import { resolveCliSpawnPlan } from '../../src/cli-adapters/provider-cli-runtime'

describe('CLI PTY default terminal sizing', () => {
  it('defaults provider PTYs to 80x32', () => {
    const plan = resolveCliSpawnPlan({
      provider: {
        spawn: {
          command: '/bin/echo',
          args: [],
        },
      } as any,
      runtimeSettings: {},
      workingDir: process.cwd(),
      extraArgs: [],
    })

    expect(plan.ptyOptions.cols).toBe(80)
    expect(plan.ptyOptions.rows).toBe(32)
  })

  it('normalizes invalid or fractional session-host dimensions back to safe shared defaults', () => {
    expect(resolveSessionHostCols(undefined)).toBe(DEFAULT_SESSION_HOST_COLS)
    expect(resolveSessionHostCols(0)).toBe(DEFAULT_SESSION_HOST_COLS)
    expect(resolveSessionHostCols(-5)).toBe(DEFAULT_SESSION_HOST_COLS)
    expect(resolveSessionHostCols(132.9)).toBe(132)

    expect(resolveSessionHostRows(undefined)).toBe(DEFAULT_SESSION_HOST_ROWS)
    expect(resolveSessionHostRows(0)).toBe(DEFAULT_SESSION_HOST_ROWS)
    expect(resolveSessionHostRows(Number.NaN)).toBe(DEFAULT_SESSION_HOST_ROWS)
    expect(resolveSessionHostRows(32.8)).toBe(32)
  })

  it('uses shared session-host defaults/helpers instead of repeating literal PTY defaults across runtime entrypoints', () => {
    const providerRuntime = fs.readFileSync(path.join(import.meta.dirname, '../../src/cli-adapters/provider-cli-runtime.ts'), 'utf8')
    const sessionRegistry = fs.readFileSync(path.join(import.meta.dirname, '../../../session-host-core/src/registry.ts'), 'utf8')
    const sessionRuntime = fs.readFileSync(path.join(import.meta.dirname, '../../../session-host-daemon/src/runtime.ts'), 'utf8')
    const sessionServer = fs.readFileSync(path.join(import.meta.dirname, '../../../session-host-daemon/src/server.ts'), 'utf8')

    expect(providerRuntime.includes('DEFAULT_SESSION_HOST_COLS')).toBe(true)
    expect(providerRuntime.includes('DEFAULT_SESSION_HOST_ROWS')).toBe(true)

    for (const source of [sessionRegistry, sessionRuntime, sessionServer]) {
      expect(source.includes('resolveSessionHostCols')).toBe(true)
      expect(source.includes('resolveSessionHostRows')).toBe(true)
      expect(source.includes('rows || 24')).toBe(false)
      expect(source.includes('rows: 24')).toBe(false)
      expect(source.includes('cols || 80')).toBe(false)
      expect(source.includes('cols: 80')).toBe(false)
    }
  })
})
