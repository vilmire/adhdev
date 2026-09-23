import { describe, expect, it } from 'vitest'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import type { BusEvent, EventOf } from '../../src/sessions/lifecycle-events.js'
import { SessionRegistry, type SessionRuntimeTarget } from '../../src/sessions/registry.js'
import {
  buildModelSelection,
  buildRestoredLaunchRecord,
  buildSessionLaunchRecord,
  classifyMeshLaunchAxisSource,
  inferLaunchedBy,
  readLaunchProvenanceArgs,
  resolveProviderDefaultModel,
} from '../../src/sessions/launch-record.js'
import type { ModelDiscoverySnapshot } from '../../src/models/types.js'
import { MODEL_SELECTION_HISTORY_LIMIT } from '@adhdev/mesh-shared'

function snapshot(status: ModelDiscoverySnapshot['status'], slugs: string[]): ModelDiscoverySnapshot {
  return { provider: 'p', status, models: slugs.map((slug) => ({ slug })), updatedAt: 1, fetchedAt: 1 }
}

describe('resolveProviderDefaultModel', () => {
  it.each([
    ['ok snapshot → first discovered slug', snapshot('ok', ['grok-4.7', 'grok-3']), ['grok-3'], undefined, 'grok-4.7'],
    ['failed snapshot → manifest first', snapshot('error', []), ['opus', 'sonnet'], undefined, 'opus'],
    ['ok but empty → manifest first', snapshot('ok', []), ['opus'], undefined, 'opus'],
    ['no snapshot, no manifest → unknown', undefined, undefined, undefined, undefined],
    ['label picker → manifest slug', undefined, ['Gemini 3.7 Flash (High)'], { 'Gemini 3.7 Flash (High)': 'gemini-3.7-flash-high' }, 'gemini-3.7-flash-high'],
  ])('%s', (_label, snap, manifest, valueMap, expected) => {
    expect(resolveProviderDefaultModel(snap, manifest, valueMap)).toBe(expected)
  })
})

describe('classifyMeshLaunchAxisSource', () => {
  it.each([
    ['explicit task value in force', { taskValue: 'opus', taskSource: 'explicit', effectiveValue: 'opus' }, 'task_override'],
    ['unmarked (legacy) task value is explicit', { taskValue: 'opus', effectiveValue: 'opus' }, 'task_override'],
    ['slot filled a blank task', { effectiveValue: 'sonnet' }, 'mesh_slot'],
    ['slot outranked a preset', { taskValue: 'opus', taskSource: 'preset', effectiveValue: 'sonnet' }, 'mesh_slot'],
    ['preset stood (no covering slot)', { taskValue: 'opus', taskSource: 'preset', effectiveValue: 'opus' }, 'mesh_slot'],
    ['slot guard re-picked over an explicit task', { taskValue: 'opus', taskSource: 'explicit', effectiveValue: 'sonnet' }, 'mesh_slot'],
    ['nothing launched (CODEX-400 guard dropped it)', { taskValue: 'opus', taskSource: 'explicit' }, undefined],
  ] as const)('%s', (_label, input, expected) => {
    expect(classifyMeshLaunchAxisSource(input)).toBe(expected)
  })
})

describe('launch provenance args', () => {
  it('reads only valid enum values and never accepts restore from a caller', () => {
    expect(readLaunchProvenanceArgs({ launchedBy: 'dashboard', modelSource: 'remembered', thinkingLevelSource: 'user' }))
      .toEqual({ launchedBy: 'dashboard', modelSource: 'remembered', thinkingLevelSource: 'user' })
    expect(readLaunchProvenanceArgs({ launchedBy: 'restore', modelSource: 'hacker', thinkingLevelSource: 3 })).toEqual({})
    expect(readLaunchProvenanceArgs(undefined)).toEqual({})
  })

  it('infers mesh from mesh settings, else api', () => {
    expect(inferLaunchedBy({ launchedByCoordinator: true })).toBe('mesh')
    expect(inferLaunchedBy({ meshCoordinatorFor: 'mesh-1' })).toBe('mesh')
    expect(inferLaunchedBy({ meshNodeFor: 'mesh-1' })).toBe('mesh')
    expect(inferLaunchedBy({ autoApprove: true })).toBe('api')
    expect(inferLaunchedBy(undefined)).toBe('api')
  })
})

