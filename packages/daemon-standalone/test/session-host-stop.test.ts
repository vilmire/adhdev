import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as url from 'url'
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createRequire } from 'module'

const require = createRequire(path.join(process.cwd(), 'test/session-host-stop.test.ts'))
const childProcessModule = require('child_process') as typeof import('child_process')

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-standalone-session-host-'))
}

async function importSessionHostModule() {
  const moduleUrl = url.pathToFileURL(path.resolve(process.cwd(), 'src/session-host.ts'))
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random()}`)
  const loaded = await import(moduleUrl.href)
  return ((loaded as { default?: unknown }).default ?? loaded) as typeof import('../src/session-host.js')
}

test('stopSessionHost only targets the current namespace pid file and does not sweep unrelated session-host processes', async (t) => {
  const homeDir = makeTempHome()
  const previousName = process.env.ADHDEV_SESSION_HOST_NAME
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  process.env.ADHDEV_SESSION_HOST_NAME = 'adhdev-standalone-test'
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir

  t.after(() => {
    if (previousName === undefined) delete process.env.ADHDEV_SESSION_HOST_NAME
    else process.env.ADHDEV_SESSION_HOST_NAME = previousName
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  const { stopSessionHost } = await importSessionHostModule()
  const execCalls: Array<[string, string[]]> = []
  const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = []

  t.mock.method(childProcessModule, 'execFileSync', (((command: string, args: readonly string[] = []) => {
    execCalls.push([command, [...args]])
    throw new Error('unexpected execFileSync call')
  }) as unknown) as typeof childProcessModule.execFileSync)
  t.mock.method(process, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => {
    killCalls.push([pid, signal])
    return true
  }) as typeof process.kill)

  assert.equal(stopSessionHost(), false)
  assert.deepEqual(execCalls, [])
  assert.deepEqual(killCalls, [])
})

test('stopSessionHost still stops the pid-file-owned process for the current namespace', async (t) => {
  const homeDir = makeTempHome()
  const adhdevDir = path.join(homeDir, '.adhdev')
  fs.mkdirSync(adhdevDir, { recursive: true })

  const previousName = process.env.ADHDEV_SESSION_HOST_NAME
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  process.env.ADHDEV_SESSION_HOST_NAME = 'adhdev-standalone-test'
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir

  t.after(() => {
    if (previousName === undefined) delete process.env.ADHDEV_SESSION_HOST_NAME
    else process.env.ADHDEV_SESSION_HOST_NAME = previousName
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  const pidFile = path.join(adhdevDir, 'adhdev-standalone-test-session-host.pid')
  fs.writeFileSync(pidFile, '5151\n', 'utf8')

  const { stopSessionHost } = await importSessionHostModule()
  const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = []

  t.mock.method(process, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => {
    killCalls.push([pid, signal])
    return true
  }) as typeof process.kill)

  assert.equal(stopSessionHost(), true)
  assert.deepEqual(killCalls, [[5151, 'SIGTERM']])
  assert.equal(fs.existsSync(pidFile), false)
})