import { describe, expect, it } from 'vitest'
import { SESSION_HOST_SUPPORTED_REQUEST_TYPES } from '@adhdev/session-host-core'
import { SessionHostServer } from '../src/server'

describe('session host diagnostics capabilities', () => {
  it('advertises delete_session as a supported request type for cleanup compatibility probes', async () => {
    const server = new SessionHostServer({ appName: `adhdev-capabilities-${process.pid}` })

    const response = await server.handleRequest({
      type: 'get_host_diagnostics',
      payload: { includeSessions: false },
    })

    expect(response.success).toBe(true)
    expect((response.result as any).supportedRequestTypes).toContain('delete_session')
    expect((response.result as any).supportedRequestTypes).toEqual([...SESSION_HOST_SUPPORTED_REQUEST_TYPES])
  })
})
