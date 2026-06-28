import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  selectWin32ExecutableMatch,
  quoteWin32CmdArg,
  buildWin32ExecFileSpawn,
  resolveWin32ExecFileSpawn,
  resolveWin32Executable,
} from '../../src/cli-adapters/resolve-executable'

// Mission REFINERY-WIN32-NPM-SPAWN: the two-layer win32 defect that surfaced as
//   Could not resolve executable "npm" (spawn ENOENT)
// (1) resolver returned the extensionless Unix wrapper `where` lists first, and
// (2) even an absolute `npm.cmd` cannot be launched by execFile without a
// cmd.exe wrapper. These pure-helper tests cover both layers deterministically
// on any host.

describe('selectWin32ExecutableMatch (Fix A — never return an extensionless wrapper)', () => {
  it('prefers a directly-launchable .exe/.com over a .cmd shim', () => {
    expect(
      selectWin32ExecutableMatch([
        'C:\\tools\\foo\\foo.cmd',
        'C:\\tools\\foo\\foo.exe',
      ]),
    ).toBe('C:\\tools\\foo\\foo.exe')
  })

  it('picks the .cmd shim, NOT the extensionless wrapper, for the real `where npm` shape', () => {
    // This is the exact, measured `where npm` output that broke refine: the
    // extensionless wrapper (a bash script, errno -4058 when exec'd) is listed
    // FIRST, so the old `matches[0]` fallback returned it.
    const selected = selectWin32ExecutableMatch([
      'C:\\Program Files\\nodejs\\npm',
      'C:\\Program Files\\nodejs\\npm.cmd',
    ])
    expect(selected).toBe('C:\\Program Files\\nodejs\\npm.cmd')
  })

  it('returns null when only extensionless wrappers match (caller falls through, never emits a dead path)', () => {
    expect(
      selectWin32ExecutableMatch([
        'C:\\Program Files\\nodejs\\npm',
        'C:\\some\\other\\npm',
      ]),
    ).toBeNull()
  })

  it('accepts .bat shims and trims/ignores blank lines', () => {
    expect(selectWin32ExecutableMatch(['', '  C:\\x\\thing.bat  ', ''])).toBe('C:\\x\\thing.bat')
    expect(selectWin32ExecutableMatch([])).toBeNull()
  })
})

describe('quoteWin32CmdArg (Fix B — per-argument cmd.exe quoting)', () => {
  it('leaves a plain token unquoted', () => {
    expect(quoteWin32CmdArg('run')).toBe('run')
    expect(quoteWin32CmdArg('test')).toBe('test')
  })

  it('quotes an empty argument as ""', () => {
    expect(quoteWin32CmdArg('')).toBe('""')
  })

  it('quotes an argument containing spaces (the shell:true gap — bare-space join would split it)', () => {
    expect(quoteWin32CmdArg('a b')).toBe('"a b"')
    expect(quoteWin32CmdArg('C:\\path with space\\x')).toBe('"C:\\path with space\\x"')
  })

  it('escapes embedded double-quotes', () => {
    expect(quoteWin32CmdArg('a"b')).toBe('"a\\"b"')
  })

  it('doubles backslashes that precede the closing quote', () => {
    // A space forces quoting; the trailing backslash then precedes the closing
    // quote and must be doubled so it is not read as an escape of that quote.
    expect(quoteWin32CmdArg('a \\')).toBe('"a \\\\"')
  })
})

describe('buildWin32ExecFileSpawn (Fix B — wrap .cmd/.bat, pass .exe through)', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  const originalComSpec = process.env.ComSpec
  const setPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value, configurable: true })

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  })
  afterEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    if (originalComSpec === undefined) delete process.env.ComSpec
    else process.env.ComSpec = originalComSpec
  })

  it('is a strict no-op off win32 — never wraps, never sets windowsVerbatimArguments (regression guard)', () => {
    setPlatform('linux')
    expect(buildWin32ExecFileSpawn('npm', ['run', 'test'])).toEqual({ file: 'npm', args: ['run', 'test'] })
    expect(buildWin32ExecFileSpawn('/usr/bin/foo.cmd', ['x'])).toEqual({ file: '/usr/bin/foo.cmd', args: ['x'] })
  })

  it('on win32 wraps a .cmd shim in cmd.exe /d /s /c with quoted, verbatim args', () => {
    setPlatform('win32')
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    const spawn = buildWin32ExecFileSpawn('C:\\Program Files\\nodejs\\npm.cmd', ['run', 'build me'])
    expect(spawn.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(spawn.windowsVerbatimArguments).toBe(true)
    expect(spawn.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    // The command line quotes the .cmd path (has a space) and the spacey arg,
    // then the whole line is wrapped in the outer pair cmd /s /c strips. No
    // embedded quotes in these tokens, so each is just double-quote wrapped.
    expect(spawn.args[3]).toBe('""C:\\Program Files\\nodejs\\npm.cmd" run "build me""')
  })

  it('on win32 passes a real .exe straight through (no cmd.exe wrapper, no verbatim flag)', () => {
    setPlatform('win32')
    const spawn = buildWin32ExecFileSpawn('C:\\Program Files\\Git\\cmd\\git.exe', ['status'])
    expect(spawn).toEqual({ file: 'C:\\Program Files\\Git\\cmd\\git.exe', args: ['status'] })
    expect(spawn.windowsVerbatimArguments).toBeUndefined()
  })

  it('falls back to cmd.exe when ComSpec is unset', () => {
    setPlatform('win32')
    delete process.env.ComSpec
    expect(buildWin32ExecFileSpawn('x.bat', []).file).toBe('cmd.exe')
  })
})

describe('resolveWin32ExecFileSpawn (resolve + wrap, keeps resolvedCommand for diagnostics)', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  })
  afterEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  })

  it('off win32 resolves to the bare command and does not wrap', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const spawn = resolveWin32ExecFileSpawn('npm', ['run', 'test'])
    expect(spawn.resolvedCommand).toBe('npm')
    expect(spawn.file).toBe('npm')
    expect(spawn.args).toEqual(['run', 'test'])
  })

  // Real-host coverage: on an actual win32 box, `npm` MUST resolve to a launchable
  // shim (a .cmd), never the extensionless wrapper, and the spawn spec must route
  // through cmd.exe. This is the end-to-end fix exercised against the real PATH.
  it.runIf(process.platform === 'win32')(
    'on a real win32 host resolves npm to a .cmd shim wrapped in cmd.exe',
    () => {
      const spawn = resolveWin32ExecFileSpawn('npm', ['--version'])
      expect(spawn.resolvedCommand.toLowerCase()).toMatch(/\.cmd$/)
      expect(resolveWin32Executable('npm').toLowerCase()).not.toBe('npm')
      expect(spawn.file.toLowerCase()).toMatch(/cmd\.exe$/)
      expect(spawn.windowsVerbatimArguments).toBe(true)
    },
  )
})
