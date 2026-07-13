import { describe, expect, it } from 'vitest'
import { buildProviderVersions, getCachedProviderVersions, setDefaultProviderLoader, type CLIInfo } from '../../src/detection/cli-detector.js'
import { recordInlineMeshDirectGitTruth } from '../../src/mesh/mesh-node-identity.js'
import { buildCoordinatorSystemPrompt } from '../../src/mesh/coordinator-prompt.js'

// T7 (B4 visibility + 7-2b provider version tracking). These cover the additive
// providerVersions surface: detection fold, git_status envelope self-heal, and
// coordinator-prompt Nodes rendering. All additive — an absent providerVersions
// must never break the existing shape.

function cli(partial: Partial<CLIInfo> & { id: string }): CLIInfo {
  return {
    displayName: partial.id,
    icon: '',
    command: partial.id,
    installed: partial.installed ?? true,
    ...partial,
  }
}

describe('T7 buildProviderVersions', () => {
  it('folds installed providers with a parseable version into a { id: version } map', () => {
    const versions = buildProviderVersions([
      cli({ id: 'claude-cli', version: '1.2.3' }),
      cli({ id: 'codex-cli', version: '0.9.0' }),
    ])
    expect(versions).toEqual({ 'claude-cli': '1.2.3', 'codex-cli': '0.9.0' })
  })

  it('omits providers that are not installed or have no version (never a fabricated value)', () => {
    const versions = buildProviderVersions([
      cli({ id: 'claude-cli', version: '1.2.3' }),
      cli({ id: 'gemini-cli', installed: false, version: '9.9.9' }),
      cli({ id: 'codex-cli', version: '   ' }),
      cli({ id: 'hermes-cli', version: undefined }),
    ])
    expect(versions).toEqual({ 'claude-cli': '1.2.3' })
  })

  it('returns an empty map for an empty detection set', () => {
    expect(buildProviderVersions([])).toEqual({})
  })
})

describe('T7 default provider loader fallback (self-node chip fix)', () => {
  // Root cause of the self-node "no version chips" defect: getCachedProviderVersions()
  // is called with no loader from the coordinator's own self/worktree self-heal
  // (mesh-node-identity.ts). detectCLIs with no loader builds an EMPTY detection list,
  // so the version map is always {} for the self node — even though remote nodes (which
  // self-report via the git_status envelope) populate. setDefaultProviderLoader registers
  // the daemon's loader so the loader-less refresh consults it.
  it('a loader-less refresh consults the registered default loader instead of yielding an empty list', async () => {
    let detectionListCalls = 0
    const fakeLoader: any = {
      // An empty command list keeps the refresh deterministic (no `which`/`--version`
      // shelling): we only assert the loader was consulted at all — proving the default
      // fallback is wired, which is exactly what the self node was missing.
      getCliDetectionList: () => {
        detectionListCalls += 1
        return []
      },
      resolveAlias: (id: string) => id,
    }
    setDefaultProviderLoader(fakeLoader)
    // Force a stale/cold read so the lazy background refresh fires with no explicit loader.
    getCachedProviderVersions()
    // The refresh is fire-and-forget; let its microtask/detection promise settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(detectionListCalls).toBeGreaterThan(0)
  })
})

