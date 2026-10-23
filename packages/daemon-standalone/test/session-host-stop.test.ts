import { createHash } from 'node:crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as url from 'url'
import { test, type TestContext } from 'node:test'
import * as assert from 'node:assert/strict'
import { createRequire } from 'module'
// Leaf import, NOT the '@adhdev/daemon-core' root barrel. The barrel
// re-exports logging/logger.js, whose module scope eagerly resolves the log dir
// at import time (the same hazard daemon-core's tsup.config.ts calls out for the
// standalone bootstrap). A static barrel import is hoisted above every test
// body, so that resolution ran while HOME/ADHDEV_CONFIG_DIR still pointed at the
// real home — tripping the config-dir isolation guard ("reached the real-home
// fallback in a test runtime") before pinTempInstance could relocate them, and
// failing the whole FILE at load rather than any single test. That is why CI saw
// `not ok 3 - test/session-host-stop.test.ts` with no failing subtest under it.
// config/instance-context.js pulls in only config-dir + app-name +
// track-identity, none of which touch the logger. Relative src path (not a
// package subpath) because daemon-core's `exports` map is closed and publishes
// no './config/instance-context' entry — see startup-restore-policy.test.ts.
import { resetProcessInstanceContextForTests } from '../../daemon-core/src/config/instance-context.js'

// Keep the fixture independent of daemon-core's logger until pinTempInstance runs.
const sessionHostInstanceArg = (configDir: string) =>
  `--instance-config-key=${createHash('sha256').update(path.resolve(configDir)).digest('hex')}`

const require = createRequire(path.join(process.cwd(), 'test/session-host-stop.test.ts'))
const childProcessModule = require('child_process') as typeof import('child_process')

const INSTANCE_ENV_KEYS = ['ADHDEV_SESSION_HOST_NAME', 'ADHDEV_CONFIG_DIR', 'HOME', 'USERPROFILE'] as const

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-standalone-session-host-'))
}

