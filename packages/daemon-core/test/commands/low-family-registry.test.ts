import { describe, expect, it, vi } from 'vitest'

import { lowFamilyRegistry } from '../../src/commands/low-family/index.js'
import { sessionHostHandlers } from '../../src/commands/low-family/session-host.js'
import { specProviderDevHandlers } from '../../src/commands/low-family/spec-providerdev.js'
import { refineConfigHandlers } from '../../src/commands/low-family/refine-config.js'
import { diagnosticsHandlers } from '../../src/commands/low-family/diagnostics.js'
import { statusMetaHandlers } from '../../src/commands/low-family/status-meta.js'
import { coordinatorPromptHandlers } from '../../src/commands/low-family/coordinator-prompt.js'
import { notificationHandlers } from '../../src/commands/low-family/notification.js'
import { daemonLifecycleHandlers } from '../../src/commands/low-family/daemon-lifecycle.js'
import { meshLedgerHandlers } from '../../src/commands/low-family/mesh-ledger.js'
import { meshNodeLogsHandlers } from '../../src/commands/low-family/mesh-node-logs.js'
import { workerReportHandlers } from '../../src/commands/low-family/worker-report.js'
import { workerMailboxHandlers } from '../../src/commands/low-family/worker-mailbox.js'
import { workerPeerContextHandlers } from '../../src/commands/low-family/worker-peer-context.js'
import { transcriptReplicaHandlers } from '../../src/commands/low-family/transcript-replica.js'

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
// Stage 2: LOW-family remainder extracted into the same registry.
const DIAGNOSTICS_CMDS = ['get_logs', 'get_debug_trace']
const STATUS_META_CMDS = ['set_user_name', 'get_status_metadata', 'refresh_provider_quota', 'get_machine_runtime_stats', 'get_session_info']
const COORDINATOR_PROMPT_CMDS = ['coordinator_prompt_preview', 'list_coordinator_prompts', 'write_coordinator_prompt']
const NOTIFICATION_CMDS = ['mark_session_seen', 'delete_notification', 'mark_notification_unread']
// Order matters: the assertions below compare against Object.keys(handlers),
// so these must stay in the handler object's declaration order. The quota
// account-label pair and the quota provider-toggle pair were appended to
// daemonLifecycleHandlers and so belong at the end here too.
const DAEMON_LIFECYCLE_CMDS = [
  'daemon_upgrade', 'daemon_restart', 'set_machine_nickname',
  'get_quota_account_label', 'set_quota_account_label',
  'get_quota_provider_enabled', 'set_quota_provider_enabled',
]
const MESH_LEDGER_CMDS = ['get_mesh_ledger', 'get_mesh_ledger_slice', 'list_mesh_notes', 'record_mesh_note', 'forget_mesh_note', 'import_mesh_ledger_slice']
const MESH_NODE_LOGS_CMDS = ['get_mesh_node_logs']
// WORKER-MCP Phase B: the worker's own reporting surface (design §4/§5).
const WORKER_REPORT_CMDS = ['worker_resolve_task', 'worker_report_completion', 'worker_progress_update']
// WORKER-MCP E-T0: the mailbox piggyback (design §7.1) — coordinator-side deposit
// (routed cross-daemon via mesh_notify_worker) and the worker-side drain.
const WORKER_MAILBOX_CMDS = ['deposit_worker_mailbox', 'worker_drain_mailbox']
// WORKER-MCP D: the worker's read-only sibling-context lookup (design §6).
const WORKER_PEER_CONTEXT_CMDS = ['worker_peer_context_pull']
// Phase 3 §8 unit 3: daemon-local transcript replica IPC (design §4,
// "별도 프로세스 경계") — mcp-server reaches the seqscribe-node-owning
// daemon through these two commands instead of opening seqscribe.db itself.
const TRANSCRIPT_REPLICA_CMDS = ['ensure_transcript_subscription', 'read_transcript_replica']

