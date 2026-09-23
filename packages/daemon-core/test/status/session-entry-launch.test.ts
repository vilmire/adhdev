import { describe, expect, it, vi } from 'vitest'
import { buildSessionEntries, buildSessionLaunchFields } from '../../src/status/builders.js'
import { buildSessionLaunchRecord } from '../../src/sessions/launch-record.js'
import { nativeHistoryObservedModel } from '../../src/providers/native-history/observed-model.js'
import { AcpProviderInstance } from '../../src/providers/acp-provider-instance.js'

// Phase E surfaces: SessionEntry carries the full launch record over P2P plus
// the derived model / modelSource / thinkingLevel scalars.

const launch = buildSessionLaunchRecord({
  sessionId: 'cli-1',
  providerType: 'claude-cli',
  launchedBy: 'dashboard',
  launchedAt: 10,
  model: { requested: 'sonnet', declaredSource: 'remembered', launchValue: 'sonnet' },
  thinkingLevel: { requested: 'high', declaredSource: 'user', launchValue: 'high' },
})

describe('buildSessionLaunchFields', () => {
  it('projects the record plus model / modelSource / thinkingLevel', () => {
    expect(buildSessionLaunchFields(launch)).toEqual({
      launch,
      model: 'sonnet',
      modelSource: 'remembered',
      thinkingLevel: 'high',
    })
  })

  it('a changed model reports the value in force', () => {
    const changed = { ...launch, model: { ...launch.model, current: 'opus', history: [...launch.model.history, { at: 20, value: 'opus', via: 'change_model' as const }] } }
    expect(buildSessionLaunchFields(changed)).toMatchObject({ model: 'opus', modelSource: 'remembered' })
  })

  it('an unknown model still reports its source', () => {
    const unknown = buildSessionLaunchRecord({ ...launch, launchedBy: 'api', model: {}, thinkingLevel: {} })
    expect(buildSessionLaunchFields(unknown)).toEqual({ launch: unknown, modelSource: 'unspecified' })
  })

  it('no record → no fields', () => {
    expect(buildSessionLaunchFields(undefined)).toEqual({})
  })
})

describe('buildSessionEntries — launch record on CLI / ACP entries', () => {
  const base = { status: 'idle', workspace: '/repo', activeChat: null, settings: {}, lastUpdated: 1, pendingEvents: [] }

  it('copies a state-carried launch record into CLI and ACP entries, and never into IDE entries', () => {
    const sessions = buildSessionEntries([
      { ...base, category: 'cli', type: 'claude-cli', name: 'Claude', instanceId: 'cli-1', mode: 'chat', launch } as any,
      { ...base, category: 'acp', type: 'x-acp', name: 'X', instanceId: 'acp-1', mode: 'chat', launch: { ...launch, sessionId: 'acp-1' } } as any,
      { ...base, category: 'ide', type: 'cursor', name: 'Cursor', instanceId: 'ide-1', cdpConnected: true, extensions: [] } as any,
    ], new Map(), { profile: 'full' })

    const byId = new Map(sessions.map((s) => [s.id, s]))
    expect(byId.get('cli-1')).toMatchObject({ model: 'sonnet', modelSource: 'remembered', thinkingLevel: 'high', launch: { launchedBy: 'dashboard' } })
    expect(byId.get('acp-1')).toMatchObject({ model: 'sonnet', launch: { sessionId: 'acp-1' } })
    expect(byId.get('ide-1')).not.toHaveProperty('launch')
    expect(byId.get('ide-1')).not.toHaveProperty('model')
  })

  it('a malformed state-carried record is dropped, not forwarded', () => {
    const [session] = buildSessionEntries([
      { ...base, category: 'cli', type: 'claude-cli', name: 'Claude', instanceId: 'cli-1', mode: 'chat', launch: { secret: 'x' } } as any,
    ], new Map(), { profile: 'full' })
    expect(session).not.toHaveProperty('launch')
  })
})

describe('nativeHistoryObservedModel', () => {
  it('reads the folded usage model and its time', () => {
    expect(nativeHistoryObservedModel({ usage: { model: 'claude-opus-4-1', lastUsageAt: 500 }, sourceMtimeMs: 900 }))
      .toEqual({ value: 'claude-opus-4-1', at: 500 })
  })

  it('falls back to the transcript mtime, and returns null without a model or a time', () => {
    expect(nativeHistoryObservedModel({ usage: { model: 'm', lastUsageAt: 0 }, sourceMtimeMs: 900 })).toEqual({ value: 'm', at: 900 })
    expect(nativeHistoryObservedModel({ usage: { lastUsageAt: 5 } })).toBeNull()
    expect(nativeHistoryObservedModel({ usage: { model: 'm' } })).toBeNull()
    expect(nativeHistoryObservedModel(null)).toBeNull()
  })
})

describe('AcpProviderInstance model observer', () => {
  it('reports the current selection when installed and every later agent-reported model', () => {
    const instance = new AcpProviderInstance({ type: 'x-acp', name: 'X', category: 'acp', spawn: { command: 'x' } } as any, '/repo')
    ;(instance as any).setCurrentSelection('model', 'sonnet')
    const observer = vi.fn()
    instance.setModelObserver(observer)
    expect(observer).toHaveBeenCalledWith('sonnet', expect.any(Number))
    ;(instance as any).setCurrentSelection('model', 'opus')
    expect(observer).toHaveBeenLastCalledWith('opus', expect.any(Number))
    ;(instance as any).setCurrentSelection('mode', 'plan')
    expect(observer).toHaveBeenCalledTimes(2)
  })
})
