import { afterEach, describe, expect, it } from 'vitest'
import { getRecentLogs, LOG, setLogLevel } from '../../src/logging/logger'

function uniqueMessage(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

describe('daemon logger noise filtering', () => {
  afterEach(() => {
    setLogLevel('info')
  })

  it('does not retain debug hot-path logs when the daemon is running at the default info level', () => {
    setLogLevel('info')
    const message = uniqueMessage('hidden-debug-hotpath')

    LOG.debug('NoiseGuard', message)

    expect(getRecentLogs(200, 'debug')).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'NoiseGuard', message }),
      ]),
    )
  })

  it('retains debug logs when debug level is explicitly enabled', () => {
    setLogLevel('debug')
    const message = uniqueMessage('visible-debug-hotpath')

    LOG.debug('NoiseGuard', message)

    expect(getRecentLogs(200, 'debug')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'debug', category: 'NoiseGuard', message }),
      ]),
    )
  })
})