describe('T7 recordInlineMeshDirectGitTruth self-heal', () => {
  const baseGit = { isGitRepo: true, lastCheckedAt: 1_700_000_000_000 }

  it('stamps reported provider versions + build version from the git_status envelope onto the node', () => {
    const node: any = { id: 'node_1', userOverrides: {} }
    const reporter = recordInlineMeshDirectGitTruth(
      node,
      {
        ...baseGit,
        reporterProviderVersions: { 'claude-cli': '1.2.3', 'codex-cli': '0.9.0' },
        reporterDaemonBuildVersion: '0.9.82',
      },
      'selected_coordinator_mesh_p2p_git',
    )
    expect(node.reportedProviderVersions).toEqual({ 'claude-cli': '1.2.3', 'codex-cli': '0.9.0' })
    expect(node.reportedDaemonBuildVersion).toBe('0.9.82')
    expect(reporter.reporterProviderVersions).toEqual({ 'claude-cli': '1.2.3', 'codex-cli': '0.9.0' })
    expect(reporter.reporterDaemonBuildVersion).toBe('0.9.82')
  })

  it('ignores non-string / empty version entries and omits the field when nothing usable is reported', () => {
    const node: any = { id: 'node_1', userOverrides: {} }
    const reporter = recordInlineMeshDirectGitTruth(
      node,
      {
        ...baseGit,
        reporterProviderVersions: { 'claude-cli': '', 'codex-cli': 42 as unknown as string },
      },
      'selected_coordinator_mesh_p2p_git',
    )
    expect(node.reportedProviderVersions).toBeUndefined()
    expect(reporter.reporterProviderVersions).toBeNull()
  })

  it('is backward compatible: a v1 envelope without provider fields leaves the node untouched', () => {
    // Local-source path with a cold local version cache (no provider detection has
    // run and no build stamp is injected in the test bundle) → the self-heal
    // fallback yields nothing, so the node is left untouched exactly as before.
    const node: any = { id: 'node_1', userOverrides: {} }
    const reporter = recordInlineMeshDirectGitTruth(node, { ...baseGit }, 'selected_coordinator_local_git')
    expect(node.reportedProviderVersions).toBeUndefined()
    expect(node.reportedDaemonBuildVersion).toBeUndefined()
    expect(reporter.reporterProviderVersions).toBeNull()
    expect(reporter.reporterDaemonBuildVersion).toBeNull()
  })

  it('self node (local source): an explicit envelope value still wins over the local self-heal fallback', () => {
    // The self/worktree probe path calls getGitRepoStatus() directly, so it normally
    // carries no reporter* fields — the local-source fallback fills them from this
    // daemon's own version cache. When a reporter value IS present on a local-source
    // envelope it must take precedence (parity with the platform/arch self-heal).
    const node: any = { id: 'node_self', userOverrides: {} }
    const reporter = recordInlineMeshDirectGitTruth(
      node,
      {
        ...baseGit,
        reporterProviderVersions: { 'claude-cli': '3.2.57' },
        reporterDaemonBuildVersion: '0.9.99',
      },
      'selected_coordinator_local_git',
    )
    expect(node.reportedProviderVersions).toEqual({ 'claude-cli': '3.2.57' })
    expect(node.reportedDaemonBuildVersion).toBe('0.9.99')
    expect(reporter.reporterProviderVersions).toEqual({ 'claude-cli': '3.2.57' })
    expect(reporter.reporterDaemonBuildVersion).toBe('0.9.99')
  })
})

describe('T7 coordinator-prompt Nodes rendering', () => {
  function promptWithNode(node: Record<string, unknown>): string {
    return buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [{ id: 'node_1', workspace: '/repo', daemonId: 'daemon_1', userOverrides: {}, policy: {} }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
      status: {
        meshId: 'mesh_1',
        meshName: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        refreshedAt: '2026-01-01T00:00:00Z',
        nodes: [
          {
            nodeId: 'node_1',
            machineLabel: 'mac',
            workspace: '/repo',
            daemonId: 'daemon_1',
            health: 'online',
            providers: ['claude-cli', 'codex-cli'],
            activeSessions: [],
            ...node,
          },
        ],
      } as any,
      coordinatorCliType: 'claude-cli',
    })
  }

  it('renders provider@version and the build version when reported', () => {
    const prompt = promptWithNode({
      providerVersions: { 'claude-cli': '1.2.3' },
      daemonBuildVersion: '0.9.82',
    })
    expect(prompt).toContain('claude-cli@1.2.3')
    // codex-cli has no reported version → rendered bare, not `@undefined`.
    expect(prompt).toContain('codex-cli')
    expect(prompt).not.toContain('codex-cli@')
    expect(prompt).toContain('build: 0.9.82')
  })

  it('renders providers bare (no @) when no versions are reported — v1/older-daemon compatibility', () => {
    const prompt = promptWithNode({})
    expect(prompt).toContain('providers: claude-cli, codex-cli')
    expect(prompt).not.toContain('claude-cli@')
    expect(prompt).not.toContain('build:')
  })
})
