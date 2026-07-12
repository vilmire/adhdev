import { describe, expect, it, vi } from 'vitest'
import { probeRemoteMeshGitStatusWithRetry } from '../../src/mesh/mesh-node-identity.js'
import { argsCarryStatusProbeMarker } from '@adhdev/mesh-shared'

// OFFLINE-NODE-STATUS-REFRESH: the daemon-core aggregate explicit_refresh path probes
// each remote peer's git_status via dispatchMeshCommand. It must stamp the status-origin
// marker so the daemon-cloud dispatch wrapper grants the SHORT connect-wait budget — an
// offline peer is then rejected in ~seconds instead of sinking the whole status assembly
// into the 90s connect deadline. This test pins that the marker reaches the dispatch.

describe('probeRemoteMeshGitStatus dispatch carries the status-origin marker', () => {
  it('stamps the git_status args with the status-probe marker on a connected peer', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({
      status: { isGitRepo: true, branch: 'main' },
    }))

    const git = await probeRemoteMeshGitStatusWithRetry({
      dispatchMeshCommand,
      daemonId: 'daemon_mach_abc',
      workspace: '/w',
      timeoutMs: 5_000,
      // Report the peer as connected so the probe actually dispatches.
      getConnection: () => ({ state: 'connected' }),
    })

    expect(git).toMatchObject({ isGitRepo: true, branch: 'main' })
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    const [daemonId, command, args] = dispatchMeshCommand.mock.calls[0]
    expect(daemonId).toBe('daemon_mach_abc')
    expect(command).toBe('git_status')
    // The marker must be present so the cloud dispatch grants the short connect-wait.
    expect(argsCarryStatusProbeMarker(args)).toBe(true)
    // Real args survive alongside the marker.
    expect(args).toMatchObject({ workspace: '/w', refreshUpstream: true })
  })
})
