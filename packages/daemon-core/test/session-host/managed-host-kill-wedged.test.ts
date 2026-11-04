import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHealthyManagedHostDisk } from '../helpers/managed-host-disk'

useHealthyManagedHostDisk()

const cp = vi.hoisted(() => ({ execFileSync: vi.fn(), spawn: vi.fn(() => ({ unref: vi.fn(), pid: 1 })) }))
vi.mock('child_process', () => cp)

import { sessionHostInstanceArg } from '../../src/commands/process-lifecycle'
import { createManagedSessionHost } from '../../src/session-host/managed-host'

/** killWedgedHost is the only SIGKILL path: it must re-verify pid, birth and ownership. */
describe('ManagedSessionHost.killWedgedHost', () => {
  const roots: string[] = []
  let platformDescriptor: PropertyDescriptor | undefined
  let home: string | undefined
  let configDir: string | undefined
  let killSpy: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(() => {
    cp.execFileSync.mockReset()
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    home = process.env.HOME
    configDir = process.env.ADHDEV_CONFIG_DIR
  })
  afterEach(() => {
    killSpy?.mockRestore()
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home
    if (configDir === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = configDir
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function stage(appName: string, pid: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-kill-wedged-'))
    roots.push(dir)
    process.env.HOME = dir
    process.env.ADHDEV_CONFIG_DIR = path.join(dir, '.adhdev')
    fs.mkdirSync(process.env.ADHDEV_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(path.join(process.env.ADHDEV_CONFIG_DIR, `${appName}-session-host.pid`), String(pid))
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as any)
    cp.execFileSync.mockImplementation((file: string) => file === 'taskkill' ? ''
      : `node /opt/adhdev/vendor/session-host-daemon/index.js serve ${sessionHostInstanceArg(process.env.ADHDEV_CONFIG_DIR!)}`)
  }
  const taskkills = () => cp.execFileSync.mock.calls.filter((c) => c[0] === 'taskkill')

  it('signals the recorded host when pid, birth and managed command line all match', () => {
    const appName = `adhdev-wedge-ok-${process.pid}-${Date.now()}`
    stage(appName, 31001)
    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], isManagedPid: () => true })
    expect(host.killWedgedHost({ pid: 31001, birth: null })).toBe(true)
    expect(taskkills()).toHaveLength(1)
  })

  it('refuses a replaced host (different pid or birth) and an unmanaged pid', () => {
    const appName = `adhdev-wedge-refuse-${process.pid}-${Date.now()}`
    stage(appName, 31002)
    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], isManagedPid: () => true })
    expect(host.killWedgedHost({ pid: 31999, birth: null })).toBe(false)
    expect(host.killWedgedHost({ pid: 31002, birth: 'Mon Nov  3 08:00:00 2026' })).toBe(false)
    const unmanaged = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], isManagedPid: () => false })
    expect(unmanaged.killWedgedHost({ pid: 31002, birth: null })).toBe(false)
    expect(taskkills()).toHaveLength(0)
  })

  it('exposes the recorded identity only for a live pidfile pid', () => {
    const appName = `adhdev-wedge-ident-${process.pid}-${Date.now()}`
    stage(appName, 31003)
    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], isManagedPid: () => true })
    expect(host.getHostProcessIdentity()).toEqual({ pid: 31003, birth: null })
    killSpy!.mockImplementation(((_pid: number, sig?: any) => {
      if (sig === 0) { const e: NodeJS.ErrnoException = new Error('ESRCH'); e.code = 'ESRCH'; throw e }
      return true
    }) as any)
    expect(host.getHostProcessIdentity()).toBeNull()
  })
})