async function importSessionHostModule() {
  const moduleUrl = url.pathToFileURL(path.resolve(process.cwd(), 'src/session-host.ts'))
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random()}`)
  const loaded = await import(moduleUrl.href)
  return ((loaded as { default?: unknown }).default ?? loaded) as typeof import('../src/session-host.js')
}

type InstanceEnvSnapshot = Array<readonly [(typeof INSTANCE_ENV_KEYS)[number], string | undefined]>

function snapshotInstanceEnv(): InstanceEnvSnapshot {
  return INSTANCE_ENV_KEYS.map((key) => [key, process.env[key]] as const)
}

function restoreInstanceEnv(snapshot: InstanceEnvSnapshot): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/**
 * Pin the process instance context to a throwaway home/config dir and reset the
 * module-level getProcessInstanceContext() cache in @adhdev/daemon-core before
 * AND after the test. The cache is keyed on (ADHDEV_CONFIG_DIR, homedir, role)
 * and lives in the shared daemon-core module instance, so without an explicit
 * reset one subtest's temp home leaks into the next — and a hostile inherited
 * ADHDEV_CONFIG_DIR/HOME (e.g. from a parent adhdev process) silently redirects
 * the pid-file path outside the test's temp home.
 */
function pinTempInstance(t: TestContext, homeDir: string): void {
  const snapshot = snapshotInstanceEnv()
  process.env.ADHDEV_SESSION_HOST_NAME = 'adhdev-standalone-test'
  process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  resetProcessInstanceContextForTests()

  t.after(() => {
    restoreInstanceEnv(snapshot)
    resetProcessInstanceContextForTests()
    fs.rmSync(homeDir, { recursive: true, force: true })
  })
}

function writePidFile(homeDir: string, pid: number): string {
  const configDir = path.join(homeDir, '.adhdev')
  fs.mkdirSync(configDir, { recursive: true })
  const pidFile = path.join(configDir, 'adhdev-standalone-test-session-host.pid')
  fs.writeFileSync(pidFile, `${pid}\n`, 'utf8')
  return pidFile
}

type KillCall = [number, NodeJS.Signals | number | undefined]

/**
 * Install a `process.kill` mock that models the real kernel contract rather
 * than blanket-returning `true`.
 *
 * This matters because `stopManagedSessionHostProcess` probes liveness with
 * `process.kill(pid, 0)` after the SIGTERM and RETAINS the pidfile when the
 * process is still alive (daemon-core `7096da10`). Signal 0 delivers nothing —
 * it is purely an existence/permission check — and it THROWS `ESRCH` once the
 * process is gone. A mock that always returns `true` therefore claims every pid
 * is immortal, which is precisely the state the retention branch exists for,
 * and no test could ever observe an ordinary successful stop.
 *
 * `survivesSigterm` picks which of the two real outcomes to stage:
 *   - `false` (default): SIGTERM works, the pid is then dead, signal 0 throws
 *     ESRCH, and the pidfile is deleted — the ordinary stop.
 *   - `true`: the pid outlives SIGTERM, signal 0 succeeds, and the pidfile is
 *     kept so the next `ensureReady` stale-host guard can still see the zombie.
 */
function mockProcessKill(
  t: TestContext,
  options: { survivesSigterm?: boolean; mockCommandLine?: boolean } = {},
): KillCall[] {
  const survivesSigterm = options.survivesSigterm ?? false
  const mockCommandLine = options.mockCommandLine ?? true
  const killCalls: KillCall[] = []
  const dead = new Set<number>()

  if (mockCommandLine) {
    t.mock.method(childProcessModule, 'execFileSync', (((file: string, args: readonly string[] = []) => {
      if (file === 'ps' || file === '/bin/ps' || file === 'powershell.exe') {
        const pidArg = Number.parseInt(String(args.at(-1) ?? ''), 10)
        if ([4242, 5151, 6161, 7171].includes(pidArg) || file === 'powershell.exe') {
          return `/usr/bin/node /opt/adhdev/vendor/session-host-daemon/index.js serve ${sessionHostInstanceArg(process.env.ADHDEV_CONFIG_DIR!)}\n`
        }
      }
      return ''
    }) as unknown) as typeof childProcessModule.execFileSync)
  }

  t.mock.method(process, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => {
    killCalls.push([pid, signal])
    if (dead.has(pid)) {
      const error: NodeJS.ErrnoException = new Error(`kill ESRCH`)
      error.code = 'ESRCH'
      error.errno = -3
      error.syscall = 'kill'
      throw error
    }
    // Signal 0 is a probe: it reports existence and never terminates.
    if (signal !== 0 && !survivesSigterm) dead.add(pid)
    return true
  }) as typeof process.kill)

  return killCalls
}

test('stopSessionHost only targets the current namespace pid file and does not sweep unrelated session-host processes', async (t) => {
  const homeDir = makeTempHome()
  pinTempInstance(t, homeDir)

  const { stopSessionHost } = await importSessionHostModule()
  const execCalls: Array<[string, string[]]> = []

  t.mock.method(childProcessModule, 'execFileSync', (((command: string, args: readonly string[] = []) => {
    execCalls.push([command, [...args]])
    throw new Error('unexpected execFileSync call')
  }) as unknown) as typeof childProcessModule.execFileSync)
  const killCalls = mockProcessKill(t, { mockCommandLine: false })

  assert.equal(stopSessionHost(), false)
  assert.deepEqual(execCalls, [])
  assert.deepEqual(killCalls, [])
})

test('stopSessionHost still stops the pid-file-owned process for the current namespace', async (t) => {
  const homeDir = makeTempHome()
  pinTempInstance(t, homeDir)
  const pidFile = writePidFile(homeDir, 5151)

  const { stopSessionHost } = await importSessionHostModule()
  const killCalls = mockProcessKill(t)

  assert.equal(stopSessionHost(), true)
  // SIGTERM to terminate, then signal 0 to check whether it actually died.
  assert.deepEqual(killCalls, [
    [5151, 'SIGTERM'],
    [5151, 0],
  ])
  // The pid died, so nothing is left to track and the pidfile is removed.
  assert.equal(fs.existsSync(pidFile), false)
})

test('stopSessionHost keeps the pid file when the host outlives SIGTERM', async (t) => {
  // The D1 stale-prefix guard in ensureReady() is entered ONLY via
  // getPid() !== null, so deleting the pidfile of a survivor is what let a
  // zombie session-host hold the socket across every restart with nothing
  // tracking it. A host that ignores SIGTERM must stay visible to that guard.
  const homeDir = makeTempHome()
  pinTempInstance(t, homeDir)
  const pidFile = writePidFile(homeDir, 7171)

  const { stopSessionHost } = await importSessionHostModule()
  const killCalls = mockProcessKill(t, { survivesSigterm: true })

  assert.equal(stopSessionHost(), true)
  assert.deepEqual(killCalls, [
    [7171, 'SIGTERM'],
    [7171, 0],
  ])
  assert.equal(fs.existsSync(pidFile), true)
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '7171')
})

test('stopSessionHost pid-file stop is repeatable back-to-back in the same process', async (t) => {
  const homeDir = makeTempHome()
  pinTempInstance(t, homeDir)
  const pidFile = writePidFile(homeDir, 6161)

  const { stopSessionHost } = await importSessionHostModule()
  const killCalls = mockProcessKill(t)

  assert.equal(stopSessionHost(), true)
  assert.deepEqual(killCalls, [
    [6161, 'SIGTERM'],
    [6161, 0],
  ])
  assert.equal(fs.existsSync(pidFile), false)

  // Second call: the pidfile is gone, so there is nothing left to signal.
  killCalls.length = 0
  assert.equal(stopSessionHost(), false)
  assert.deepEqual(killCalls, [])
})

test('stopSessionHost with no pid file still returns false after a pid-file scenario ran first', async (t) => {
  const homeDir = makeTempHome()
  pinTempInstance(t, homeDir)

  const { stopSessionHost } = await importSessionHostModule()
  const killCalls = mockProcessKill(t)

  assert.equal(stopSessionHost(), false)
  assert.deepEqual(killCalls, [])
})

test('stopSessionHost ignores a hostile inherited config dir/home even after it was cached first', async (t) => {
  // Phase 1: resolve and cache the process instance context under a hostile
  // inherited ADHDEV_CONFIG_DIR/HOME — exactly what a parent adhdev process
  // exports into the environment. The decoy pid file proves which config dir
  // the cached context actually resolves.
  const hostileHome = makeTempHome()
  const hostilePidFile = writePidFile(hostileHome, 4242)

  const snapshot = snapshotInstanceEnv()
  process.env.ADHDEV_SESSION_HOST_NAME = 'adhdev-standalone-test'
  process.env.ADHDEV_CONFIG_DIR = path.join(hostileHome, '.adhdev')
  process.env.HOME = hostileHome
  process.env.USERPROFILE = hostileHome
  resetProcessInstanceContextForTests()

  t.after(() => {
    restoreInstanceEnv(snapshot)
    resetProcessInstanceContextForTests()
    fs.rmSync(hostileHome, { recursive: true, force: true })
  })

  const { stopSessionHost } = await importSessionHostModule()
  const killCalls = mockProcessKill(t)

  assert.equal(stopSessionHost(), true)
  assert.deepEqual(killCalls, [
    [4242, 'SIGTERM'],
    [4242, 0],
  ])
  assert.equal(fs.existsSync(hostilePidFile), false)

  // Phase 2: pin an isolated temp instance (the same reset every test performs)
  // and prove the previously cached hostile context does not leak into it.
  const homeDir = makeTempHome()
  process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  resetProcessInstanceContextForTests()
  t.after(() => {
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  const pidFile = writePidFile(homeDir, 5151)
  killCalls.length = 0

  assert.equal(stopSessionHost(), true)
  assert.deepEqual(killCalls, [
    [5151, 'SIGTERM'],
    [5151, 0],
  ])
  assert.equal(fs.existsSync(pidFile), false)
})

test('M1: stopSessionHost refuses to kill a live unrelated process when a stale pidfile PID was recycled', async (t) => {
  const homeDir = makeTempHome()
  pinTempInstance(t, homeDir)

  const unrelatedChild = childProcessModule.spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 10000)', '--prompt', 'mention session-host-daemon in prompt'],
    { stdio: 'ignore', windowsHide: true },
  )
  t.after(() => {
    try { unrelatedChild.kill('SIGKILL') } catch { /* noop */ }
  })

  const pidFile = writePidFile(homeDir, unrelatedChild.pid!)
  const { stopSessionHost } = await importSessionHostModule()
  const killCalls = mockProcessKill(t, { mockCommandLine: false })

  assert.equal(stopSessionHost(), false, 'must not stop a positively identified unrelated process')
  assert.equal(
    killCalls.some(([pid, sig]) => pid === unrelatedChild.pid && sig === 'SIGTERM'),
    false,
    'must not send SIGTERM to recycled unrelated PID',
  )
  assert.equal(fs.existsSync(pidFile), false, 'stale pidfile for recycled unrelated PID must be removed')
})

test('L3: stopSessionHost does not send SIGTERM when the process command line cannot be read', async (t) => {
  const homeDir = makeTempHome()
  pinTempInstance(t, homeDir)
  const pidFile = writePidFile(homeDir, 8181)

  const { stopSessionHost } = await importSessionHostModule()
  t.mock.method(childProcessModule, 'execFileSync', ((() => '') as unknown) as typeof childProcessModule.execFileSync)
  const killCalls = mockProcessKill(t, { survivesSigterm: true, mockCommandLine: false })

  assert.equal(stopSessionHost(), false, 'must not claim stop when command line is unreadable')
  assert.equal(
    killCalls.some(([pid, sig]) => pid === 8181 && sig === 'SIGTERM'),
    false,
    'must not send SIGTERM to an unidentified PID whose command line could not be read',
  )
  assert.equal(fs.existsSync(pidFile), true, 'pidfile must be retained when process is alive and unverifiable')
})

for (const owner of ['stable', 'preview', 'legacy'] as const) {
  test(`preview standalone stop refuses ${owner} PID without matching instance argv`, async (t) => {
    const homeDir = makeTempHome()
    pinTempInstance(t, homeDir)
    const previewConfig = path.join(homeDir, '.adhdev-preview')
    process.env.ADHDEV_CONFIG_DIR = previewConfig
    resetProcessInstanceContextForTests()
    fs.mkdirSync(previewConfig, { recursive: true })
    fs.writeFileSync(path.join(previewConfig, 'adhdev-standalone-test-session-host.pid'), '4242')
    const host = await importSessionHostModule()
    const signals: KillCall[] = []
    t.mock.method(process, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      signals.push([pid, signal])
      return true
    }) as typeof process.kill)
    const key = owner === 'legacy' ? '' : sessionHostInstanceArg(owner === 'preview' ? previewConfig : path.join(homeDir, '.adhdev'))
    t.mock.method(childProcessModule, 'execFileSync', ((file: string) => {
      if (file === 'ps' || file === 'powershell.exe') return `node /opt/adhdev/vendor/session-host-daemon/index.js serve ${key}`
      return ''
    }) as typeof childProcessModule.execFileSync)
    assert.equal(host.stopSessionHost(), owner === 'preview')
    assert.deepEqual(signals, owner === 'preview' ? [[4242, 'SIGTERM']] : [])
  })
}
