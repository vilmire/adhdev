import { describe, expect, it } from 'vitest'

import {
  buildChainAbortNextStep,
  buildSkippedChainNodeOutcome,
  decideRefineBatchChainAbort,
} from '../../src/mesh/mesh-refine-batch-chain-abort'

// ★B3/B4 chain abort.
//
// The batch's documented behaviour is "isolate a failed node, keep going", which is
// correct for a node-local failure and exactly wrong for a base-axis one: every later
// node merges into the base the failed node was supposed to advance. On 2026-09-22 a
// dirty base made node 1 fail with merge_failed, and nodes 2 and 3 then ran their full
// gate sets to reach the identical failure.
//
// ★Both directions are asserted here on purpose. A test that only proved "aborts on a
// base failure" would pass identically if the feature were wired to abort on EVERY
// failure — which would silently disable the batch's isolation behaviour. The pair is
// what pins the actual boundary.

describe('decideRefineBatchChainAbort — base-axis failures stop the batch', () => {
  // ⑦ base-axis failure → remaining nodes are skipped.
  it.each([
    ['merge_failed', 'the merge could not be applied to the base'],
    ['base_moved', 'the base advanced underneath the batch'],
    ['base_locked', 'another refine holds the base lease'],
    ['base_cas_undeterminable', 'the base could not be read'],
    ['base_worktree_dirty', 'accept-time preflight: base is dirty'],
    ['base_stash_entries_present', 'accept-time preflight: base has stashes'],
    ['base_diverged_from_origin', 'accept-time preflight: base diverged'],
  ])('aborts the chain on %s (%s)', (code) => {
    const decision = decideRefineBatchChainAbort({ convergence: 'blocked_review', code })
    expect(decision.abort).toBe(true)
    expect(decision.code).toBe(code)
    expect(decision.reason).toContain('BASE axis')
  })

  it('aborts on a not_mergeable merge failure too', () => {
    const decision = decideRefineBatchChainAbort({ convergence: 'not_mergeable', code: 'merge_failed' })
    expect(decision.abort).toBe(true)
  })

  // The stage back-stops an unrecognized/absent code.
  it('aborts on a base-axis STAGE even when the code is unfamiliar', () => {
    const decision = decideRefineBatchChainAbort({ convergence: 'blocked_review', code: 'some_new_code', stage: 'merge' })
    expect(decision.abort).toBe(true)
    expect(decision.stage).toBe('merge')

    const casDecision = decideRefineBatchChainAbort({ convergence: 'blocked_review', stage: 'base_cas' })
    expect(casDecision.abort).toBe(true)
  })
})

describe('decideRefineBatchChainAbort — node-local failures do NOT stop the batch', () => {
  // ⑧ the other half: a node's own failure must leave siblings running. Without this
  // assertion the feature is indistinguishable from "abort on any failure".
  it.each([
    ['validation_failed', 'this branch failed its own tests'],
    ['patch_equivalence_failed', 'this branch diverged from its patch'],
    ['submodule_reachability_failed', "this branch's submodule commits are unpublished"],
    ['missing_dependencies', "this worktree's deps are absent"],
    ['dependency_bootstrap_failed', 'this worktree failed to bootstrap'],
    ['spawn_resolution_failed', 'a command could not spawn here'],
    ['output_limit_exceeded', 'this run was too chatty'],
  ])('continues the batch after %s (%s)', (code) => {
    const decision = decideRefineBatchChainAbort({ convergence: 'blocked_review', code })
    expect(decision.abort).toBe(false)
  })

  it('continues after a node-local failure in a node-local stage', () => {
    const decision = decideRefineBatchChainAbort({ convergence: 'blocked_review', code: 'validation_failed', stage: 'validation' })
    expect(decision.abort).toBe(false)
  })

  // A SUCCESS never aborts, whatever else it carries.
  it.each([
    ['merged_to_main'],
    ['skipped_patch_equivalent'],
  ])('never aborts on a %s outcome', (convergence) => {
    expect(decideRefineBatchChainAbort({ convergence }).abort).toBe(false)
  })

  // ★submodule_reachability_failed is the case most likely to be mis-bucketed: it
  // mentions the base's submodule remote, but it is a fact about THIS branch's commits.
  it('classifies submodule_reachability_failed as node-local, not base-axis', () => {
    const decision = decideRefineBatchChainAbort({
      convergence: 'blocked_review',
      code: 'submodule_reachability_failed',
      stage: 'submodule_reachability',
    })
    expect(decision.abort).toBe(false)
  })
})

describe('chain-abort reporting (B4)', () => {
  it('records a skipped node as NOT attempted, naming the precursor', () => {
    const outcome = buildSkippedChainNodeOutcome({
      nodeId: 'node-2',
      workspace: '/wt2',
      precursorNodeId: 'node-1',
      decision: { abort: true, code: 'merge_failed', reason: 'base' },
    })
    expect(outcome.convergence).toBe('skipped_chain_abort')
    expect(outcome.chainSkipped).toBe(true)
    expect(outcome.precursorNodeId).toBe('node-1')
    expect(outcome.precursorCode).toBe('merge_failed')
    // ★Must not claim a verdict that was never measured.
    expect(outcome.reason).toContain('Not attempted')
  })

  it('leads the nextStep with the root cause and names the skipped nodes', () => {
    const nextStep = buildChainAbortNextStep({
      precursorNodeId: 'node-1',
      decision: { abort: true, code: 'merge_failed', reason: 'base' },
      skippedNodeIds: ['node-2', 'node-3'],
    })
    expect(nextStep).toContain('ROOT CAUSE')
    expect(nextStep).toContain('node-1')
    expect(nextStep).toContain('merge_failed')
    expect(nextStep).toContain('node-2, node-3')
    // The skipped nodes ran nothing, so there is nothing to undo — say so.
    expect(nextStep).toContain('no cleanup')
  })
})
