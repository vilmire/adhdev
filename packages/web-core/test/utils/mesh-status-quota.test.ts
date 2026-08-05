import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  collectMachineQuotaGroups,
  collectNodeQuotaEntries,
  describeQuotaFailure,
  formatQuotaFreshness,
  formatQuotaReset,
  formatQuotaWindow,
  quotaProviderLabel,
  quotaUsageTone,
} from '../../src/components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers'
import { canonicalizeRepoMeshStatus } from '../../src/utils/repo-mesh-status'

// Provider quota surfacing on the Status/Runtime tab. Two contracts are under
// test:
//
// 1. UNIT — quota is a MACHINE property, so it renders once per machine, not
//    once per node. It rides a per-node envelope only because git_status is the
//    transport; a machine with several worktree nodes reports identical numbers
//    on each, and rendering per node made one codex reading look like N.
//
// 2. THREE STATES — a machine that has not reported quota yet is a NORMAL
//    freshly-started/idle daemon (first refresh tick is at +15min and idle
//    machines skip ticks), a machine reporting 'unavailable'/'error' looked and
//    failed, and only 'ok' carries numbers. Collapsing those three misleads.

function nodeWithQuota(quota: unknown, reportedAt = Date.now()): any {
  return {
    nodeId: 'node_quota',
    machineLabel: 'Quota Node',
    workspace: '/repo',
    health: 'online',
    providers: [],
    activeSessions: [],
    nodeFacts: { schemaVersion: 1, reportedAt, ...(quota ? { quota } : {}) },
  }
}

const OK_QUOTA = {
  'codex-cli': {
    provider: 'codex-cli', status: 'ok', updatedAt: 1, error: null,
    session: { usedPercent: 26, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 12, windowMinutes: 10080, resetsAt: null },
  },
}

/** One mesh node bound to a machine, with optional facts. */
function node(overrides: Record<string, unknown>): any {
  return {
    nodeId: 'node_x',
    machineLabel: 'Node X',
    workspace: '/repo',
    health: 'online',
    providers: [],
    activeSessions: [],
    ...overrides,
  }
}

function statusOf(nodes: any[]): any {
  return {
    meshId: 'mesh_m', meshName: 'M', repoIdentity: 'repo',
    refreshedAt: '2026-08-05T00:00:00.000Z',
    nodes, queue: { tasks: [] }, ledger: { entries: [] },
  }
}

function facts(quota: unknown, extra: Record<string, unknown> = {}): any {
  return { schemaVersion: 1, reportedAt: 1_000, ...(quota ? { quota } : {}), ...extra }
}

