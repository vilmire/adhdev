import { describe, expect, it, vi, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

// Sparse mesh policy storage (docs/design/2026-10-07-mesh-workspace-policy.md §A):
// meshes.json stores only the keys the owner set; every reader resolves through
// resolveMeshPolicy. The load-time migration turns the old full-default copies into
// overrides by ONE mechanical rule — a stored value that resolves exactly as an unset
// key would is a default — plus the approved E2 strip of a copied
// `sessionCleanupOnNodeRemove: 'preserve'`.

const testTmpDir = join(tmpdir(), `adhdev-policy-sparse-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
}))

import {
  resolveMeshPolicy,
  normalizePolicyOverrides,
  mergePolicyOverrides,
  migratePolicyToSparseOverrides,
  resolveMaxParallelTasks,
  RETIRED_MESH_POLICY_KEYS,
  MESH_MAX_PARALLEL_TASKS_MAX,
} from '../../src/repo-mesh-types.js'
import { listMeshes, listMeshesReadOnly, createMesh, updateMesh } from '../../src/config/mesh-config.js'

// ── Fixtures: the policy blocks of the live meshes.json files (2026-10-07, read-only
// survey of ~/.adhdev, ~/.adhdev-preview, ~/.adhdev-stable, ~/.adhdev-standalone,
// ~/.adhdev-standalone-dev). Each distinct SHAPE once — values verbatim, ids dropped.
const RETIRED_COPY = { requirePreTaskCheckpoint: false, requirePostTaskCheckpoint: true, dirtyWorkspaceBehavior: 'warn' }
const LIVE_FIXTURES: Record<string, { before: Record<string, unknown>; after: Record<string, unknown> }> = {
  // preview (main mesh): real owner overrides on top of the copied defaults.
  preview: {
    before: {
      ...RETIRED_COPY, requireApprovalForPush: false, allowAutoPublishSubmoduleMainCommits: true,
      maxParallelTasks: 64, spawnedSessionVisibility: 'hidden', delegatedWorkerAutoApprove: true,
      delegatedWorkerDangerousModeAllow: true, sessionCleanupOnNodeRemove: 'stop_and_delete', magiSessionCleanup: 'stop_and_delete',
      autoFastForward: { enabled: true, requireCleanSubmodules: true, remoteNodes: true, mode: 'continuous' },
      maxTaskRetries: 1, idleActiveMissionReminder: true, delegatedSessionIdleTtlMinutes: 30,
      requireApprovalForDestructiveGit: true, schedulingStrategy: 'fitness',
    },
    after: {
      requireApprovalForPush: false, allowAutoPublishSubmoduleMainCommits: true, delegatedWorkerDangerousModeAllow: true,
      sessionCleanupOnNodeRemove: 'stop_and_delete',
      autoFastForward: { enabled: true, requireCleanSubmodules: true, remoteNodes: true, mode: 'continuous' },
      requireApprovalForDestructiveGit: true, schedulingStrategy: 'fitness',
    },
  },
  // stable: default copy + Smart distribution + the copied 'preserve' (E2).
  stable: {
    before: {
      ...RETIRED_COPY, requireApprovalForPush: true, allowAutoPublishSubmoduleMainCommits: false, requireApprovalForDestructiveGit: true,
      maxParallelTasks: 64, spawnedSessionVisibility: 'hidden', delegatedWorkerAutoApprove: true,
      sessionCleanupOnNodeRemove: 'preserve', magiSessionCleanup: 'stop_and_delete',
      autoFastForward: { enabled: true, requireCleanSubmodules: true }, maxTaskRetries: 1, idleActiveMissionReminder: true,
      schedulingStrategy: 'fitness',
    },
    after: { requireApprovalForDestructiveGit: true, schedulingStrategy: 'fitness' },
  },
  // standalone-dev: a pure default copy (with the idle TTL key).
  standaloneDevDefaultCopy: {
    before: {
      ...RETIRED_COPY, requireApprovalForPush: true, allowAutoPublishSubmoduleMainCommits: false, maxParallelTasks: 64,
      spawnedSessionVisibility: 'hidden', delegatedWorkerAutoApprove: true, sessionCleanupOnNodeRemove: 'preserve',
      magiSessionCleanup: 'stop_and_delete', autoFastForward: { enabled: true, requireCleanSubmodules: true },
      maxTaskRetries: 1, idleActiveMissionReminder: true, delegatedSessionIdleTtlMinutes: 30,
    },
    after: {},
  },
  // standalone-dev: visible spawned sessions.
  standaloneDevVisible: {
    before: {
      ...RETIRED_COPY, requireApprovalForPush: true, allowAutoPublishSubmoduleMainCommits: false, maxParallelTasks: 64,
      spawnedSessionVisibility: 'visible', delegatedWorkerAutoApprove: true, sessionCleanupOnNodeRemove: 'preserve',
      autoFastForward: { enabled: true, requireCleanSubmodules: true }, maxTaskRetries: 1, idleActiveMissionReminder: true,
      delegatedSessionIdleTtlMinutes: 30,
    },
    after: { spawnedSessionVisibility: 'visible' },
  },
  // standalone: a deliberate cap of 4 and delete_stopped cleanup.
  standaloneCap4: {
    before: {
      ...RETIRED_COPY, requireApprovalForPush: false, allowAutoPublishSubmoduleMainCommits: true, requireApprovalForDestructiveGit: true,
      maxParallelTasks: 4, spawnedSessionVisibility: 'hidden', delegatedWorkerAutoApprove: true,
      sessionCleanupOnNodeRemove: 'delete_stopped', magiSessionCleanup: 'stop_and_delete',
      autoFastForward: { enabled: true, requireCleanSubmodules: true }, maxTaskRetries: 1, idleActiveMissionReminder: true,
      schedulingStrategy: 'fitness',
    },
    after: {
      requireApprovalForPush: false, allowAutoPublishSubmoduleMainCommits: true, requireApprovalForDestructiveGit: true,
      maxParallelTasks: 4, sessionCleanupOnNodeRemove: 'delete_stopped', schedulingStrategy: 'fitness',
    },
  },
  // standalone: pre-07-09 shape — the PAST default maxParallelTasks:2 must survive
  // (today's default resolves to 64, so dropping it would change behavior).
  standaloneLegacyCap2: {
    before: {
      ...RETIRED_COPY, requireApprovalForPush: true, allowAutoPublishSubmoduleMainCommits: false, requireApprovalForDestructiveGit: true,
      maxParallelTasks: 2, spawnedSessionVisibility: 'visible', sessionCleanupOnNodeRemove: 'preserve', maxTaskRetries: 1,
    },
    after: { requireApprovalForDestructiveGit: true, maxParallelTasks: 2, spawnedSessionVisibility: 'visible' },
  },
  // ~/.adhdev: a pure default copy.
  stableDefaultCopy: {
    before: {
      ...RETIRED_COPY, requireApprovalForPush: true, allowAutoPublishSubmoduleMainCommits: false, maxParallelTasks: 64,
      spawnedSessionVisibility: 'hidden', delegatedWorkerAutoApprove: true, sessionCleanupOnNodeRemove: 'preserve',
      autoFastForward: { enabled: true, requireCleanSubmodules: true }, maxTaskRetries: 1, idleActiveMissionReminder: true,
      delegatedSessionIdleTtlMinutes: 30,
    },
    after: {},
  },
}

/** resolveMeshPolicy minus the one key the migration deliberately changes (E2). */
function resolvedWithoutE2(policy: unknown): Record<string, unknown> {
  const { sessionCleanupOnNodeRemove: _e2, ...rest } = resolveMeshPolicy(policy) as unknown as Record<string, unknown>
  return rest
}

function configPath(): string {
  return join(testConfigDir, 'meshes.json')
}

afterEach(() => {
  try { rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('resolveMaxParallelTasks — the unset default goes through the clamp', () => {
  it('unset and the stored default resolve to the same cap (64), not 200 vs 64', () => {
    expect(resolveMaxParallelTasks(undefined)).toBe(MESH_MAX_PARALLEL_TASKS_MAX)
    expect(resolveMaxParallelTasks(null)).toBe(MESH_MAX_PARALLEL_TASKS_MAX)
    expect(resolveMaxParallelTasks(200)).toBe(MESH_MAX_PARALLEL_TASKS_MAX)
    expect(resolveMaxParallelTasks('junk')).toBe(MESH_MAX_PARALLEL_TASKS_MAX)
    expect(resolveMaxParallelTasks(4)).toBe(4)
    // …so dropping a stored 64 keeps the cap at 64.
    expect(resolveMeshPolicy({}).maxParallelTasks).toBe(resolveMeshPolicy({ maxParallelTasks: 64 }).maxParallelTasks)
  })
})

describe('normalizePolicyOverrides — resolve-neutral sparse form (property)', () => {
  // Deterministic PRNG so a failure is reproducible.
  let seed = 0x5eed
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
  const VALUES: Record<string, readonly unknown[]> = {
    requireApprovalForPush: [true, false, 'yes', 0, null],
    allowAutoPublishSubmoduleMainCommits: [true, false, 'true'],
    maxParallelTasks: [1, 2, 4, 64, 99, 200, -5, 'x', 3.7],
    schedulingStrategy: ['first_eligible', 'fitness', 'least_loaded', 'round_robin', 'priority_only', 'bogus', ''],
    spawnedSessionVisibility: ['hidden', 'visible', 'nope'],
    delegatedWorkerAutoApprove: [true, false, 'no'],
    delegatedWorkerDangerousModeAllow: [true, false],
    allowSendKeysDestructive: [true, false],
    sessionCleanupOnNodeRemove: ['preserve', 'stop', 'delete_stopped', 'stop_and_delete', 'bogus'],
    autoFastForward: [{ enabled: true }, { enabled: false }, { enabled: true, remoteNodes: true }, { mode: 'continuous' }, { maxBehind: 3 }, 'junk'],
    maxTaskRetries: [0, 1, 2, 5, 'x'],
    idleActiveMissionReminder: [true, false],
    delegatedSessionIdleTtlMinutes: [0, false, 2, 30, 90, 'x'],
    coordinatorIdlePushPolicy: ['always', 'auto_silent_on_dispatch', 'bogus'],
    quotaRouting: [{}, { sessionMinRemainingPercent: 10 }, { sessionMinRemainingPercent: 25 }, { quotaBusyFallback: false }, 'junk'],
    onDependencyFailure: ['block', 'cancel'],
    worktreeBaseDir: ['/tmp/wt', '', '  '],
    requirePostTaskCheckpoint: [true, false],
    dirtyWorkspaceBehavior: ['block', 'warn'],
    magiSessionCleanup: ['preserve'],
    refineConfig: [{ validation: { commands: [] } }],
    requireApprovalForDestructiveGit: [true],
  }

  it('resolve(normalize(p)) == resolve(p), normalize is idempotent, and no retired key survives — 500 random policies', () => {
    for (let i = 0; i < 500; i++) {
      const p: Record<string, unknown> = {}
      for (const [key, values] of Object.entries(VALUES)) if (rand() < 0.5) p[key] = pick(values)
      const sparse = normalizePolicyOverrides(p)
      expect(resolveMeshPolicy(sparse)).toEqual(resolveMeshPolicy(p))
      expect(normalizePolicyOverrides(sparse)).toEqual(sparse)
      for (const retired of RETIRED_MESH_POLICY_KEYS) {
        expect(sparse).not.toHaveProperty(retired)
        expect(resolveMeshPolicy(p)).not.toHaveProperty(retired)
      }
    }
  })

  it('an invalid onDependencyFailure is rejected on write, not silently stored as block', () => {
    expect(() => normalizePolicyOverrides({ onDependencyFailure: 'explode' })).toThrow(/invalid_on_dependency_failure/)
  })

  it('an explicit preserve is a real override (unset means the context default)', () => {
    expect(normalizePolicyOverrides({ sessionCleanupOnNodeRemove: 'preserve' })).toEqual({ sessionCleanupOnNodeRemove: 'preserve' })
    expect(resolveMeshPolicy({})).not.toHaveProperty('sessionCleanupOnNodeRemove')
  })
})

describe('mergePolicyOverrides — the update_mesh patch', () => {
  it('sets a key, `null` resets it to the default, an absent key is untouched', () => {
    const base = mergePolicyOverrides(undefined, { requireApprovalForPush: false, maxParallelTasks: 4 })
    expect(base).toEqual({ requireApprovalForPush: false, maxParallelTasks: 4 })
    const next = mergePolicyOverrides(base, { requireApprovalForPush: null } as any)
    expect(next).toEqual({ maxParallelTasks: 4 })
    expect(resolveMeshPolicy(next).requireApprovalForPush).toBe(true)
  })

  it('a patch equal to the default stores nothing', () => {
    expect(mergePolicyOverrides({}, { spawnedSessionVisibility: 'hidden', maxParallelTasks: 64 })).toEqual({})
  })

  it('createMesh/updateMesh persist only what was set, with the storage marker', () => {
    const mesh = createMesh({ name: 'm', repoIdentity: 'github.com/acme/sparse', policy: { maxParallelTasks: 3 } })
    expect(mesh.policy).toEqual({ maxParallelTasks: 3 })
    expect(mesh.policyStorage).toBe(2)
    const updated = updateMesh(mesh.id, { policy: { maxParallelTasks: null, schedulingStrategy: 'fitness' } })
    expect(updated?.policy).toEqual({ schedulingStrategy: 'fitness' })
    const onDisk = JSON.parse(readFileSync(configPath(), 'utf-8'))
    expect(onDisk.meshes[0].policy).toEqual({ schedulingStrategy: 'fitness' })
  })
})

describe('sparse-policy migration on the live meshes.json shapes', () => {
  it.each(Object.entries(LIVE_FIXTURES))('%s: overrides only, behavior-neutral except E2', (_name, { before, after }) => {
    const migrated = migratePolicyToSparseOverrides(before)
    expect(migrated).toEqual(after)
    // Neutrality: every key resolves as before, except the deliberate E2 change.
    expect(resolvedWithoutE2(migrated)).toEqual(resolvedWithoutE2(before))
    // E2: a copied 'preserve' is gone (the refine worktree default now applies); any
    // other explicit cleanup mode is an owner choice and is kept.
    if (before.sessionCleanupOnNodeRemove === 'preserve') expect(migrated).not.toHaveProperty('sessionCleanupOnNodeRemove')
    else expect(migrated.sessionCleanupOnNodeRemove).toBe(before.sessionCleanupOnNodeRemove)
    // Idempotent: a re-run changes nothing.
    expect(migratePolicyToSparseOverrides(migrated)).toEqual(migrated)
  })

  it('never throws on a value a write would reject — keeps it verbatim instead', () => {
    expect(migratePolicyToSparseOverrides({ onDependencyFailure: 'explode', maxParallelTasks: 64, schedulingStrategy: 'fitness' }))
      .toEqual({ onDependencyFailure: 'explode', schedulingStrategy: 'fitness' })
  })

  it('runs once at load: rewrites meshes.json, marks policyStorage: 2, keeps a one-time backup, then leaves the file alone', () => {
    const meshes = Object.entries(LIVE_FIXTURES).map(([name, { before }], i) => ({
      id: `mesh_${i}`, name, repoIdentity: `github.com/acme/${name}`, policy: before, coordinator: {}, nodes: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }))
    mkdirSync(testConfigDir, { recursive: true })
    const original = JSON.stringify({ meshes }, null, 2)
    writeFileSync(configPath(), original, 'utf-8')

    // A read-only listing migrates in memory but never writes.
    expect(listMeshesReadOnly()[0].policyStorage).toBe(2)
    expect(readFileSync(configPath(), 'utf-8')).toBe(original)

    const loaded = listMeshes()
    for (const [i, [, { after }]] of Object.entries(LIVE_FIXTURES).entries()) {
      expect(loaded[i].policy).toEqual(after)
      expect(loaded[i].policyStorage).toBe(2)
    }
    const onDisk = JSON.parse(readFileSync(configPath(), 'utf-8'))
    expect(onDisk.meshes.map((m: any) => m.policy)).toEqual(Object.values(LIVE_FIXTURES).map(f => f.after))
    expect(onDisk.meshes.every((m: any) => m.policyStorage === 2)).toBe(true)
    // The pre-migration file is preserved byte-for-byte.
    expect(readFileSync(`${configPath()}.bak-policy-sparse`, 'utf-8')).toBe(original)

    // Second load: nothing left to migrate → the file is not rewritten.
    const afterFirst = readFileSync(configPath(), 'utf-8')
    listMeshes()
    expect(readFileSync(configPath(), 'utf-8')).toBe(afterFirst)
  })
})
