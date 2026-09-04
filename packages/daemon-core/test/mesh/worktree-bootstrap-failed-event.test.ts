import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runMeshWorktreeBootstrap } from '../../src/mesh/worktree-bootstrap-config.js'

/**
 * WORKTREE-BOOTSTRAP-FAILED-EVENT regression.
 *
 * `clone_mesh_node` emitted `worktree_bootstrap_complete` for EVERY resolved
 * bootstrap, including failed ones: the runner reports a failure by RETURNING
 * `status: 'failed'` rather than throwing, and the only `bootstrap_failed` emit
 * sat in a `.catch` that a normal command failure never reaches.
 *
 * This matters because the dispatch gate in mesh-event-forwarding deliberately
 * does NOT defer on 'failed' — its stated premise is that "a failed bootstrap
 * surfaces its own coordinator event and a dispatch there fails loudly rather
 * than silently (deferring forever would hide it)". With the mislabelled emit,
 * that premise was false: nothing was loud, and the failure surfaced only when
 * Refinery re-ran the bootstrap pre-merge and hard-blocked the merge.
 *
 * INJECTION CHECK: reverting either emit site to a hardcoded 'bootstrap_complete'
 * makes the routing test below fail.
 */
describe('WORKTREE-BOOTSTRAP-FAILED-EVENT', () => {
  const crudSrc = readFileSync(
    join(__dirname, '..', '..', 'src', 'commands', 'med-family', 'mesh-crud.ts'),
    'utf-8',
  )

  it('the runner reports a failed command by RETURNING status:failed, not by throwing', async () => {
    // This is the premise the emit-site fix rests on. If the runner ever starts
    // throwing instead, the `.catch` path would cover it and this test says so.
    const ws = mkdtempSync(join(tmpdir(), 'adhdev-wtfail-'))
    mkdirSync(join(ws, '.adhdev'), { recursive: true })
    const script = join(ws, 'boom.cjs')
    writeFileSync(script, 'process.exit(9)')
    writeFileSync(
      join(ws, '.adhdev', 'worktree_bootstrap.json'),
      JSON.stringify({
        version: 1,
        enabled: true,
        runOnClone: true,
        required: true,
        commands: [{ command: 'node', args: [script], category: 'custom', timeoutMs: 20_000 }],
      }),
    )

    // Must RESOLVE (not reject) with a failed verdict.
    const state = await runMeshWorktreeBootstrap({}, ws)
    expect(state.status).toBe('failed')
    expect(state.exitCode).toBe(9)
  })

  it('both clone emit sites route on the terminal status instead of hardcoding complete', () => {
    // Neither emit site may pass a literal 'bootstrap_complete'.
    expect(crudSrc).not.toMatch(/emitBootstrapEvent\(\s*'bootstrap_complete'/)
    // Both must go through the status-derived selector.
    const routed = crudSrc.match(/emitBootstrapEvent\(\s*terminalBootstrapEvent\(/g) ?? []
    expect(routed).toHaveLength(2)
    // And the selector must actually map 'failed' → the failed event.
    expect(crudSrc).toMatch(
      /terminalBootstrapEvent\s*=\s*\(state: WorktreeBootstrapState\)[^\n]*\n?\s*state\.status === 'failed' \? 'bootstrap_failed' : 'bootstrap_complete'/,
    )
  })

  it('keeps the deliberate no-infinite-defer design: the dispatch gate still only defers on running', () => {
    // The fix makes a failure VISIBLE; it must not start deferring on it, which
    // is what the gate's comment explicitly rules out.
    const fwd = readFileSync(
      join(__dirname, '..', '..', 'src', 'mesh', 'mesh-event-forwarding.ts'),
      'utf-8',
    )
    expect(fwd).toMatch(/worktreeBootstrapPending = node\?\.worktreeBootstrap\?\.status === 'running'/)
    expect(fwd).not.toMatch(/worktreeBootstrap\?\.status === 'failed'[^\n]*(defer|Pending)/)
  })
})
