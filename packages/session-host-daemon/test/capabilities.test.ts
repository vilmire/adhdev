import test from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_HOST_SUPPORTED_REQUEST_TYPES } from '@adhdev/session-host-core'
import { SessionHostServer } from '../src/server.js'

test('advertises delete_session as a supported request type for cleanup compatibility probes', async () => {
  const server = new SessionHostServer({ appName: `adhdev-capabilities-${process.pid}` })

  const response = await server.handleRequest({
    type: 'get_host_diagnostics',
    payload: { includeSessions: false },
  })

  assert.equal(response.success, true)
  assert.ok((response.result as any).supportedRequestTypes.includes('delete_session'))
  assert.deepEqual((response.result as any).supportedRequestTypes, [...SESSION_HOST_SUPPORTED_REQUEST_TYPES])
})
