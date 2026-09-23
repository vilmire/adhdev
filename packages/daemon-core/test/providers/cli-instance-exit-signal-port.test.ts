/**
 * B4: the CLI provider instance forwards the spec adapter's PTY-exit and
 * screen-signal reports to its SessionEventPort (replacing the deleted
 * shared/session-termination-sink + shared/provider-signal-sink). The port then
 * turns `exited` into registry.terminate(id, 'pty_exit') — exactly one
 * `terminated` — and `signal` into a bus `signal` event.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import type { SessionEventPort } from '../../src/sessions/session-port.js'

const live: any[] = []
afterEach(() => {
  for (const instance of live.splice(0)) {
    if (instance.generatingDebounceTimer) clearTimeout(instance.generatingDebounceTimer)
    if (instance.completedDebounceTimer) clearTimeout(instance.completedDebounceTimer)
  }
})

function recordingPort() {
  const calls: any[] = []
  const port: SessionEventPort = {
    status: () => {},
    modal: () => {},
    prompt: () => {},
    providerEvent: () => {},
    signal: (sessionId, detail) => { calls.push({ kind: 'signal', sessionId, ...detail }) },
    exited: (sessionId, termination, runtimeSettings) => { calls.push({ kind: 'exited', sessionId, termination, runtimeSettings }) },
  }
  return { port, calls }
}

async function initInstance(port: SessionEventPort) {
  let onExit: ((r: any) => void) | null = null
  let onSignal: ((r: any) => void) | null = null
  const instance = Object.create(CliProviderInstance.prototype) as any
  Object.assign(instance, {
    type: 'claude-cli', instanceId: 'sess-exit', provider: { name: 'Claude', settings: {} },
    workingDir: '/repo', providerSessionId: '', runtimeMessages: [], lastStatus: 'generating',
    lastApprovalEventFingerprint: '', lastInteractivePromptEventKey: '', lastPromptFingerprint: '',
    lastModalFingerprint: '', lifecyclePort: null, generatingStartedAt: 1, generatingDebouncePending: null,
    generatingDebounceTimer: null, completedDebouncePending: null, completedDebounceTimer: null,
    suppressIdleHistoryReplay: false, autoApproveBusy: false, busyEpoch: 0, events: [],
    monitor: { check: () => [], updateConfig: () => {} },
    adapter: {
      getStatus: () => ({ status: 'generating', activeModal: null }),
      getScriptParsedStatus: () => null,
      setOnChange: () => {},
      setOnStatusChange: () => {},
      setOnExit: (cb: any) => { onExit = cb },
      setOnSignal: (cb: any) => { onSignal = cb },
      spawn: async () => {},
      getRuntimeMetadata: () => null,
    },
  })
  instance.enforceFreshSessionLaunchIfNeeded = async () => {}
  instance.applyInitialThinkingLevelViaControl = async () => {}
  instance.maybeAppendRuntimeRecoveryMessage = () => {}
  instance.appendRuntimeSystemMessage = () => {}
  instance.applyProviderResponse = () => {}
  live.push(instance)
  await instance.init({ settings: {}, lifecycle: port, emitProviderEvent: () => {} })
  return { instance, exit: (r: any) => onExit!(r), signal: (r: any) => onSignal!(r) }
}

describe('CliProviderInstance → SessionEventPort (exit + signal)', () => {
  it('forwards the adapter exit report as port.exited(instanceId, tombstone, runtimeSettings)', async () => {
    const { port, calls } = recordingPort()
    const { exit } = await initInstance(port)
    const termination = { exitCode: 143, signal: 0, reason: 'failed', lifecycle: 'failed', terminatedAt: 1 }
    exit({ termination, runtimeSettings: { meshNodeFor: 'mesh-1' } })
    expect(calls).toEqual([{ kind: 'exited', sessionId: 'sess-exit', termination, runtimeSettings: { meshNodeFor: 'mesh-1' } }])
  })

  it('forwards the adapter signal report as port.signal(instanceId, detail)', async () => {
    const { port, calls } = recordingPort()
    const { signal } = await initInstance(port)
    const detection = { ruleId: 'usage_limit', kind: 'usage_limit', params: { resetsAt: '3pm' }, detectedAt: 5 }
    signal({ providerType: 'claude-cli', workspace: '/repo', runtimeSettings: { meshNodeFor: 'm' }, signal: detection })
    expect(calls).toEqual([{ kind: 'signal', sessionId: 'sess-exit', providerType: 'claude-cli', workspace: '/repo', runtimeSettings: { meshNodeFor: 'm' }, signal: detection }])
  })

  it('reports nothing once the port is detached', async () => {
    const { port, calls } = recordingPort()
    const { instance, exit } = await initInstance(port)
    instance.setSessionEventPort(null)
    exit({ runtimeSettings: {} })
    expect(calls).toEqual([])
  })
})
