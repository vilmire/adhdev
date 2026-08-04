import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  collectNodeQuotaEntries,
  describeQuotaFailure,
  formatQuotaFreshness,
  formatQuotaReset,
  formatQuotaWindow,
  quotaProviderLabel,
  quotaUsageTone,
} from '../../src/components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers'
import { canonicalizeRepoMeshStatus } from '../../src/utils/repo-mesh-status'

// Provider quota surfacing on the Status/Runtime tab. The behaviour under test
// is the THREE-STATE distinction: a node that has not reported quota yet is a
// NORMAL freshly-started/idle daemon (the refresh loop's first tick is at
// +15min and idle machines skip ticks), a node reporting status
// 'unavailable'/'error' looked and failed, and only 'ok' carries numbers.
// Collapsing those three is the defect this suite guards against.

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

  it('renders the three states distinctly in MeshStatusTab', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshObservabilitySurface/MeshStatusTab.tsx'),
      'utf8',
    )
    // Mounted on the node runtime row.
    expect(source).toContain('<MeshNodeQuotaRows node={node} />')
    // Unreported -> muted secondary text, explicitly NOT a warn/danger Badge.
    expect(source).toContain("t('mesh.status.quotaNotCollected')")
    expect(source).toMatch(/quotaNotCollected[\s\S]{0,80}<\/div>/)
    // A node that never sent facts at all says nothing about quota.
    expect(source).toContain('if (!node.nodeFacts) return null')
    // Failing -> the failureKind-bearing description.
    expect(source).toContain('describeQuotaFailure(quota)')
    // Normal -> both windows, tinted by usage.
    expect(source).toContain('quotaUsageTone(quota.session?.usedPercent ?? NaN)')
    expect(source).toContain('quotaUsageTone(quota.weekly?.usedPercent ?? NaN)')
  })

  it('imports quota types without pulling the daemon-core barrel into the browser bundle', () => {
    const helpers = fs.readFileSync(
      path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers.ts'),
      'utf8',
    )
    // web-core ships to the browser: a VALUE import from the daemon-core barrel
    // drags Node builtins in and breaks the dashboard. Quota types come from
    // the dependency-free mesh-shared leaf, type-only.
    expect(helpers).toContain("import type { MeshNodeFactsProviderQuota, MeshNodeFactsQuotaWindow } from '@adhdev/mesh-shared'")
    expect(helpers).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'@adhdev\/daemon-core'/m)
  })
})