describe('buildModelSelection', () => {
  it('a requested value keeps the declared source and records what was passed', () => {
    expect(buildModelSelection({ requested: ' Sonnet ', declaredSource: 'user', launchValue: 'claude-sonnet', providerDefault: 'opus' }, 5)).toEqual({
      requested: 'Sonnet',
      source: 'user',
      launchValue: 'claude-sonnet',
      history: [{ at: 5, value: 'claude-sonnet', via: 'launch' }],
    })
  })

  it('a requested value with no declared source is unspecified, and cannot claim provider_default', () => {
    expect(buildModelSelection({ requested: 'opus' }, 5).source).toBe('unspecified')
    expect(buildModelSelection({ requested: 'opus', declaredSource: 'provider_default' }, 5).source).toBe('unspecified')
  })

  it('a request that was not applied has no launchValue', () => {
    const sel = buildModelSelection({ requested: 'opus', declaredSource: 'user' }, 5)
    expect(sel).not.toHaveProperty('launchValue')
    expect(sel.history).toEqual([{ at: 5, value: 'opus', via: 'launch' }])
  })

  it('nothing requested → provider_default when known, else unspecified (declared source ignored)', () => {
    expect(buildModelSelection({ declaredSource: 'user', providerDefault: 'opus' }, 5)).toEqual({
      source: 'provider_default',
      resolvedDefault: 'opus',
      history: [{ at: 5, value: 'opus', via: 'launch' }],
    })
    expect(buildModelSelection({ declaredSource: 'user' }, 5)).toEqual({ source: 'unspecified', history: [] })
  })
})

describe('buildRestoredLaunchRecord', () => {
  const stored = buildSessionLaunchRecord({
    sessionId: 'old-id',
    providerType: 'claude-cli',
    launchedBy: 'dashboard',
    launchedAt: 100,
    workspace: '/w',
    model: { requested: 'sonnet', declaredSource: 'remembered', launchValue: 'sonnet' },
    thinkingLevel: { requested: 'high', declaredSource: 'user', launchValue: 'high' },
  })

  it('keeps the axis sources and marks only launchedBy as restore (survives JSON)', () => {
    const restored = buildRestoredLaunchRecord(JSON.parse(JSON.stringify(stored)), {
      sessionId: 'rt-1', providerType: 'claude-cli', launchedAt: 999,
    })
    expect(restored.launchedBy).toBe('restore')
    expect(restored.sessionId).toBe('rt-1')
    expect(restored.launchedAt).toBe(100)
    expect(restored.model).toEqual(stored.model)
    expect(restored.model.source).toBe('remembered')
    expect(restored.thinkingLevel.source).toBe('user')
  })

  it('a pre-Phase-E runtime gets an honest unspecified record', () => {
    const restored = buildRestoredLaunchRecord(undefined, { sessionId: 'rt-2', providerType: 'codex-cli', workspace: '/w', launchedAt: 7 })
    expect(restored).toMatchObject({ sessionId: 'rt-2', providerType: 'codex-cli', launchedBy: 'restore', launchedAt: 7, workspace: '/w' })
    expect(restored.model).toEqual({ source: 'unspecified', history: [] })
  })
})

