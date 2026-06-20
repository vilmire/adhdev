import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { tokenizeCommandString, normalizeMeshCommandConfig } from '../../src/mesh/refine-config'

// B3: on win32 an absolute .cmd path (with backslashes) must be acceptable as
// the executable token, while true shell metacharacters stay rejected on every
// platform. Off win32, backslash remains rejected (no behavior change).
describe('refine-config win32 executable token (B3)', () => {
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  })
  afterEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  })

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }

  describe('tokenizeCommandString', () => {
    it('accepts a win32 absolute .cmd path as the executable token', () => {
      setPlatform('win32')
      const tokens = tokenizeCommandString('C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd run test')
      expect(tokens).toEqual(['C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd', 'run', 'test'])
    })

    it('rejects a backslash in a non-executable (argument) token on win32', () => {
      setPlatform('win32')
      // Backslash is only allowed in the first token; an arg with one is rejected.
      expect(tokenizeCommandString('npm run C:\\evil')).toBeNull()
    })

    it('rejects shell metacharacters even when the executable is a win32 path', () => {
      setPlatform('win32')
      expect(tokenizeCommandString('C:\\path\\npm.cmd && rm -rf /')).toBeNull()
      expect(tokenizeCommandString('C:\\path\\npm.cmd; whoami')).toBeNull()
      expect(tokenizeCommandString('C:\\path\\npm.cmd | cat')).toBeNull()
      expect(tokenizeCommandString('C:\\path\\npm.cmd `id`')).toBeNull()
      expect(tokenizeCommandString('C:\\path\\npm.cmd $HOME')).toBeNull()
    })

    it('still rejects backslash on non-win32 platforms', () => {
      setPlatform('linux')
      expect(tokenizeCommandString('C:\\path\\npm.cmd run test')).toBeNull()
    })

    it('keeps the forward-slash and bare-command paths working on win32', () => {
      setPlatform('win32')
      expect(tokenizeCommandString('npm run test')).toEqual(['npm', 'run', 'test'])
      expect(tokenizeCommandString('C:/path/npm.cmd run test')).toEqual(['C:/path/npm.cmd', 'run', 'test'])
    })
  })

  describe('normalizeMeshCommandConfig', () => {
    it('accepts an explicit win32 .cmd command with explicit args', () => {
      setPlatform('win32')
      const result = normalizeMeshCommandConfig(
        { command: 'C:\\path\\npm.cmd', args: ['run', 'test'], category: 'test' },
        'inline',
      )
      expect(result.rejected).toBeUndefined()
      expect(result.command?.command).toBe('C:\\path\\npm.cmd')
      expect(result.command?.args).toEqual(['run', 'test'])
    })

    it('rejects a compound win32 command string (metachar)', () => {
      setPlatform('win32')
      const result = normalizeMeshCommandConfig(
        { command: 'C:\\path\\npm.cmd && rm -rf /' },
        'inline',
      )
      expect(result.command).toBeUndefined()
      expect(result.rejected).toBeTruthy()
    })

    it('rejects a backslash command on non-win32', () => {
      setPlatform('linux')
      const result = normalizeMeshCommandConfig(
        { command: 'C:\\path\\npm.cmd', args: ['run', 'test'] },
        'inline',
      )
      expect(result.command).toBeUndefined()
      expect(result.rejected).toBeTruthy()
    })
  })
})
