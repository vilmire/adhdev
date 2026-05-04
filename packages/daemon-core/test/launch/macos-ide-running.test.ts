import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  spawnSync: vi.fn(),
  platform: vi.fn(() => 'darwin'),
  detectIDEs: vi.fn(),
  createServer: vi.fn(),
  httpGet: vi.fn(),
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

vi.mock('net', () => ({
  default: { createServer: mocks.createServer },
  createServer: mocks.createServer,
}))

vi.mock('http', () => ({
  default: { get: mocks.httpGet },
  get: mocks.httpGet,
}))

vi.mock('../../src/detection/ide-detector.js', () => ({
  detectIDEs: mocks.detectIDEs,
}))

vi.mock('../../src/providers/provider-loader.js', () => ({
  ProviderLoader: class {
    loadAll() {}
    registerToDetector() {}
    getMacAppIdentifiers() { return { antigravity: 'Antigravity' } }
    getIdePathCandidates() { return ['/Applications/Antigravity.app'] }
    getWinProcessNames() { return {} }
    getCdpPortMap() { return { antigravity: [49335, 49336] } }
    getMeta() { return { launch: { prefer: { darwin: 'app' }, cdpStartupTimeoutMs: 1000 } } }
    getAvailableIdeTypes() { return [] }
  },
}))

import { isIdeRunning, killIdeProcess, launchWithCdp } from '../../src/launch'

describe('macOS app bundle process fallback', () => {
  beforeEach(() => {
    mocks.execSync.mockReset()
    mocks.spawn.mockClear()
    mocks.spawnSync.mockReset()
    mocks.detectIDEs.mockReset()
    mocks.createServer.mockReset()
    mocks.httpGet.mockReset()
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

  it('reports launch failure when the spawned IDE never exposes the required CDP port', async () => {
    mocks.detectIDEs.mockResolvedValue([
      { id: 'antigravity', name: 'Antigravity', displayName: 'Antigravity', installed: true, cliCommand: 'antigravity' },
    ])
    mocks.execSync.mockImplementation((command: string) => {
      if (command.startsWith('pgrep -x "Antigravity"')) throw new Error('no process named Antigravity')
      if (command.includes('System Events')) return '0\n'
      if (command === 'ps axww -o pid=,args=') return ''
      throw new Error(`unexpected command: ${command}`)
    })
    mocks.createServer.mockImplementation(() => ({
      unref: vi.fn(),
      on: vi.fn(),
      listen: vi.fn((_port: number, _host: string, callback: () => void) => callback()),
      close: vi.fn((callback: () => void) => callback()),
    }))
    mocks.httpGet.mockImplementation((_url: string, _options: unknown, _callback: unknown) => {
      const req = {
        on: vi.fn((event: string, callback: () => void) => {
          if (event === 'error') queueMicrotask(callback)
          return req
        }),
        destroy: vi.fn(),
      }
      return req
    })

    await expect(launchWithCdp({ ideId: 'antigravity' })).resolves.toMatchObject({
      success: false,
      ideId: 'antigravity',
      port: 49335,
      action: 'failed',
      error: 'Antigravity launched but CDP did not become available on port 49335',
    })
    expect(mocks.spawn).toHaveBeenCalledWith(
      'open',
      ['-a', 'Antigravity', '--args', '--remote-debugging-port=49335'],
      { detached: true, stdio: 'ignore' },
    )
  })
})
