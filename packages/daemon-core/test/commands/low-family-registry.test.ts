import { describe, expect, it, vi } from 'vitest'

import { lowFamilyRegistry } from '../../src/commands/low-family/index.js'
import { sessionHostHandlers } from '../../src/commands/low-family/session-host.js'
import { specProviderDevHandlers } from '../../src/commands/low-family/spec-providerdev.js'
import { refineConfigHandlers } from '../../src/commands/low-family/refine-config.js'

// RF-ROUTER LOW family extraction: the registry must carry exactly the commands
// removed from executeDaemonCommand's switch, and each handler must return the same
// shape the inlined case did. The full facade path (router.execute → registry) is
// covered by session-host-trace.test.ts / mesh-refine-validation.test.ts; this file
// unit-tests the handlers and registry membership directly.

const SESSION_HOST_CMDS = [
  'session_host_get_diagnostics',
  'session_host_list_sessions',
  'session_host_stop_session',
  'session_host_resume_session',
  'session_host_restart_session',
  'session_host_send_signal',
  'session_host_force_detach_client',
  'session_host_prune_duplicate_sessions',
  'session_host_acquire_write',
  'session_host_release_write',
]
const SPEC_CMDS = [
  'get_spec_debug', 'get_spec_source', 'write_spec_source',
  'validate_spec', 'eval_condition_preview', 'resolve_section_preview',
]
const REFINE_CMDS = [
  'get_mesh_refine_config_schema', 'validate_mesh_refine_config', 'suggest_mesh_refine_config',
  'get_mesh_change_impact_config_schema', 'validate_mesh_change_impact_config', 'suggest_mesh_change_impact_config',
]

describe('low-family registry', () => {
  it('registers all 22 LOW family commands once, no overlap', () => {
    const all = [...SESSION_HOST_CMDS, ...SPEC_CMDS, ...REFINE_CMDS]
    expect(lowFamilyRegistry.size).toBe(all.length)
    for (const cmd of all) expect(lowFamilyRegistry.has(cmd)).toBe(true)
    // family maps are disjoint
    expect(Object.keys(sessionHostHandlers)).toEqual(SESSION_HOST_CMDS)
    expect(Object.keys(specProviderDevHandlers)).toEqual(SPEC_CMDS)
    expect(Object.keys(refineConfigHandlers)).toEqual(REFINE_CMDS)
  })

  it('session_host handler fails gracefully when the control plane is unavailable', async () => {
    const result = await lowFamilyRegistry.get('session_host_list_sessions')!({ deps: {} as any }, {})
    expect(result).toEqual({ success: false, error: 'Session host control unavailable' })
  })

  it('session_host_stop_session requires a sessionId', async () => {
    const deps = { sessionHostControl: { stopSession: vi.fn() } } as any
    const result = await lowFamilyRegistry.get('session_host_stop_session')!({ deps }, {})
    expect(result).toEqual({ success: false, error: 'sessionId required' })
    expect(deps.sessionHostControl.stopSession).not.toHaveBeenCalled()
  })

  it('refine schema handler returns the schema + locations, no deps needed', async () => {
    const result: any = await lowFamilyRegistry.get('get_mesh_refine_config_schema')!({ deps: {} as any }, {})
    expect(result.success).toBe(true)
    expect(result.schema).toBeDefined()
    expect(result.locations).toBeDefined()
    expect(result.heuristicRole).toBe('suggestions_only_not_execution_path')
    expect(result.worktreeBootstrap?.schema).toBeDefined()
  })

  it('validate_spec rejects a non-v4 schema and accepts a structurally valid v4 spec', async () => {
    const bad: any = await lowFamilyRegistry.get('validate_spec')!({ deps: {} as any }, { spec: { $schema: 'adhdev:cli/spec@3' } })
    expect(bad.success).toBe(true)
    expect(bad.valid).toBe(false)

    const badJson: any = await lowFamilyRegistry.get('validate_spec')!({ deps: {} as any }, { content: '{not json' })
    expect(badJson.valid).toBe(false)
    expect(String(badJson.errors?.[0])).toMatch(/invalid JSON/)
  })

  it('get_spec_debug requires a targetSessionId and reports session-not-found', async () => {
    const missing: any = await lowFamilyRegistry.get('get_spec_debug')!({ deps: {} as any }, {})
    expect(missing).toEqual({ success: false, error: 'targetSessionId required' })

    const deps = { sessionRegistry: { get: vi.fn(() => null) }, cliManager: { findAdapter: vi.fn() } } as any
    const notFound: any = await lowFamilyRegistry.get('get_spec_debug')!({ deps }, { targetSessionId: 'sess-x' })
    expect(notFound).toMatchObject({ success: false, error: 'Session not found', sessionId: 'sess-x' })
  })
})
