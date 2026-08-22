/**
 * Inherited-config-dir occupancy warning (standalone bootstrap).
 *
 * The defect this pins: a dev shell exporting
 * ADHDEV_CONFIG_DIR=~/.adhdev-preview hands `npm run dev:standalone` the LIVE
 * preview daemon's state dir. pinStandaloneConfigDir honors that value ON
 * PURPOSE (power users may share one dir), and nothing said so — so the dev
 * process silently wrote the live daemon's provider store, and a whole-file
 * rewrite of meshes.json / mesh-coordinators.json / config.json or a ledger
 * retention pass would have been just as silent.
 *
 * Contract: WARN, never refuse. These tests therefore pin BOTH directions —
 * that the hazardous case is announced, and that every legitimate override
 * stays quiet (the over-correction guard).
 *
 * IMPORTANT: this file must never touch the real ~/.adhdev(-preview). Every
 * case builds a mkdtemp fixture and passes an explicit env object; the
 * module-level bootstrap side effect is not exercised here.
 */

import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { warnIfInheritedConfigDirIsOccupied } from '../src/bootstrap-config-dir'

/** Fixture config dir, optionally occupied by a live-looking daemon pid file. */
function makeConfigDir(pidFile?: { name: string; pid: number }): string {
  const dir = mkdtempSync(join(tmpdir(), 'adhdev-standalone-occupancy-'))
  if (pidFile) {
    // process.pid is genuinely alive, so the real signal-0 liveness probe
    // inside detectOccupiedConfigDir resolves true without mocking it — and
    // we pass a pid that is NOT our own by using the parent pid when needed.
    writeFileSync(join(dir, pidFile.name), String(pidFile.pid), 'utf-8')
  }
  return dir
}

const captured: string[] = []
const capture = (line: string): void => { captured.push(line) }

test('warns when an INHERITED config dir is occupied by a live daemon', () => {
  // ppid is alive and is not this process, so it stands in for the live daemon.
  const livePid = process.ppid
  const dir = makeConfigDir({ name: 'daemon-19223.pid', pid: livePid })
  try {
    captured.length = 0
    const warned = warnIfInheritedConfigDirIsOccupied(
      dir,
      { ADHDEV_CONFIG_DIR: dir },
      capture,
    )
    assert.equal(warned, true, 'occupied inherited dir must warn')
    assert.equal(captured.length, 1)
    // Attributable or it repeats the misdiagnosis the fix exists to prevent.
    assert.match(captured[0], new RegExp(String(livePid)))
    assert.match(captured[0], /meshes\.json/)
    assert.match(captured[0], /ADHDEV_ALLOW_TRACK_MISMATCH=1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stays silent when the inherited dir is NOT occupied — the ordinary, supported override', () => {
  const dir = makeConfigDir()
  try {
    captured.length = 0
    const warned = warnIfInheritedConfigDirIsOccupied(dir, { ADHDEV_CONFIG_DIR: dir }, capture)
    assert.equal(warned, false)
    assert.equal(captured.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stays silent for the self-chosen ~/.adhdev-standalone default even if occupied (not inherited)', () => {
  // Nothing was inherited: env has no ADHDEV_CONFIG_DIR matching this dir, so a
  // second standalone in its OWN dir is an ordinary port conflict, not the
  // cross-process hazard this warning is about.
  const dir = makeConfigDir({ name: 'daemon.pid', pid: process.ppid })
  try {
    captured.length = 0
    const warned = warnIfInheritedConfigDirIsOccupied(dir, {}, capture)
    assert.equal(warned, false)
    assert.equal(captured.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stays silent when the operator opted in with ADHDEV_ALLOW_TRACK_MISMATCH=1', () => {
  const dir = makeConfigDir({ name: 'daemon-19223.pid', pid: process.ppid })
  try {
    captured.length = 0
    const warned = warnIfInheritedConfigDirIsOccupied(
      dir,
      { ADHDEV_CONFIG_DIR: dir, ADHDEV_ALLOW_TRACK_MISMATCH: '1' },
      capture,
    )
    assert.equal(warned, false, 'the documented opt-in must silence the warning')
    assert.equal(captured.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pinStandaloneConfigDir still honors an inherited value (warning must not change resolution)', async () => {
  const { pinStandaloneConfigDir } = await import('../src/bootstrap-config-dir')
  const dir = makeConfigDir({ name: 'daemon-19223.pid', pid: process.ppid })
  try {
    const env: NodeJS.ProcessEnv = { ADHDEV_CONFIG_DIR: dir }
    // The inheritance itself is deliberate and stays: detection is additive.
    assert.equal(pinStandaloneConfigDir(env, '/nonexistent-home'), dir)
    assert.equal(env.ADHDEV_CONFIG_DIR, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