describe('machine-scoped quota grouping', () => {
  it('renders one machine (and one quota block) when several nodes share a daemon', () => {
    // THE core contract of the machine-unit fix. Three worktree nodes on one
    // machine previously produced three identical codex readings.
    const groups = collectMachineQuotaGroups(statusOf([
      node({ nodeId: 'n_main', daemonId: 'daemon_mach_abc', nodeFacts: facts(OK_QUOTA, { machineNickname: 'M1-Server' }) }),
      node({ nodeId: 'n_wt1', daemonId: 'daemon_mach_abc', nodeFacts: facts(OK_QUOTA, { machineNickname: 'M1-Server' }) }),
      node({ nodeId: 'n_wt2', daemonId: 'daemon_mach_abc', nodeFacts: facts(OK_QUOTA, { machineNickname: 'M1-Server' }) }),
    ]))

    expect(groups).toHaveLength(1)
    expect(groups[0].nodeCount).toBe(3)
    expect(groups[0].label).toBe('M1-Server')
    // The codex reading appears exactly once, not once per node.
    expect(groups[0].quota).toHaveLength(1)
    expect(groups[0].quota[0].provider).toBe('codex-cli')
  })

  it('groups by canonical daemon id, so interchangeable id forms are one machine', () => {
    // mach_ / daemon_mach_ / standalone_mach_ are the same machine. Raw-string
    // grouping would split it into three cards and reintroduce the duplication
    // this function exists to remove (the canon-identity defect class).
    const groups = collectMachineQuotaGroups(statusOf([
      node({ nodeId: 'n1', daemonId: 'mach_abc', nodeFacts: facts(OK_QUOTA) }),
      node({ nodeId: 'n2', daemonId: 'daemon_mach_abc', nodeFacts: facts(OK_QUOTA) }),
      node({ nodeId: 'n3', daemonId: 'standalone_mach_abc', nodeFacts: facts(OK_QUOTA) }),
    ]))

    expect(groups).toHaveLength(1)
    expect(groups[0].nodeCount).toBe(3)
  })

  it('keeps genuinely different machines apart', () => {
    const groups = collectMachineQuotaGroups(statusOf([
      node({ nodeId: 'n1', daemonId: 'daemon_mach_aaa', nodeFacts: facts(OK_QUOTA, { machineNickname: 'Air' }) }),
      node({ nodeId: 'n2', daemonId: 'daemon_mach_bbb', nodeFacts: facts(null, { machineNickname: 'Jupiter' }) }),
    ]))

    expect(groups.map(g => g.label)).toEqual(['Air', 'Jupiter'])
    expect(groups.find(g => g.label === 'Air')!.quota).toHaveLength(1)
    // Reported facts but no quota key = the "not collected yet" state, kept.
    expect(groups.find(g => g.label === 'Jupiter')!.quota).toEqual([])
  })

  it('stays silent about machines that never reported a facts bundle', () => {
    // No report at all: saying "not collected yet" would invent a state the
    // machine never described. Distinct from "reported facts, no quota key".
    const groups = collectMachineQuotaGroups(statusOf([
      node({ nodeId: 'n_old', daemonId: 'daemon_mach_old' }),
      node({ nodeId: 'n_new', daemonId: 'daemon_mach_new', nodeFacts: facts(null) }),
    ]))

    expect(groups.map(g => g.machineKey)).toEqual(['daemon_mach_new'])
  })

  it('names a machine by its operator nickname, not a workspace-derived node label', () => {
    // machineLabel falls back to a workspace basename, so two worktrees on one
    // machine carry different machineLabels — using it would name one machine
    // inconsistently depending on which node was seen first.
    const groups = collectMachineQuotaGroups(statusOf([
      node({ nodeId: 'n1', machineLabel: 'adhdev · host', daemonId: 'daemon_mach_abc', nodeFacts: facts(OK_QUOTA, { machineNickname: 'vilmire-Jupiter' }) }),
      node({ nodeId: 'n2', machineLabel: 'adhdev-wt · host', daemonId: 'daemon_mach_abc', nodeFacts: facts(OK_QUOTA, { machineNickname: 'vilmire-Jupiter' }) }),
    ]))

    expect(groups[0].label).toBe('vilmire-Jupiter')

    // With no nickname reported, fall back to the stable machine key rather
    // than an arbitrary node's workspace label.
    const unnamed = collectMachineQuotaGroups(statusOf([
      node({ nodeId: 'n1', machineLabel: 'adhdev · host', daemonId: 'daemon_mach_zzz', nodeFacts: facts(OK_QUOTA) }),
    ]))
    expect(unnamed[0].label).toBe('daemon_mach_zzz')
  })

  it('prefers the freshest bundle when a machine has nodes reporting at different times', () => {
    const stale = { 'codex-cli': { provider: 'codex-cli', status: 'ok', updatedAt: 1, error: null, session: { usedPercent: 10, windowMinutes: 300, resetsAt: null }, weekly: null } }
    const fresh = { 'codex-cli': { provider: 'codex-cli', status: 'ok', updatedAt: 2, error: null, session: { usedPercent: 55, windowMinutes: 300, resetsAt: null }, weekly: null } }
    const groups = collectMachineQuotaGroups(statusOf([
      node({ nodeId: 'n_old', daemonId: 'daemon_mach_abc', nodeFacts: { schemaVersion: 1, reportedAt: 1_000, quota: stale, machineNickname: 'Air' } }),
      node({ nodeId: 'n_new', daemonId: 'daemon_mach_abc', nodeFacts: { schemaVersion: 1, reportedAt: 9_000, quota: fresh, machineNickname: 'Air' } }),
    ]))

    expect(groups).toHaveLength(1)
    expect(groups[0].reportedAt).toBe(9_000)
    expect(groups[0].quota[0].quota.session?.usedPercent).toBe(55)
  })

  it('does not collide unidentified nodes into one shared machine', () => {
    // No daemonId and no machineId: each falls back to its own nodeId, so two
    // unrelated unidentified nodes stay separate instead of merging under ''.
    const groups = collectMachineQuotaGroups(statusOf([
      node({ nodeId: 'n_a', nodeFacts: facts(OK_QUOTA) }),
      node({ nodeId: 'n_b', nodeFacts: facts(OK_QUOTA) }),
    ]))

    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.machineKey).sort()).toEqual(['n_a', 'n_b'])
  })

  it('survives a malformed node list instead of throwing in the render path', () => {
    expect(collectMachineQuotaGroups(statusOf([]))).toEqual([])
    expect(collectMachineQuotaGroups(statusOf([
      node({ nodeId: 'n1', daemonId: 'daemon_mach_abc', nodeFacts: facts('not-an-object') }),
    ]))[0].quota).toEqual([])
  })
})

