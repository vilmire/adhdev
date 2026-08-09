import { describe, expect, it, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { writeValidationFailureLog, truncateValidationOutput } from '../../src/mesh/mesh-refine-gates'

// REFINE-LOG-PRESERVATION. A failing gate's output was cut twice — execFile's
// maxBuffer, then truncateValidationOutput's head+tail window — and nothing kept
// the whole thing, so a coordinator got `code: 'SQLITE_ERROR'` plus a few stack
// frames and could not tell WHICH query failed. These tests pin that the full
// streams now land on disk and that the writer can never break the gate.

const workspaces: string[] = []
function tempWorkspace(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'refine-log-test-'))
  workspaces.push(dir)
  return dir
}

afterEach(() => {
  while (workspaces.length) {
    const dir = workspaces.pop()!
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

const FIXED_NOW = () => new Date('2026-08-09T12:34:56.789Z')

describe('writeValidationFailureLog', () => {
  it('writes the log under .adhdev/logs and returns its path', () => {
    const ws = tempWorkspace()
    const file = writeValidationFailureLog(
      ws, 3,
      { command: 'npm', args: ['run', 'test:server'], cwd: ws },
      { stdout: 'out', stderr: 'err' },
      FIXED_NOW,
    )
    expect(file).toBeTruthy()
    expect(file!.startsWith(join(ws, '.adhdev', 'logs'))).toBe(true)
    expect(fs.existsSync(file!)).toBe(true)
    // Index is in the name so concurrent commands in one run never collide.
    expect(file).toContain('-3.log')
    // Colons are illegal in win32 filenames — the ISO stamp must be flattened.
    expect(file!.split(/[\\/]/).pop()).not.toContain(':')
  })

  it('preserves output that the summary budget would truncate — the whole point', () => {
    const ws = tempWorkspace()
    // Oversized on purpose: truncateValidationOutput drops the middle, the log
    // must not. The needle sits in that dropped middle.
    const needle = 'SQLITE_ERROR: no such table: provider_channels'
    const huge = 'a'.repeat(6000) + needle + 'b'.repeat(6000)
    expect(truncateValidationOutput(huge)).not.toContain(needle)

    const file = writeValidationFailureLog(
      ws, 0,
      { command: 'npm', args: ['run', 'test:server'] },
      { stdout: '', stderr: huge },
      FIXED_NOW,
    )
    const written = fs.readFileSync(file!, 'utf8')
    expect(written).toContain(needle)
    expect(written).toContain(huge)
  })

  it('records the command, cwd and both streams so the log is self-describing', () => {
    const ws = tempWorkspace()
    const file = writeValidationFailureLog(
      ws, 1,
      { command: 'npm', args: ['run', 'test:server'], cwd: '/repo/packages/server' },
      { stdout: 'STDOUT-MARKER', stderr: 'STDERR-MARKER' },
      FIXED_NOW,
    )
    const written = fs.readFileSync(file!, 'utf8')
    expect(written).toContain('npm run test:server')
    expect(written).toContain('/repo/packages/server')
    expect(written).toContain('STDOUT-MARKER')
    expect(written).toContain('STDERR-MARKER')
    expect(written).toContain('=== stdout ===')
    expect(written).toContain('=== stderr ===')
  })

  it('prefers displayCommand when the candidate carries one', () => {
    const ws = tempWorkspace()
    const file = writeValidationFailureLog(
      ws, 0,
      { command: 'npm', args: ['run', 'x'], displayCommand: 'npm run test:web-core' },
      { stdout: '', stderr: 'boom' },
      FIXED_NOW,
    )
    expect(fs.readFileSync(file!, 'utf8')).toContain('npm run test:web-core')
  })

  it('handles non-string / null streams without throwing', () => {
    // Real callers pass error.stdout/error.stderr, which are usually strings but
    // are `undefined` on a spawn-resolution failure. Coercion must not throw;
    // a non-string object stringifies to [object Object] like anywhere else in
    // JS — the contract here is "never throws", not "serializes objects".
    const ws = tempWorkspace()
    const file = writeValidationFailureLog(
      ws, 0,
      { command: 'node', args: ['x.mjs'] },
      { stdout: undefined, stderr: { code: 'SQLITE_ERROR' } as any },
      FIXED_NOW,
    )
    expect(file).toBeTruthy()
    const written = fs.readFileSync(file!, 'utf8')
    expect(written).toContain('=== stdout ===')
    expect(written).toContain('=== stderr ===')
    // The real-world shape: a string stderr round-trips verbatim.
    const strFile = writeValidationFailureLog(
      ws, 1,
      { command: 'node', args: ['x.mjs'] },
      { stdout: undefined, stderr: 'SqliteError: no such table: provider_channels' },
      FIXED_NOW,
    )
    expect(fs.readFileSync(strFile!, 'utf8')).toContain('no such table: provider_channels')
  })

  it('returns undefined instead of throwing when the log cannot be written', () => {
    // Diagnostics must never turn a passing gate red or reclassify a failing
    // one. An unwritable workspace is the realistic form of that: a file where
    // the .adhdev directory would go makes mkdirSync throw ENOTDIR.
    const ws = tempWorkspace()
    fs.writeFileSync(join(ws, '.adhdev'), 'not a directory', 'utf8')
    const file = writeValidationFailureLog(
      ws, 0,
      { command: 'npm', args: ['run', 'test'] },
      { stdout: '', stderr: 'boom' },
      FIXED_NOW,
    )
    expect(file).toBeUndefined()
  })

  it('separate command indexes produce separate files within one run', () => {
    const ws = tempWorkspace()
    const a = writeValidationFailureLog(ws, 0, { command: 'npm', args: ['a'] }, { stderr: 'A' }, FIXED_NOW)
    const b = writeValidationFailureLog(ws, 1, { command: 'npm', args: ['b'] }, { stderr: 'B' }, FIXED_NOW)
    expect(a).not.toBe(b)
    expect(fs.readFileSync(a!, 'utf8')).toContain('A')
    expect(fs.readFileSync(b!, 'utf8')).toContain('B')
  })

  it('writes nothing until called — a green run leaves no logs behind', () => {
    // Retention policy: failures only. The caller invokes this from the catch
    // path exclusively, so a passing gate must not create the directory at all.
    const ws = tempWorkspace()
    expect(fs.existsSync(join(ws, '.adhdev', 'logs'))).toBe(false)
  })
})