describe('SessionRegistry launch record', () => {
  function setup() {
    const bus = createSessionLifecycleBus()
    const events: BusEvent[] = []
    bus.on('*', (e) => { events.push(e) }, { name: 'recorder' })
    let now = 1000
    const registry = new SessionRegistry(bus, () => now)
    const launched = () => events.filter((e): e is EventOf<'launch_updated'> => e.kind === 'launch_updated')
    return { registry, launched, tick: (ms: number) => { now += ms } }
  }
  const target = (sessionId: string): SessionRuntimeTarget => ({ sessionId, parentSessionId: null, providerType: 'x-acp', transport: 'acp' })
  const record = (sessionId: string) => buildSessionLaunchRecord({
    sessionId,
    providerType: 'x-acp',
    launchedBy: 'dashboard',
    launchedAt: 1000,
    model: { requested: 'sonnet', declaredSource: 'user', launchValue: 'sonnet' },
    thinkingLevel: {},
  })

  it('setLaunchRecord stores the record and emits launch_updated{launch}', () => {
    const { registry, launched } = setup()
    registry.register(target('s1'), 'launch')
    expect(registry.setLaunchRecord('s1', record('s1'))).toBe(true)
    expect(registry.get('s1')?.launch?.model.source).toBe('user')
    expect(launched()).toHaveLength(1)
    expect(launched()[0]).toMatchObject({ sessionId: 's1', cause: 'launch', launch: { launchedBy: 'dashboard' } })
  })

  it('refuses an unknown session or a record naming another session', () => {
    const { registry, launched } = setup()
    expect(registry.setLaunchRecord('ghost', record('ghost'))).toBe(false)
    registry.register(target('s1'), 'launch')
    expect(registry.setLaunchRecord('s1', record('s2'))).toBe(false)
    expect(launched()).toHaveLength(0)
  })

  it('the emitted record is a snapshot, not the live object', () => {
    const { registry, launched } = setup()
    registry.register(target('s1'), 'launch')
    registry.setLaunchRecord('s1', record('s1'))
    registry.updateLaunchAxis('s1', 'model', 'opus')
    expect(launched()[0].launch.model.history).toHaveLength(1)
    expect(launched()[1].launch.model.history).toHaveLength(2)
  })

  it('change_model sets current and appends history; an unchanged value is a no-op', () => {
    const { registry, launched, tick } = setup()
    registry.register(target('s1'), 'launch')
    registry.setLaunchRecord('s1', record('s1'))
    tick(10)
    expect(registry.updateLaunchAxis('s1', 'model', 'opus')).toBe(true)
    expect(registry.updateLaunchAxis('s1', 'model', 'opus')).toBe(false)
    const model = registry.get('s1')!.launch!.model
    expect(model.current).toBe('opus')
    expect(model.source).toBe('user')
    expect(model.history).toEqual([
      { at: 1000, value: 'sonnet', via: 'launch' },
      { at: 1010, value: 'opus', via: 'change_model' },
    ])
    expect(launched().map((e) => e.cause)).toEqual(['launch', 'change_model'])
  })

  it('a session without a launch record ignores updates (no crash, no event)', () => {
    const { registry, launched } = setup()
    registry.register(target('ide'), 'attach')
    expect(registry.updateLaunchAxis('ide', 'model', 'opus')).toBe(false)
    expect(registry.observeLaunchAxis('ide', 'model', 'opus', 5)).toBe(false)
    expect(launched()).toHaveLength(0)
  })

  it('observation is monotonic and a repeat only refreshes observedAt', () => {
    const { registry, launched } = setup()
    registry.register(target('s1'), 'launch')
    registry.setLaunchRecord('s1', record('s1'))
    expect(registry.observeLaunchAxis('s1', 'model', 'claude-opus-4-1', 2000)).toBe(true)
    expect(registry.observeLaunchAxis('s1', 'model', 'claude-opus-4-1', 3000)).toBe(false)
    expect(registry.observeLaunchAxis('s1', 'model', 'claude-sonnet-4', 1500)).toBe(false) // older re-read
    const model = registry.get('s1')!.launch!.model
    expect(model.observed).toBe('claude-opus-4-1')
    expect(model.observedAt).toBe(3000)
    expect(model.history.map((h) => h.via)).toEqual(['launch', 'observed'])
    expect(launched().map((e) => e.cause)).toEqual(['launch', 'observed'])
  })

  it('observing the value already in force adds no history entry', () => {
    const { registry } = setup()
    registry.register(target('s1'), 'launch')
    registry.setLaunchRecord('s1', record('s1'))
    registry.observeLaunchAxis('s1', 'model', 'sonnet', 2000)
    const model = registry.get('s1')!.launch!.model
    expect(model.observed).toBe('sonnet')
    expect(model.history).toHaveLength(1)
  })

  it('history is bounded and keeps the launch entry', () => {
    const { registry } = setup()
    registry.register(target('s1'), 'launch')
    registry.setLaunchRecord('s1', record('s1'))
    for (let i = 0; i < MODEL_SELECTION_HISTORY_LIMIT + 5; i++) registry.updateLaunchAxis('s1', 'model', `m-${i}`)
    const history = registry.get('s1')!.launch!.model.history
    expect(history).toHaveLength(MODEL_SELECTION_HISTORY_LIMIT)
    expect(history[0]).toMatchObject({ via: 'launch', value: 'sonnet' })
    expect(history[history.length - 1].value).toBe(`m-${MODEL_SELECTION_HISTORY_LIMIT + 4}`)
  })

  it('a re-register keeps the launch record (like the provider-session binding)', () => {
    const { registry } = setup()
    registry.register(target('s1'), 'launch')
    registry.setLaunchRecord('s1', record('s1'))
    registry.register({ ...target('s1'), workspace: '/moved' }, 'launch')
    expect(registry.get('s1')?.launch?.model.requested).toBe('sonnet')
  })
})
