/**
 * Coordinator-held node state in the topology view: a remote node's last-known
 * git state (with submodule children) renders immediately with a quiet per-node
 * age / refreshing / unreachable marker — never a page-level banner — and an
 * unknown git state never renders as BLOCKED REVIEW.
 */
import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@xyflow/react', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>()
    return { ...actual, Handle: () => null }
})

import { MeshNodeCard } from '../../src/components/MeshGraph/MeshGraphView'
import { getMeshGraphAttentionBadge, getMeshGraphObservationHint } from '../../src/components/MeshGraph/meshGraphViewModel'
import { buildMeshGraph } from '../../src/utils/mesh-visualization'
import { canonicalizeRepoMeshStatus, extractRepoMeshStatus } from '../../src/utils/repo-mesh-status'
import { classifyDashboardMeshLoadFailure } from '../../src/components/dashboard/dashboard-mesh-load-failure'

const NOW = Date.now()

function remoteStatus(nodeOverrides: Record<string, unknown> = {}) {
    return {
        success: true,
        meshId: 'mesh_obs',
        meshName: 'Obs',
        repoIdentity: 'github.com/acme/obs',
        defaultBranch: 'main',
        refreshedAt: new Date(NOW).toISOString(),
        nodes: [
            {
                nodeId: 'node_local',
                machineLabel: 'Mac',
                workspace: '/Users/me/adhdev',
                daemonId: 'daemon_local',
                health: 'online',
                providers: [],
                activeSessions: [],
                connection: { state: 'self', transport: 'local', reported: true },
                git: { isGitRepo: true, workspace: '/Users/me/adhdev', branch: 'main', headCommit: 'aaa', upstream: 'origin/main', upstreamStatus: 'fresh', ahead: 0, behind: 0, lastCheckedAt: NOW },
                gitObservation: { source: 'self', observedAt: NOW, refreshing: false, unreachableSince: null },
            },
            {
                nodeId: 'node_mainpc',
                machineLabel: 'MainPC',
                workspace: 'C:/work/adhdev',
                daemonId: 'daemon_mainpc',
                health: 'online',
                providers: [],
                activeSessions: [],
                connection: { state: 'unknown', transport: 'unknown', reported: false },
                git: {
                    isGitRepo: true,
                    workspace: 'C:/work/adhdev',
                    branch: 'main',
                    headCommit: 'bbb',
                    upstream: 'origin/main',
                    upstreamStatus: 'fresh',
                    ahead: 0,
                    behind: 0,
                    lastCheckedAt: NOW - 12 * 60_000,
                    submodules: [
                        { path: 'adhdev-providers', commit: 'p1', dirty: false, outOfSync: false },
                        { path: 'oss', commit: 'o1', dirty: false, outOfSync: false },
                    ],
                },
                gitObservation: { source: 'member_push', observedAt: NOW - 12 * 60_000, refreshing: false, unreachableSince: null },
                ...nodeOverrides,
            },
        ],
    }
}

function renderCard(node: any): string {
    return renderToString(<MeshNodeCard {...({ id: node.id, data: { graphNode: node, compact: false }, selected: false } as any)} />)
}

