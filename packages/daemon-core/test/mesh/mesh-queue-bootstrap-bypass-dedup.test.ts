import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOG } from '../../src/logging/logger.js'
import {
  clearWorktreeBootstrapStaleBypassState,
  logWorktreeBootstrapStaleBypass,
} from '../../src/mesh/mesh-queue-observability.js'

/**
 * WORKTREE-BOOTSTRAP-STALE-BYPASS dedup guard.
 *
 * tryAssignQueueTask's stale-backstop bypass re-enters on every ~4s drain tick
 * while the terminal bootstrap stamp is missing from this daemon's mesh view,
 * and used to WARN every time — 1,130 duplicate lines for one node in a single
 * day (2026-08-21), three 5MB rotations deep, pushing the coordinator boot
 * window out of the logs. The bypass must warn ONCE per (mesh, node, session)
 * and again only after the bootstrap leaves 'running' (the clear the claim
 * gate performs when it observes a terminal status).
 */
describe('logWorktreeBootstrapStaleBypass transition dedup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    clearWorktreeBootstrapStaleBypassState('mesh_dedup', 'node_a', 'sess_a')
    clearWorktreeBootstrapStaleBypassState('mesh_dedup', 'node_b', 'sess_a')
  })

  it('warns once per (mesh, node, session) across repeated bypass ticks', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {})

    logWorktreeBootstrapStaleBypass('mesh_dedup', 'node_a', 'sess_a')
    logWorktreeBootstrapStaleBypass('mesh_dedup', 'node_a', 'sess_a')
    logWorktreeBootstrapStaleBypass('mesh_dedup', 'node_a', 'sess_a')

    const bypassWarnings = warn.mock.calls.filter(([, msg]) => String(msg).includes("bootstrap stuck 'running'"))
    expect(bypassWarnings.length).toBe(1)
  })

  it('tracks nodes independently (a second stuck node still warns)', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {})

    logWorktreeBootstrapStaleBypass('mesh_dedup', 'node_a', 'sess_a')
    logWorktreeBootstrapStaleBypass('mesh_dedup', 'node_b', 'sess_a')

    const bypassWarnings = warn.mock.calls.filter(([, msg]) => String(msg).includes("bootstrap stuck 'running'"))
    expect(bypassWarnings.length).toBe(2)
  })

  it('warns again after the clear (bootstrap left running → a new stuck episode is visible)', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {})

    logWorktreeBootstrapStaleBypass('mesh_dedup', 'node_a', 'sess_a')
    clearWorktreeBootstrapStaleBypassState('mesh_dedup', 'node_a', 'sess_a')
    logWorktreeBootstrapStaleBypass('mesh_dedup', 'node_a', 'sess_a')

    const bypassWarnings = warn.mock.calls.filter(([, msg]) => String(msg).includes("bootstrap stuck 'running'"))
    expect(bypassWarnings.length).toBe(2)
  })
})
