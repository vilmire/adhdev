import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolvePendingLaunchTargetFromStatusEvent } from '../../src/hooks/useDashboardPendingLaunch'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard pending launch boundary cleanup', () => {
  it('moves pending launch tracking and matching effects out of Dashboard root into a dedicated hook', () => {
    const dashboardSource = readSource('pages/Dashboard.tsx')

    expect(dashboardSource).not.toContain('interface PendingDashboardLaunch')
    expect(dashboardSource).not.toContain('const [pendingDashboardLaunch')
    expect(dashboardSource).not.toContain('setPendingDashboardLaunch(')
    expect(dashboardSource).not.toContain('function getRouteMachineId(')
    expect(dashboardSource).not.toContain('function normalizeWorkspacePath(')
    expect(dashboardSource).toContain('useDashboardPendingLaunch(')
  })

  it('resolves pending launch directly from canonical completion events without waiting for a refreshed status snapshot', () => {
    const launch = {
      machineId: 'machine-1',
      kind: 'cli',
      providerType: 'hermes-cli',
      workspacePath: '/Users/me/project',
      startedAt: 1000,
    } as const

    const conversations = [{
      routeId: 'route-1',
      sessionId: 'runtime-session-1',
      providerSessionId: 'provider-session-1',
      tabKey: 'provider-session-1',
      agentName: 'Hermes',
      agentType: 'hermes-cli',
      status: 'idle',
      title: 'Hermes',
      messages: [],
      workspaceName: 'project',
      displayPrimary: 'Hermes',
      displaySecondary: 'project',
      streamSource: 'agent-stream',
    }] as any

    expect(resolvePendingLaunchTargetFromStatusEvent(launch, {
      event: 'agent:generating_completed',
      timestamp: 2000,
      daemonId: 'machine-1:daemon',
      providerType: 'hermes-cli',
      targetSessionId: 'runtime-session-1',
      providerSessionId: 'provider-session-1',
      workspaceName: '/Users/me/project',
    }, conversations)).toBe('provider-session-1')
  })

  it('does not resolve a provider-priority launch from another provider completion event', () => {
    const launch = {
      machineId: 'machine-1',
      kind: 'cli',
      providerType: 'hermes-cli',
      startedAt: 1000,
    } as const

    expect(resolvePendingLaunchTargetFromStatusEvent(launch, {
      event: 'agent:generating_completed',
      timestamp: 2000,
      daemonId: 'machine-1:daemon',
      providerType: 'claude-cli',
      targetSessionId: 'runtime-session-1',
    }, [])).toBeNull()
  })
})