describe('topology — coordinator-held remote node state', () => {
    it('renders cached remote submodule children immediately, each inheriting the parent observation', () => {
        // Through the same wire extraction the dashboard uses (daemon response envelope).
        const extracted = extractRepoMeshStatus({ success: true, result: remoteStatus() } as any)!
        expect(extracted.nodes.find(node => node.nodeId === 'node_mainpc')?.gitObservation).toMatchObject({ source: 'member_push' })
        const graph = buildMeshGraph(extracted)
        const submodules = graph.nodes.filter(node => node.parentNodeId === 'node_mainpc')
        expect(submodules.map(node => node.submodulePath).sort()).toEqual(['adhdev-providers', 'oss'])
        for (const submodule of submodules) {
            expect(submodule.gitObservation).toMatchObject({ source: 'member_push' })
        }
        const mainpc = graph.nodes.find(node => node.id === 'node_mainpc')!
        expect(getMeshGraphObservationHint(mainpc, NOW)).toMatchObject({ kind: 'aged' })
        const html = renderCard(mainpc)
        expect(html).toContain('>as of 12m ago</span>')
    })

    it('marks an unreachable node on the card itself, keeping its last-known state', () => {
        const status = remoteStatus({
            gitObservation: { source: 'member_push', observedAt: NOW - 30 * 60_000, refreshing: false, unreachableSince: NOW - 5 * 60_000, lastRefreshError: 'P2P timeout' },
        })
        const graph = buildMeshGraph(canonicalizeRepoMeshStatus(status as any))
        const mainpc = graph.nodes.find(node => node.id === 'node_mainpc')!
        expect(mainpc.branch).toBe('main')
        expect(getMeshGraphObservationHint(mainpc, NOW)).toMatchObject({ kind: 'unreachable' })
        // A visible pill on the card (not only the hover tooltip).
        expect(renderCard(mainpc)).toContain('>unreachable · last known 30m ago</span>')
    })

    it('shows a refreshing marker while the coordinator re-probes, and nothing for local/fresh nodes', () => {
        const refreshing = buildMeshGraph(canonicalizeRepoMeshStatus(remoteStatus({
            gitObservation: { source: 'coordinator_probe', observedAt: NOW - 4 * 60_000, refreshing: true, unreachableSince: null },
        }) as any))
        const mainpc = refreshing.nodes.find(node => node.id === 'node_mainpc')!
        expect(renderCard(mainpc)).toContain('>as of 4m ago · refreshing</span>')
        const local = refreshing.nodes.find(node => node.id === 'node_local')!
        expect(getMeshGraphObservationHint(local, NOW)).toBeNull()
        const fresh = buildMeshGraph(canonicalizeRepoMeshStatus(remoteStatus({
            gitObservation: { source: 'member_push', observedAt: NOW - 5_000, refreshing: false, unreachableSince: null },
        }) as any)).nodes.find(node => node.id === 'node_mainpc')!
        expect(getMeshGraphObservationHint(fresh, NOW)).toBeNull()
    })

    it('never renders unknown git as BLOCKED REVIEW (older coordinator verdicts on missing data are ignored)', () => {
        const unknownGit = remoteStatus({
            git: { isGitRepo: true, workspace: 'C:/work/adhdev' },
            branchConvergence: { status: 'blocked_review', needsConvergence: true, reason: 'branch_unknown', nextStep: 'Inspect node' },
        })
        const skeletal = buildMeshGraph(canonicalizeRepoMeshStatus(unknownGit as any)).nodes.find(node => node.id === 'node_mainpc')!
        expect(skeletal.branchConvergence).toBeNull()
        expect(getMeshGraphAttentionBadge(skeletal)?.label).not.toBe('blocked review')

        const noGit = remoteStatus({
            git: { workspace: 'C:/work/adhdev', upstreamStatus: 'unchecked' },
            branchConvergence: { status: 'blocked_review', needsConvergence: true, reason: 'git_status_unavailable', nextStep: 'Resolve git status' },
        })
        const missing = buildMeshGraph(canonicalizeRepoMeshStatus(noGit as any)).nodes.find(node => node.id === 'node_mainpc')!
        expect(missing.branchConvergence).toBeNull()

        // A REAL "not a git repo" observation keeps its verdict.
        const notRepo = remoteStatus({
            git: { isGitRepo: false, workspace: 'C:/work/adhdev' },
            branchConvergence: { status: 'blocked_review', needsConvergence: true, reason: 'git_status_unavailable', nextStep: 'Resolve git status' },
        })
        const real = buildMeshGraph(canonicalizeRepoMeshStatus(notRepo as any)).nodes.find(node => node.id === 'node_mainpc')!
        expect(real.branchConvergence?.status).toBe('blocked_review')
    })
})

describe('attention badge — daemon upstream-unverified reasons', () => {
    it('maps default_branch_upstream_unverified to the upstream warning, not BLOCKED REVIEW', () => {
        const status = remoteStatus({
            git: { isGitRepo: true, workspace: 'C:/work/adhdev', branch: 'main', headCommit: 'bbb', upstream: 'origin/main', upstreamStatus: 'unchecked', ahead: 0, behind: 0 },
            branchConvergence: { status: 'blocked_review', needsConvergence: true, reason: 'default_branch_upstream_unverified', nextStep: 'Refresh main upstream' },
        })
        const node = buildMeshGraph(canonicalizeRepoMeshStatus(status as any)).nodes.find(n => n.id === 'node_mainpc')!
        expect(getMeshGraphAttentionBadge(node)).toEqual({ label: 'upstream unverified', tone: 'warn' })
    })
})

describe('mesh graph dialog — where a failed load is surfaced', () => {
    it('a background refresh failing with a graph on screen is quiet; a first load or manual refresh failure is the banner', () => {
        expect(classifyDashboardMeshLoadFailure({ background: true, hasGraph: true })).toBe('quiet')
        expect(classifyDashboardMeshLoadFailure({ background: true, hasGraph: false })).toBe('banner')
        expect(classifyDashboardMeshLoadFailure({ background: false, hasGraph: true })).toBe('banner')
    })
})