describe('provider quota helpers', () => {
  it('reads quota entries off the facts bundle in stable label order', () => {
    const entries = collectNodeQuotaEntries(nodeWithQuota({
      kimi: { provider: 'kimi', status: 'ok', session: null, weekly: null, updatedAt: 1, error: null },
      'codex-cli': { provider: 'codex-cli', status: 'ok', session: null, weekly: null, updatedAt: 1, error: null },
      'claude-cli': { provider: 'claude-cli', status: 'ok', session: null, weekly: null, updatedAt: 1, error: null },
    }))

    // Sorted by display label so providers do not reshuffle between refreshes.
    expect(entries.map(e => e.provider)).toEqual(['claude-cli', 'codex-cli', 'kimi'])
    expect(entries.map(e => quotaProviderLabel(e.provider))).toEqual(['Claude Code', 'Codex CLI', 'Kimi Code'])
  })

  it('distinguishes "never reported" from "reported and failing"', () => {
    // State 1 — unreported. No quota key at all: the honest state for a daemon
    // whose first refresh tick has not fired yet. Must NOT look like a failure.
    expect(collectNodeQuotaEntries(nodeWithQuota(null))).toEqual([])

    // State 2 — reported, but the node could not read it. Present as an entry,
    // so a reader can tell this apart from state 1.
    const failing = collectNodeQuotaEntries(nodeWithQuota({
      'codex-cli': {
        provider: 'codex-cli',
        status: 'unavailable',
        session: null,
        weekly: null,
        updatedAt: 1,
        error: 'codex CLI is not installed',
        metadata: { failureKind: 'not-installed' },
      },
    }))
    expect(failing).toHaveLength(1)
    expect(failing[0].quota.status).toBe('unavailable')
    // No windows -> the UI renders the failure text rather than usage badges.
    expect(formatQuotaWindow(failing[0].quota.session)).toBeNull()
    expect(formatQuotaWindow(failing[0].quota.weekly)).toBeNull()
  })

  it('surfaces failureKind, which is what separates not-installed from a broken channel', () => {
    expect(describeQuotaFailure({
      provider: 'codex-cli', status: 'unavailable', session: null, weekly: null, updatedAt: 1,
      error: 'could not reach app-server', metadata: { failureKind: 'spawn-failed' },
    } as any)).toBe('could not reach app-server (spawn failed)')

    // Kind already implied by the message -> no redundant parenthetical.
    expect(describeQuotaFailure({
      provider: 'kimi', status: 'error', session: null, weekly: null, updatedAt: 1,
      error: 'expired token', metadata: { failureKind: 'expired-token' },
    } as any)).toBe('expired token')

    // Neither message nor kind: still says something definite, never blank.
    expect(describeQuotaFailure({
      provider: 'kimi', status: 'unavailable', session: null, weekly: null, updatedAt: 1, error: null,
    } as any)).toBe('not available on this node')
    expect(describeQuotaFailure({
      provider: 'kimi', status: 'error', session: null, weekly: null, updatedAt: 1, error: null,
    } as any)).toBe('could not read quota')
  })

  it('formats usage windows and tints at the same 70/90 thresholds as the CLI', () => {
    const now = Date.parse('2026-08-05T00:00:00.000Z')
    expect(formatQuotaWindow({ usedPercent: 23.5, windowMinutes: 300, resetsAt: null }, now))
      .toBe('23.5% used')
    // One decimal, same as the CLI's own toFixed(1) rendering.
    expect(formatQuotaWindow({ usedPercent: 7.849, windowMinutes: 300, resetsAt: null }, now))
      .toBe('7.8% used')
    expect(formatQuotaWindow(
      { usedPercent: 12, windowMinutes: 300, resetsAt: now + (2 * 60 + 14) * 60_000 }, now,
    )).toBe('12.0% used · resets in 2h 14m')

    expect(quotaUsageTone(0)).toBe('good')
    expect(quotaUsageTone(69.9)).toBe('good')
    expect(quotaUsageTone(70)).toBe('warn')
    expect(quotaUsageTone(89.9)).toBe('warn')
    expect(quotaUsageTone(90)).toBe('danger')
    expect(quotaUsageTone(NaN)).toBe('default')
  })

  it('omits the reset clause rather than inventing one when the node reported none', () => {
    const now = Date.parse('2026-08-05T00:00:00.000Z')
    expect(formatQuotaReset(null, now)).toBeNull()
    expect(formatQuotaReset(undefined, now)).toBeNull()
    expect(formatQuotaReset(0, now)).toBeNull()
    expect(formatQuotaReset(now - 1000, now)).toBe('resets now')
    expect(formatQuotaReset(now + 45 * 60_000, now)).toBe('resets in 45m')
    expect(formatQuotaReset(now + 26 * 60 * 60_000, now)).toBe('resets in 1d 2h')
  })

  it('derives freshness from the bundle reportedAt, with no separate TTL field', () => {
    const now = Date.parse('2026-08-05T00:00:00.000Z')
    expect(formatQuotaFreshness(now - 30_000, now)).toBe('just now')
    expect(formatQuotaFreshness(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatQuotaFreshness(now - (3 * 60 + 7) * 60_000, now)).toBe('3h 7m ago')
    expect(formatQuotaFreshness(null, now)).toBeNull()

    // The design forbids asserting an expiry here: neither the refresh cadence
    // nor the delivery cadence is in the UI's control, so age is reported and
    // judged rather than turned into a stale/fresh verdict.
    const helpers = fs.readFileSync(
      path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers.ts'),
      'utf8',
    )
    expect(helpers).not.toMatch(/QUOTA_TTL|quotaTtl|isQuotaStale/)
  })

  it('survives a malformed quota map instead of throwing in the render path', () => {
    expect(collectNodeQuotaEntries(nodeWithQuota('not-an-object'))).toEqual([])
    expect(collectNodeQuotaEntries(nodeWithQuota(['array']))).toEqual([])
    expect(collectNodeQuotaEntries({ nodeId: 'n', nodeFacts: undefined } as any)).toEqual([])
    expect(collectNodeQuotaEntries(nodeWithQuota({ 'codex-cli': null }))).toEqual([])
  })

  it('carries quota through the canonicalizer to the component, unmodified', () => {
    // The canonicalizer rebuilds nodes field-by-field; nodeFacts is an OPAQUE
    // pass-through, so quota must survive without repo-mesh-status.ts knowing
    // the field exists.
    const quota = {
      'claude-cli': {
        provider: 'claude-cli', status: 'ok', updatedAt: 1, error: null,
        session: { usedPercent: 42, windowMinutes: 300, resetsAt: null },
        weekly: { usedPercent: 8, windowMinutes: 10080, resetsAt: null },
      },
    }
    const canonical = canonicalizeRepoMeshStatus({
      meshId: 'mesh_q', meshName: 'Q', repoIdentity: 'repo', refreshedAt: '2026-08-05T00:00:00.000Z',
      nodes: [nodeWithQuota(quota)], queue: { tasks: [] }, ledger: { entries: [] },
    } as any)

    expect(canonical.nodes[0].nodeFacts?.quota).toEqual(quota)
    expect(collectNodeQuotaEntries(canonical.nodes[0])).toHaveLength(1)
  })

  it('renders the three states distinctly, in the machine section', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshObservabilitySurface/MeshStatusTab.tsx'),
      'utf8',
    )
    // Mounted as its own machine section, ABOVE the node list.
    expect(source).toContain('<MeshMachinesQuotaSection status={canonicalStatus} />')
    expect(source).toContain("t('mesh.status.machinesQuota')")
    expect(source.indexOf('<MeshMachinesQuotaSection'))
      .toBeLessThan(source.indexOf("t('mesh.status.nodesRuntime')"))
    // Quota must NOT render per node any more — that was the duplication bug.
    expect(source).not.toContain('<MeshNodeQuotaRows')
    expect(source).not.toContain('collectNodeQuotaEntries')
    // Unreported -> muted secondary text, explicitly NOT a warn/danger Badge.
    expect(source).toContain("t('mesh.status.quotaNotCollected')")
    expect(source).toMatch(/quotaNotCollected[\s\S]{0,80}<\/div>/)
    // Failing -> the failureKind-bearing description.
    expect(source).toContain('describeQuotaFailure(quota)')
    // Normal -> both windows, tinted by usage.
    expect(source).toContain('quotaUsageTone(quota.session?.usedPercent ?? NaN)')
    expect(source).toContain('quotaUsageTone(quota.weekly?.usedPercent ?? NaN)')
  })

  it('groups on the canonical daemon id helper rather than raw string equality', () => {
    const helpers = fs.readFileSync(
      path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers.ts'),
      'utf8',
    )
    // Raw daemon-id comparison is the recurring identity defect in this repo;
    // here it would split one machine across several cards.
    expect(helpers).toContain("import { canonicalDaemonId } from '@adhdev/mesh-shared'")
    expect(helpers).toContain('canonicalDaemonId(node.daemonId)')
  })

  it('imports quota types without pulling the daemon-core barrel into the browser bundle', () => {
    const helpers = fs.readFileSync(
      path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers.ts'),
      'utf8',
    )
    // web-core ships to the browser: a VALUE import from the daemon-core barrel
    // drags Node builtins in and breaks the dashboard. The remaining mesh-shaped
    // quota type (MeshNodeFactsProviderQuota, used by NodeQuotaEntry /
    // collectNodeQuotaEntries / collectMachineQuotaGroups, which stayed here
    // because they take RepoMeshNodeStatus/RepoMeshStatus) is type-only from
    // the dependency-free mesh-shared leaf.
    expect(helpers).toContain("import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared'")
    expect(helpers).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'@adhdev\/daemon-core'/m)
  })

  it('presentation helpers moved to utils/quota-format.ts stay bundle-safe there too', () => {
    // quotaProviderLabel/formatQuotaWindow/formatQuotaReset/quotaUsageTone/
    // describeQuotaFailure/formatQuotaFreshness were relocated out of this
    // MeshGraph-scoped file (pure move, no behavior change) so the machine
    // page and session-info dialog can format quota without importing from
    // the mesh observability subtree. meshSurfaceHelpers.ts re-exports them so
    // this file's own imports above keep resolving unchanged.
    const quotaFormat = fs.readFileSync(
      path.join(import.meta.dirname, '../../src/utils/quota-format.ts'),
      'utf8',
    )
    expect(quotaFormat).toContain("import type { MeshNodeFactsProviderQuota, MeshNodeFactsQuotaWindow } from '@adhdev/mesh-shared'")
    expect(quotaFormat).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'@adhdev\/daemon-core'/m)

    const helpers = fs.readFileSync(
      path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers.ts'),
      'utf8',
    )
    expect(helpers).toContain("from '../../../utils/quota-format'")
  })
})
