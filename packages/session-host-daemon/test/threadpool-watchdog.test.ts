import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exitWithoutThreadpoolJoin, startThreadpoolWatchdog } from '../src/threadpool-watchdog.js'

// A wedged libuv pool left a live host acknowledging send_input while no PTY
// write ever completed. The watchdog must report a probe that never finishes,
// and must stay silent while probes keep completing.

test('threadpool watchdog stays silent while probes complete', () => {
  let clock = 0
  const stalls: number[] = []
  const watchdog = startThreadpoolWatchdog({
    intervalMs: 60_000,
    stallMs: 1_000,
    now: () => clock,
    probe: (done) => done(),
    onStall: (ms) => stalls.push(ms),
  })
  try {
    for (let i = 0; i < 20; i++) {
      clock += 5_000
      watchdog.tick()
    }
    assert.deepEqual(stalls, [])
  } finally {
    watchdog.stop()
  }
})

test('threadpool watchdog reports a probe stuck past stallMs exactly once', () => {
  let clock = 0
  let probes = 0
  const stalls: number[] = []
  const watchdog = startThreadpoolWatchdog({
    intervalMs: 60_000,
    stallMs: 1_000,
    now: () => clock,
    probe: () => { probes += 1 }, // never calls done
    onStall: (ms) => stalls.push(ms),
  })
  try {
    watchdog.tick() // starts the probe at t=0
    clock = 999
    watchdog.tick()
    assert.deepEqual(stalls, [], 'reported before stallMs elapsed')
    clock = 1_500
    watchdog.tick()
    clock = 5_000
    watchdog.tick()
    assert.deepEqual(stalls, [1_500])
    assert.equal(probes, 1, 'started another probe while one was in flight')
  } finally {
    watchdog.stop()
  }
})

test('threadpool watchdog tolerates a slow probe that completes before stallMs', () => {
  let clock = 0
  let finish: (() => void) | null = null
  const stalls: number[] = []
  const watchdog = startThreadpoolWatchdog({
    intervalMs: 60_000,
    stallMs: 1_000,
    now: () => clock,
    probe: (done) => { finish = done },
    onStall: (ms) => stalls.push(ms),
  })
  try {
    watchdog.tick()
    clock = 900
    finish!()
    clock = 2_000
    watchdog.tick() // a fresh probe starts here
    clock = 2_500
    watchdog.tick()
    assert.deepEqual(stalls, [])
  } finally {
    watchdog.stop()
  }
})

test('threadpool watchdog default probe completes on a healthy pool', async () => {
  const stalls: number[] = []
  const watchdog = startThreadpoolWatchdog({ intervalMs: 60_000, stallMs: 2_000, onStall: (ms) => stalls.push(ms) })
  try {
    watchdog.tick()
    await new Promise((resolve) => setTimeout(resolve, 300))
    watchdog.tick() // no probe in flight anymore: starts a new one, does not report
    await new Promise((resolve) => setTimeout(resolve, 300))
    watchdog.tick()
    assert.deepEqual(stalls, [])
  } finally {
    watchdog.stop()
  }
})

// process.exit joins the pool threads, so with a wedged pool the host stays alive serving
// nothing and the daemon never respawns it (2026-11-02). The stall path must not use it.
test('the stall exit does not go through process.exit', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const stall = src.slice(src.indexOf('onStall:'), src.indexOf('Fallback: flush persistence'))
  assert.match(stall, /exitWithoutThreadpoolJoin\(\)/)
  assert.doesNotMatch(stall, /process\.exit/)
})

test('exitWithoutThreadpoolJoin sends SIGKILL to this process', () => {
  const calls: Array<[number, string]> = []
  exitWithoutThreadpoolJoin((pid, signal) => { calls.push([pid, signal]) })
  assert.deepEqual(calls, [[process.pid, 'SIGKILL']])
})

test('a SIGKILL exit ends a process whose exit handlers would otherwise run', () => {
  const r = spawnSync(process.execPath, ['-e', "process.on('exit',()=>console.log('ran'));process.kill(process.pid,'SIGKILL');setTimeout(()=>{},5000)"], { encoding: 'utf8', timeout: 4000, windowsHide: true })
  assert.equal(r.signal, 'SIGKILL')
  assert.equal(r.stdout, '')
})

// Synthetic mechanism test, not a claim about the original production trigger.
// Only these fixture children are terminated; no daemon or shared host is used.
test('shutdown deadline exits a child with a blocked pool; process.exit alone cannot', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-host-exit-pool-'))
  const fifo = join(dir, 'blocked-open')
  execFileSync('mkfifo', [fifo], { timeout: 5_000, windowsHide: true })
  const prefix = `const fs=require('node:fs');fs.open(${JSON.stringify(fifo)},'r',()=>{});`
  const env = { ...process.env, ADHDEV_CONFIG_DIR: dir, UV_THREADPOOL_SIZE: '1' }
  const ordinary = spawnSync(process.execPath, ['-e', prefix + "setTimeout(()=>{fs.writeSync(1,'deadline fired');process.exit(0)},100)"],
    { env, encoding: 'utf8', timeout: 1_000, killSignal: 'SIGKILL', windowsHide: true })
  assert.equal(ordinary.stdout, 'deadline fired')
  assert.equal((ordinary.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT', 'fixture must reproduce the join hang')
  const forced = spawnSync(process.execPath, ['-e', prefix + `setTimeout(()=>{fs.writeSync(1,'flushed');(${exitWithoutThreadpoolJoin.toString()})()},100)`],
    { env, encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL', windowsHide: true })
  assert.equal(forced.error, undefined)
  assert.equal(forced.signal, 'SIGKILL')
  assert.equal(forced.stdout, 'flushed')
})
