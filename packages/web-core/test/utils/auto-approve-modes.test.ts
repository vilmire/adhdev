import { describe, expect, it } from 'vitest'
import type { AutoApproveModesConfig } from '@adhdev/daemon-core'
import {
  buildAutoApproveLaunchSettings,
  deriveAutoApproveModeRisk,
  resolveInitialAutoApproveModeId,
} from '../../src/utils/auto-approve-modes'

const config: AutoApproveModesConfig = {
  default: 'pty-parse',
  modes: [
    { id: 'pty-parse', label: 'PTY parse', strategy: 'pty-parse-default', risk: 'safe' },
    {
      id: 'yolo',
      label: 'YOLO',
      strategy: 'launch-args',
      risk: 'dangerous',
      warning: 'Bypasses approvals',
      launchArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    },
  ],
}

describe('auto-approve launch UI policy', () => {
  it('derives dangerous risk from injected arguments instead of trusting the manifest label', () => {
    expect(deriveAutoApproveModeRisk({
      risk: 'safe',
      launchArgs: ['--dangerously-skip-permissions'],
    })).toBe('dangerous')
  })

  it('never activates a dangerous manifest default without confirmation', () => {
    expect(resolveInitialAutoApproveModeId({ ...config, default: 'yolo' })).toBe('pty-parse')
    expect(resolveInitialAutoApproveModeId({
      default: 'yolo',
      modes: [config.modes[1]],
    })).toBe('')
  })

  it('stamps a selected mode id and preserves the legacy boolean fallback', () => {
    expect(buildAutoApproveLaunchSettings(config, 'pty-parse', false)).toEqual({
      autoApproveMode: 'pty-parse',
    })
    expect(buildAutoApproveLaunchSettings(undefined, '', true)).toEqual({
      autoApprove: true,
    })
  })
})
