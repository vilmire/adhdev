import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWin32Executable } from '../../src/cli-adapters/resolve-executable.js'
import {
  runMeshWorktreeBootstrap,
  startMeshWorktreeBootstrap,
  getWorktreeBootstrapQueueDepth,
} from '../../src/mesh/worktree-bootstrap-config.js'

const GIT = process.platform === 'win32' ? resolveWin32Executable('git') : 'git'
const git = (cwd: string, args: string[]) =>
  execFileSync(GIT, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' })

/**
 * WORKTREE-BOOTSTRAP-SERIAL-QUEUE regression suite.
 *
 * The defect: worktrees cloned within seconds of each other bootstrapped
 * concurrently and their `npm install` runs raced — one died with `exitCode: null`,
 * leaving a half-installed tree that broke the worker's tests and hard-blocked
 * Refinery with `dependency_bootstrap_failed`.
 *
 * Measured on one machine, same repo, same command, differing only in execution mode:
 *   2 concurrent (20s apart)  ✗ one `exitCode: null`, vendor stuck 20/83
 *   3 concurrent (observed)   ✗ a third worktree sat at 0/83
 *   2 sequential              ✓ both reached 83/83
 *
 * SCOPE IS PER-DAEMON, NOT PER-BASE. The contended resource is the npm cache and
 * `npm config get cache` is one machine-wide path (`~/.npm`), not partitioned by
 * repo — so two bootstraps of DIFFERENT bases collide exactly as two of the same
 * base do. The `different bases are ALSO serialized` test below pins that
 * deliberately: an earlier revision keyed the queue on `git rev-parse
 * --git-common-dir` and was wrong.
 *
 * These tests do not simulate npm. They detect OVERLAP directly: each bootstrap
 * command appends `+<tag>` on entry and `-<tag>` on exit to a shared trace file,
 * with a real delay in between. If two runs overlap, the trace contains `+a+b`
 * (two opens with no close between) and the assertion fails.
 *
 * INJECTION CHECKS (gate-authoring checklist):
 *  - Bypassing `enqueueBootstrap` (calling `runMeshWorktreeBootstrapUnqueued`
 *    directly = pre-fix behavior) turns every serialization test red with an
 *    interleaved trace.
 *  - Restoring a PER-BASE key turns `different bases are ALSO serialized` red,
 *    which is the whole point of the scope decision.
 */

/** A bootstrap command that traces its own entry/exit into `tracePath`. */
function traceScript(tracePath: string, tag: string, delayMs: number, exitCode = 0): string {
  // A standalone node script so it is a real spawned process — the same execFile
  // path the production bootstrap uses.
  return [
    `const fs = require('fs');`,
    `fs.appendFileSync(${JSON.stringify(tracePath)}, '+${tag}');`,
    `setTimeout(() => {`,
    `  fs.appendFileSync(${JSON.stringify(tracePath)}, '-${tag}');`,
    `  process.exit(${exitCode});`,
    `}, ${delayMs});`,
  ].join('\n')
}

/**
 * A trace is serialized iff every '+' is immediately followed by its own '-'.
 * `+a-a+b-b` = serial. `+a+b-a-b` = overlapped (the production race).
 */
function isSerialized(trace: string): boolean {
  return /^(\+(\w)-\2)*$/.test(trace)
}

function writeBootstrapConfig(workspace: string, scriptPath: string, timeoutMs = 30_000): void {
  mkdirSync(join(workspace, '.adhdev'), { recursive: true })
  writeFileSync(
    join(workspace, '.adhdev', 'worktree_bootstrap.json'),
    JSON.stringify({
      version: 1,
      enabled: true,
      runOnClone: true,
      required: true,
      commands: [
        { command: 'node', args: [scriptPath], category: 'custom', timeoutMs, outputLimitBytes: 65536 },
      ],
    }),
  )
}

describe('WORKTREE-BOOTSTRAP-SERIAL-QUEUE', () => {
  let baseA: string
  let baseB: string
  const worktrees: string[] = []
  const roots: string[] = []

  /** Create a base repo plus `count` real git worktrees of it. */
  const makeBase = (label: string, count: number): { base: string; trees: string[] } => {
    const base = mkdtempSync(join(tmpdir(), `adhdev-wtq-${label}-`))
    roots.push(base)
    git(base, ['init', '-q'])
    git(base, ['config', 'user.email', 'test@example.com'])
    git(base, ['config', 'user.name', 'Test'])
    writeFileSync(join(base, 'a.txt'), 'hello\n')
    git(base, ['add', '-A'])
    git(base, ['commit', '-q', '-m', 'init'])
    const trees: string[] = []
    for (let i = 0; i < count; i++) {
      const wt = join(base, '..', `${label}-wt-${i}-${process.pid}`)
      git(base, ['worktree', 'add', '-q', '-b', `wt${i}`, wt])
      trees.push(wt)
      worktrees.push(wt)
    }
    return { base, trees }
  }

  let treesA: string[]
  let treesB: string[]

  beforeAll(() => {
    const a = makeBase('a', 3)
    const b = makeBase('b', 2)
    baseA = a.base
    baseB = b.base
    treesA = a.trees
    treesB = b.trees
  })

  afterAll(() => {
    for (const wt of worktrees) rmSync(wt, { recursive: true, force: true })
    for (const r of roots) rmSync(r, { recursive: true, force: true })
  })

  // ★ The core regression. Pre-fix this interleaves; post-fix it cannot.
  it('serializes two bootstraps of the same base started concurrently', async () => {
    const trace = join(baseA, 'trace-serial.txt')
    writeFileSync(trace, '')
    const scriptA = join(baseA, 'sA.cjs')
    const scriptB = join(baseA, 'sB.cjs')
    writeFileSync(scriptA, traceScript(trace, 'a', 300))
    writeFileSync(scriptB, traceScript(trace, 'b', 300))
    writeBootstrapConfig(treesA[0], scriptA)
    writeBootstrapConfig(treesA[1], scriptB)

    const [r0, r1] = await Promise.all([
      runMeshWorktreeBootstrap({}, treesA[0]),
      runMeshWorktreeBootstrap({}, treesA[1]),
    ])

    expect(r0.status).toBe('ready')
    expect(r1.status).toBe('ready')
    const t = readFileSync(trace, 'utf8')
    expect(t).toHaveLength(8) // both ran: +a-a+b-b
    expect(isSerialized(t), `trace was interleaved: ${t}`).toBe(true)
  })

  // ★ The scope decision. The npm cache is machine-wide (`npm config get cache` →
  // a single `~/.npm`), so different bases contend on exactly the same resource.
  // Re-introducing a per-base key makes THIS test red.
  it('ALSO serializes bootstraps of DIFFERENT bases — the npm cache is machine-wide, not per-base', async () => {
    const trace = join(baseA, 'trace-crossbase.txt')
    writeFileSync(trace, '')
    const scriptA = join(baseA, 'pA.cjs')
    const scriptB = join(baseB, 'pB.cjs')
    writeFileSync(scriptA, traceScript(trace, 'a', 300))
    writeFileSync(scriptB, traceScript(trace, 'b', 300))
    writeBootstrapConfig(treesA[2], scriptA)
    writeBootstrapConfig(treesB[0], scriptB)

    const [ra, rb] = await Promise.all([
      runMeshWorktreeBootstrap({}, treesA[2]),
      runMeshWorktreeBootstrap({}, treesB[0]),
    ])

    expect(ra.status).toBe('ready')
    expect(rb.status).toBe('ready')
    const t = readFileSync(trace, 'utf8')
    expect(t).toHaveLength(8)
    expect(isSerialized(t), `different bases were allowed to overlap: ${t}`).toBe(true)
  })

  // Three at once is the configuration actually observed failing in production.
  it('serializes three concurrent bootstraps across mixed bases', async () => {
    const trace = join(baseA, 'trace-three.txt')
    writeFileSync(trace, '')
    const specs: Array<[string, string, string]> = [
      [treesA[0], join(baseA, 't3a.cjs'), 'a'],
      [treesA[1], join(baseA, 't3b.cjs'), 'b'],
      [treesB[1], join(baseB, 't3c.cjs'), 'c'],
    ]
    for (const [ws, script, tag] of specs) {
      writeFileSync(script, traceScript(trace, tag, 200))
      writeBootstrapConfig(ws, script)
    }

    const results = await Promise.all(specs.map(([ws]) => runMeshWorktreeBootstrap({}, ws)))
    for (const r of results) expect(r.status).toBe('ready')

    const t = readFileSync(trace, 'utf8')
    expect(t).toHaveLength(12)
    expect(isSerialized(t), `three concurrent bootstraps overlapped: ${t}`).toBe(true)
  })

  // Constraint (2): one failure must not wedge the queue.
  it('a failing bootstrap does not wedge the queue — the next run still executes', async () => {
    const trace = join(baseA, 'trace-fail.txt')
    writeFileSync(trace, '')
    const failScript = join(baseA, 'fFail.cjs')
    const okScript = join(baseA, 'fOk.cjs')
    writeFileSync(failScript, traceScript(trace, 'a', 200, 17))
    writeFileSync(okScript, traceScript(trace, 'b', 200))
    writeBootstrapConfig(treesA[0], failScript)
    writeBootstrapConfig(treesA[1], okScript)

    const [failed, ok] = await Promise.all([
      runMeshWorktreeBootstrap({}, treesA[0]),
      runMeshWorktreeBootstrap({}, treesA[1]),
    ])

    expect(failed.status).toBe('failed')
    expect(failed.exitCode).toBe(17)
    // The whole point: the follower ran to completion despite the leader failing.
    expect(ok.status).toBe('ready')
    const t = readFileSync(trace, 'utf8')
    expect(t).toHaveLength(8)
    expect(isSerialized(t), `trace was interleaved: ${t}`).toBe(true)
  })

  // Constraint (2), the REJECTION half. The test above covers a failed COMMAND, which
  // the runner reports by RESOLVING with status:'failed' — that path never exercises
  // the chain's rejection handling. A run can still reject outright on an
  // infrastructure fault (mesh-graph-workspace-ports catches exactly that), and if the
  // chain were advanced with a bare `.then(onFulfilled)` the rejection would propagate
  // into the tail and every subsequent bootstrap would be dead on arrival. Drive a real
  // rejection through the queue and prove the next run still executes.
  it('a REJECTED run does not wedge the queue — the tail survives an outright throw', async () => {
    const trace = join(baseA, 'trace-reject.txt')
    writeFileSync(trace, '')
    const okScript = join(baseA, 'rOk.cjs')
    writeFileSync(okScript, traceScript(trace, 'b', 150))
    writeBootstrapConfig(treesA[1], okScript)

    // `mesh` is only consumed by loadMeshWorktreeBootstrapConfig; a getter that throws
    // makes the run reject rather than resolve, which is the fault shape in question.
    const exploding = { get policy(): never { throw new Error('infra fault') } }

    const first = startMeshWorktreeBootstrap(exploding, treesA[0])
    const second = startMeshWorktreeBootstrap({}, treesA[1])

    await expect(first.result).rejects.toThrow(/infra fault/)
    // The follower must still run to completion behind the rejected leader.
    const ok = await second.result
    expect(ok.status).toBe('ready')
    expect(readFileSync(trace, 'utf8')).toBe('+b-b')
    // And the depth must not leak, or later clones report a phantom wait forever.
    expect(getWorktreeBootstrapQueueDepth()).toBe(0)
  })

  // Constraint (3): the caller gets an immediately-returned handle, and a run that
  // has to wait reports the position it was queued at.
  it('reports queuePosition 0 for the leader and a nonzero position for a queued follower', async () => {
    const trace = join(baseA, 'trace-pos.txt')
    writeFileSync(trace, '')
    const s0 = join(baseA, 'q0.cjs')
    const s1 = join(baseB, 'q1.cjs')
    writeFileSync(s0, traceScript(trace, 'a', 250))
    writeFileSync(s1, traceScript(trace, 'b', 50))
    writeBootstrapConfig(treesA[0], s0)
    // Deliberately a DIFFERENT base: the position must still count it.
    writeBootstrapConfig(treesB[0], s1)

    const first = startMeshWorktreeBootstrap({}, treesA[0])
    const second = startMeshWorktreeBootstrap({}, treesB[0])

    expect(first.queuePosition).toBe(0)
    expect(second.queuePosition).toBe(1)
    expect(getWorktreeBootstrapQueueDepth()).toBe(2)

    const [a, b] = await Promise.all([first.result, second.result])
    expect(a.status).toBe('ready')
    expect(a.queuePosition).toBeUndefined() // leader: no wait to report
    expect(b.status).toBe('ready')
    expect(b.queuePosition).toBe(1)
    expect(getWorktreeBootstrapQueueDepth()).toBe(0)
  })

  // Constraint (4): a queued-but-not-yet-started run must look 'running' to the three
  // existing gates — it is not ready, and queueing changes nothing about that.
  it('a run waiting its turn is still gated as running (not ready) by the shared predicate', async () => {
    const trace = join(baseA, 'trace-gate.txt')
    writeFileSync(trace, '')
    const slow = join(baseA, 'gSlow.cjs')
    writeFileSync(slow, traceScript(trace, 'a', 400))
    writeBootstrapConfig(treesA[0], slow)
    writeBootstrapConfig(treesA[1], slow)

    const first = startMeshWorktreeBootstrap({}, treesA[0])
    const second = startMeshWorktreeBootstrap({}, treesA[1])
    expect(second.queuePosition).toBe(1)

    // While the follower is still waiting, nothing has produced a terminal state for
    // it — the persisted 'running' stamp its caller wrote stays in force, which is
    // exactly what the dispatch/fast-forward gates read.
    const { shouldDeferDispatchForBootstrap } = await import('../../src/mesh/worktree-bootstrap-config.js')
    expect(
      shouldDeferDispatchForBootstrap({
        worktreeBootstrap: { status: 'running', required: true, startedAt: new Date().toISOString() },
        isLocalWorktree: true,
      } as any),
    ).toBe(true)

    await Promise.all([first.result, second.result])
  })

  // Constraint (5): the queue must not leak depth across runs, or a later clone
  // would report a permanently nonzero wait position.
  it('drains its depth back to zero after every run settles', async () => {
    expect(getWorktreeBootstrapQueueDepth()).toBe(0)
  })
})
