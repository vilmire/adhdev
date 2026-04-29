import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  spawnSync: vi.fn(),
  platform: vi.fn(() => 'darwin'),
}))

vi.mock('child_process', () => ({
  execSync: mocks.execSync,
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}))

vi.mock('os', () => ({
  platform: mocks.platform,
  homedir: () => '/tmp',
}))

vi.mock('../../src/providers/provider-loader.js', () => ({
  ProviderLoader: class {
    loadAll() {}
    registerToDetector() {}
    getMacAppIdentifiers() { return { antigravity: 'Antigravity' } }
    getIdePathCandidates() { return ['/Applications/Antigravity.app'] }
    getWinProcessNames() { return {} }
    getCdpPortMap() { return {} }
    getMeta() { return undefined }
    getAvailableIdeTypes() { return [] }
  },
}))

import { isIdeRunning, killIdeProcess } from '../../src/launch'

describe('macOS app bundle process fallback', () => {
  beforeEach(() => {
    mocks.execSync.mockReset()
    mocks.platform.mockReturnValue('darwin')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects Antigravity when macOS exposes the process as Electron under the app bundle path', () => {
    mocks.execSync.mockImplementation((command: string) => {
      if (command.startsWith('pgrep -x "Antigravity"')) throw new Error('no process named Antigravity')
      if (command.includes('System Events')) return '0\n'
      if (command === 'ps axww -o pid=,args=') {
        return [
          '97189 /Applications/Antigravity.app/Contents/MacOS/Electron',
          '12345 /Applications/Slack.app/Contents/MacOS/Electron',
          '12346 /bin/zsh -lc grep /Applications/Antigravity.app/Contents/MacOS/Electron',
        ].join('\n')
      }
      throw new Error(`unexpected command: ${command}`)
    })

    expect(isIdeRunning('antigravity')).toBe(true)
  })

  it('kills only Antigravity app-bundle Electron processes when the process name is not Antigravity', async () => {
    let killed = false
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      expect(pid).toBe(97189)
      expect(signal).toBe('SIGTERM')
      killed = true
      return true
    }) as typeof process.kill)

    mocks.execSync.mockImplementation((command: string) => {
      if (command.startsWith('osascript -e')) return ''
      if (command.startsWith('pgrep -x "Antigravity"')) throw new Error('no process named Antigravity')
      if (command.includes('System Events')) return '0\n'
      if (command === 'ps axww -o pid=,args=') {
        return killed ? '' : [
          '97189 /Applications/Antigravity.app/Contents/MacOS/Electron',
          '12345 /Applications/Slack.app/Contents/MacOS/Electron',
          '12346 /bin/zsh -lc grep /Applications/Antigravity.app/Contents/MacOS/Electron',
        ].join('\n')
      }
      throw new Error(`unexpected command: ${command}`)
    })

    await expect(killIdeProcess('antigravity')).resolves.toBe(true)
    expect(killSpy).toHaveBeenCalledTimes(1)
  })
})
