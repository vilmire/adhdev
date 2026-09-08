// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDashboardMobileMachineLauncher } from '../../src/components/dashboard/useDashboardMobileMachineLauncher'
import { TransportProvider } from '../../src/context/TransportContext'
import { useGitRemoteUrl } from '../../src/hooks/useGitRemoteUrl'
import { useMachineDiagnosticsStreams } from '../../src/hooks/useMachineDiagnosticsStreams'
import { useWorkspaceGitStatus } from '../../src/hooks/useWorkspaceGitStatus'
import type { DaemonData } from '../../src/types'

vi.mock('../../src/hooks/useDaemonMetadataLoader', () => ({
  useDaemonMetadataLoader: () => async () => {},
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function machine(id: string): DaemonData {
  return {
    id,
    machineId: id,
    type: 'adhdev-daemon',
    status: 'online',
    platform: 'darwin',
    detectedIdes: [],
    availableProviders: [],
    workspaces: [],
    recentLaunches: [],
    defaultWorkspaceId: null,
    defaultWorkspacePath: null,
  } as DaemonData
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('request-generation guards', () => {
  it('drops a stale git remote response after the workspace changes', async () => {
    const requestA = deferred<any>()
    const requestB = deferred<any>()
    const sendCommand = vi.fn((_daemonId: string, _type: string, payload?: { workspace?: string }) => (
      payload?.workspace === '/repo/a' ? requestA.promise : requestB.promise
    ))
    let latest: ReturnType<typeof useGitRemoteUrl> | null = null

    function Probe({ workspace }: { workspace: string }) {
      latest = useGitRemoteUrl('daemon-1', workspace)
      return null
    }

    act(() => root.render(
      <TransportProvider value={{ sendCommand }}><Probe workspace="/repo/a" /></TransportProvider>,
    ))
    act(() => root.render(
      <TransportProvider value={{ sendCommand }}><Probe workspace="/repo/b" /></TransportProvider>,
    ))

    await act(async () => {
      requestB.resolve({ result: { remoteUrl: 'git@github.com:owner/repo-b.git' } })
      await flush()
    })
    expect(latest?.githubUrl).toBe('https://github.com/owner/repo-b')

    await act(async () => {
      requestA.resolve({ result: { remoteUrl: 'git@github.com:owner/repo-a.git' } })
      await flush()
    })
    expect(latest?.githubUrl).toBe('https://github.com/owner/repo-b')
    expect(latest?.loading).toBe(false)
  })

  it('drops a stale git status response after the workspace changes', async () => {
    const requestA = deferred<any>()
    const requestB = deferred<any>()
    const sendCommand = vi.fn((_daemonId: string, type: string, payload?: { workspace?: string }) => {
      if (type !== 'git_status') return Promise.resolve({ success: true })
      return payload?.workspace === '/repo/a' ? requestA.promise : requestB.promise
    })
    let latest: ReturnType<typeof useWorkspaceGitStatus> | null = null

    function Probe({ workspace }: { workspace: string }) {
      latest = useWorkspaceGitStatus({ daemonId: 'daemon-1', workspace })
      return null
    }

    act(() => root.render(
      <TransportProvider value={{ sendCommand }}><Probe workspace="/repo/a" /></TransportProvider>,
    ))
    act(() => root.render(
      <TransportProvider value={{ sendCommand }}><Probe workspace="/repo/b" /></TransportProvider>,
    ))

    await act(async () => {
      requestB.resolve({ result: { success: true, status: { workspace: '/repo/b', isGitRepo: true, lastCheckedAt: 20 } } })
      await flush()
    })
    expect(latest?.status?.workspace).toBe('/repo/b')

    await act(async () => {
      requestA.resolve({ result: { success: true, status: { workspace: '/repo/a', isGitRepo: true, lastCheckedAt: 10 } } })
      await flush()
    })
    expect(latest?.status?.workspace).toBe('/repo/b')
    expect(latest?.loading).toBe(false)
  })

  it('drops stale machine diagnostics without poisoning the next incremental cursor', async () => {
    const pending = new Map([
      ['machine-a:get_logs', deferred<any>()],
      ['machine-a:get_debug_trace', deferred<any>()],
      ['machine-b:get_logs', deferred<any>()],
      ['machine-b:get_debug_trace', deferred<any>()],
    ])
    const calls: Array<{ machineId: string; type: string; data?: Record<string, unknown> }> = []
    const sendDaemonCommand = vi.fn((machineId: string, type: string, data?: Record<string, unknown>) => {
      calls.push({ machineId, type, data })
      return pending.get(`${machineId}:${type}`)?.promise ?? Promise.resolve({ success: true })
    })
    let latest: ReturnType<typeof useMachineDiagnosticsStreams> | null = null

    function Probe({ machineId }: { machineId: string }) {
      latest = useMachineDiagnosticsStreams({ machineId, sendDaemonCommand })
      return null
    }

    act(() => root.render(<Probe machineId="machine-a" />))
    act(() => root.render(<Probe machineId="machine-b" />))

    await act(async () => {
      pending.get('machine-b:get_logs')?.resolve({ success: true, logs: [{ ts: 20, level: 'info', category: 'b', message: 'B log' }] })
      pending.get('machine-b:get_debug_trace')?.resolve({ success: true, trace: [{ id: 'trace-b', ts: 20, category: 'b', stage: 'done', level: 'info' }] })
      await flush()
    })
    expect(latest?.daemonLogs.map(entry => entry.message)).toEqual(['[b] B log'])
    expect(latest?.debugTrace.map(entry => entry.id)).toEqual(['trace-b'])

    await act(async () => {
      pending.get('machine-a:get_logs')?.resolve({ success: true, logs: [{ ts: 1_000, level: 'info', category: 'a', message: 'A log' }] })
      pending.get('machine-a:get_debug_trace')?.resolve({ success: true, trace: [{ id: 'trace-a', ts: 1_000, category: 'a', stage: 'done', level: 'info' }] })
      await flush()
    })
    expect(latest?.daemonLogs.map(entry => entry.message)).toEqual(['[b] B log'])
    expect(latest?.debugTrace.map(entry => entry.id)).toEqual(['trace-b'])

    act(() => latest?.refresh())
    const lastBLogCall = calls.filter(call => call.machineId === 'machine-b' && call.type === 'get_logs').at(-1)
    expect(lastBLogCall?.data?.since).toBe(20)
  })

  it('drops stale mobile saved-session responses after the machine changes', async () => {
    const requestA = deferred<any[]>()
    const requestB = deferred<any[]>()
    let latest: ReturnType<typeof useDashboardMobileMachineLauncher> | null = null

    function Probe({ machineId }: { machineId: string }) {
      latest = useDashboardMobileMachineLauncher({
        selectedMachineEntry: machine(machineId),
        cliProviders: [],
        acpProviders: [],
        machineAction: { state: 'idle', message: '' },
        onBrowseDirectory: async (path) => ({ path, directories: [] }),
        onListSavedSessions: () => machineId === 'machine-a' ? requestA.promise : requestB.promise,
      })
      return null
    }

    act(() => root.render(<Probe machineId="machine-a" />))
    act(() => latest?.openLaunchConfirm({
      title: 'A', description: 'A', details: [], confirmLabel: 'Launch', providerType: 'claude',
    }, async () => {}))
    act(() => root.render(<Probe machineId="machine-b" />))
    act(() => latest?.openLaunchConfirm({
      title: 'B', description: 'B', details: [], confirmLabel: 'Launch', providerType: 'claude',
    }, async () => {}))

    await act(async () => {
      requestB.resolve([{ providerSessionId: 'session-b' }])
      await flush()
    })
    expect(latest?.launchConfirmSavedSessions.map(session => session.providerSessionId)).toEqual(['session-b'])

    await act(async () => {
      requestA.resolve([{ providerSessionId: 'session-a' }])
      await flush()
    })
    expect(latest?.launchConfirmSavedSessions.map(session => session.providerSessionId)).toEqual(['session-b'])
    expect(latest?.launchConfirmSessionsLoading).toBe(false)
  })

  it('drops stale mobile directory responses after the machine changes', async () => {
    const requestA = deferred<any>()
    const requestB = deferred<any>()
    let latest: ReturnType<typeof useDashboardMobileMachineLauncher> | null = null

    function Probe({ machineId }: { machineId: string }) {
      latest = useDashboardMobileMachineLauncher({
        selectedMachineEntry: machine(machineId),
        cliProviders: [],
        acpProviders: [],
        machineAction: { state: 'idle', message: '' },
        onBrowseDirectory: () => machineId === 'machine-a' ? requestA.promise : requestB.promise,
      })
      return null
    }

    act(() => root.render(<Probe machineId="machine-a" />))
    act(() => { void latest?.loadBrowsePath('/repo/a') })
    act(() => root.render(<Probe machineId="machine-b" />))
    act(() => { void latest?.loadBrowsePath('/repo/b') })

    await act(async () => {
      requestB.resolve({ path: '/repo/b', directories: [{ name: 'b', path: '/repo/b/b' }] })
      await flush()
    })
    expect(latest?.browseCurrentPath).toBe('/repo/b')

    await act(async () => {
      requestA.resolve({ path: '/repo/a', directories: [{ name: 'a', path: '/repo/a/a' }] })
      await flush()
    })
    expect(latest?.browseCurrentPath).toBe('/repo/b')
    expect(latest?.browseBusy).toBe(false)
  })
})