describe('low-family registry', () => {
  it('registers all 57 LOW family commands once, no overlap', () => {
    const all = [
      ...SESSION_HOST_CMDS, ...SPEC_CMDS, ...REFINE_CMDS,
      ...DIAGNOSTICS_CMDS, ...STATUS_META_CMDS, ...COORDINATOR_PROMPT_CMDS,
      ...NOTIFICATION_CMDS, ...DAEMON_LIFECYCLE_CMDS, ...MESH_LEDGER_CMDS, ...MESH_NODE_LOGS_CMDS,
      ...WORKER_REPORT_CMDS, ...WORKER_MAILBOX_CMDS, ...WORKER_PEER_CONTEXT_CMDS,
      ...TRANSCRIPT_REPLICA_CMDS,
    ]
    // no duplicate command names across families
    expect(new Set(all).size).toBe(all.length)
    expect(lowFamilyRegistry.size).toBe(all.length)
    for (const cmd of all) expect(lowFamilyRegistry.has(cmd)).toBe(true)
    // family maps are disjoint and each owns exactly its declared commands
    expect(Object.keys(sessionHostHandlers)).toEqual(SESSION_HOST_CMDS)
    expect(Object.keys(specProviderDevHandlers)).toEqual(SPEC_CMDS)
    expect(Object.keys(refineConfigHandlers)).toEqual(REFINE_CMDS)
    expect(Object.keys(diagnosticsHandlers)).toEqual(DIAGNOSTICS_CMDS)
    expect(Object.keys(statusMetaHandlers)).toEqual(STATUS_META_CMDS)
    expect(Object.keys(coordinatorPromptHandlers)).toEqual(COORDINATOR_PROMPT_CMDS)
    expect(Object.keys(notificationHandlers)).toEqual(NOTIFICATION_CMDS)
    expect(Object.keys(daemonLifecycleHandlers)).toEqual(DAEMON_LIFECYCLE_CMDS)
    expect(Object.keys(meshLedgerHandlers)).toEqual(MESH_LEDGER_CMDS)
    expect(Object.keys(meshNodeLogsHandlers)).toEqual(MESH_NODE_LOGS_CMDS)
    expect(Object.keys(workerReportHandlers)).toEqual(WORKER_REPORT_CMDS)
    expect(Object.keys(workerMailboxHandlers)).toEqual(WORKER_MAILBOX_CMDS)
    expect(Object.keys(workerPeerContextHandlers)).toEqual(WORKER_PEER_CONTEXT_CMDS)
    expect(Object.keys(transcriptReplicaHandlers)).toEqual(TRANSCRIPT_REPLICA_CMDS)
  })

  // The lists above are written by hand, which is what makes them a real gate:
  // adding a handler without declaring it fails. But they share a blind spot —
  // they can only check families someone remembered to list. A whole new family
  // spread into lowFamilyRegistry and never added here would leave every
  // assertion above passing, because each one only compares a family to its own
  // list and the size check compares against the same incomplete union.
  //
  // This derives the expectation from the handler objects the registry itself
  // spreads, so registry membership is pinned to its actual sources rather than
  // to whatever the union above happens to cover.
  it('registry contains exactly the union of the family handler objects', () => {
    const union = [
      sessionHostHandlers, specProviderDevHandlers, refineConfigHandlers,
      diagnosticsHandlers, statusMetaHandlers, coordinatorPromptHandlers,
      notificationHandlers, daemonLifecycleHandlers, meshLedgerHandlers,
      meshNodeLogsHandlers, workerReportHandlers, workerMailboxHandlers,
      workerPeerContextHandlers, transcriptReplicaHandlers,
    ].flatMap((handlers) => Object.keys(handlers))

    expect(new Set(union).size).toBe(union.length)
    expect([...lowFamilyRegistry.keys()].sort()).toEqual([...union].sort())
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

  // ─── Stage 2 family handler contracts ───

  it('get_debug_trace returns a trace envelope with no deps needed', async () => {
    const result: any = await lowFamilyRegistry.get('get_debug_trace')!({ deps: {} as any }, { limit: 5 })
    expect(result.success).toBe(true)
    expect(Array.isArray(result.trace)).toBe(true)
    expect(result.count).toBe(result.trace.length)
  })

  it('set_user_name requires a userName string', async () => {
    await expect(
      lowFamilyRegistry.get('set_user_name')!({ deps: {} as any }, {}),
    ).rejects.toThrow(/userName required/)
  })

  it('get_session_info requires a targetSessionId and reports session-not-found', async () => {
    const missing: any = await lowFamilyRegistry.get('get_session_info')!({ deps: {} as any }, {})
    expect(missing).toEqual({ success: false, error: 'targetSessionId required' })

    const deps = { sessionRegistry: { get: vi.fn(() => null) }, cliManager: { findAdapter: vi.fn() } } as any
    const notFound: any = await lowFamilyRegistry.get('get_session_info')!({ deps }, { targetSessionId: 'sess-y' })
    expect(notFound).toMatchObject({ success: false, error: 'Session not found', sessionId: 'sess-y' })
  })

  it('write_coordinator_prompt rejects a path-traversal key before touching disk', async () => {
    const bad: any = await lowFamilyRegistry.get('write_coordinator_prompt')!({ deps: {} as any }, { key: '../../etc/passwd', content: 'x' })
    expect(bad).toEqual({ success: false, error: 'key must match [a-zA-Z0-9_.-]+' })
  })

  it('mark_session_seen / delete_notification / mark_notification_unread require a sessionId', async () => {
    expect(await lowFamilyRegistry.get('mark_session_seen')!({ deps: {} as any }, {}))
      .toEqual({ success: false, error: 'sessionId is required' })
    expect(await lowFamilyRegistry.get('delete_notification')!({ deps: {} as any }, {}))
      .toEqual({ success: false, error: 'sessionId is required' })
    expect(await lowFamilyRegistry.get('mark_notification_unread')!({ deps: {} as any }, {}))
      .toEqual({ success: false, error: 'sessionId is required' })
  })

  it('delete_notification requires a notificationId once a sessionId is present', async () => {
    const result: any = await lowFamilyRegistry.get('delete_notification')!({ deps: {} as any }, { sessionId: 'sess-z' })
    expect(result).toEqual({ success: false, error: 'notificationId is required' })
  })

  it('get_mesh_ledger / slice / import all require a meshId', async () => {
    for (const cmd of MESH_LEDGER_CMDS) {
      const result: any = await lowFamilyRegistry.get(cmd)!({ deps: {} as any }, {})
      expect(result).toEqual({ success: false, error: 'meshId required' })
    }
  })

  it('get_mesh_node_logs resolves the owning daemon and forwards a remote read', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({ success: true, lines: ['remote'] }))
    const getMeshForCommand = vi.fn(async () => ({
      mesh: { nodes: [{ nodeId: 'n1', daemonId: 'remote-daemon' }] },
      inline: true as const,
      source: 'inline_cache' as const,
    }))
    const ctx = { deps: { statusInstanceId: 'local-daemon', dispatchMeshCommand } as any, getMeshForCommand }
    const result: any = await lowFamilyRegistry.get('get_mesh_node_logs')!(ctx, { meshId: 'm1', nodeId: 'n1' })
    expect(getMeshForCommand).toHaveBeenCalledWith('m1', undefined, { preferInline: true })
    expect(dispatchMeshCommand).toHaveBeenCalledWith('remote-daemon', 'get_mesh_node_logs', expect.objectContaining({ _meshDirectDispatch: true }))
    expect(result).toEqual({ success: true, lines: ['remote'] })
  })
})
