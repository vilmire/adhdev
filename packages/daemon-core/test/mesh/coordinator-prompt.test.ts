import { describe, expect, it } from 'vitest'
import { buildCoordinatorSystemPrompt } from '../../src/mesh/coordinator-prompt.js'

describe('Repo Mesh coordinator prompt', () => {
  it('uses default policy for cloud inline meshes that omit policy/coordinator fields', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [
          {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
      coordinatorCliType: 'claude-cli',
    })

    expect(prompt).toContain('Maximum **2** tasks running in parallel')
    expect(prompt).toContain('Hermes → `hermes-cli`')
    expect(prompt).toContain('Never substitute `claude-cli`')
    expect(prompt).toContain('Coordinator runtime is not a delegation default')
  })

  it('requires mesh tool exposure before doing coordinator work', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [
          {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).toContain('Before doing any coordinator work, confirm that the actual callable tool list includes `mesh_status`')
    expect(prompt).toContain('Do not substitute terminal/file/git tools')
    expect(prompt).toContain('/reload-mcp')
  })

  it('discourages repeated read_chat polling and duplicate workers while delegated tools are active', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [
          {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).not.toContain('Periodically call `mesh_read_chat`')
    expect(prompt).toContain('Do **not** poll `mesh_read_chat` repeatedly')
    expect(prompt).toContain('Do not call `mesh_read_chat` again within a few seconds for the same generating session')
    expect(prompt).toContain('completion/approval signal')
    expect(prompt).toContain('Use at most one compact `mesh_read_chat` check')
    expect(prompt).toContain('Never launch a duplicate session or second worker solely because `mesh_read_chat` has no final assistant message')
  })

  it('requires a branch convergence final state before reporting completion', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        defaultBranch: 'main',
        nodes: [
          {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).toContain('Converge branches')
    expect(prompt).toContain('branchConvergenceSummary')
    expect(prompt).toContain('`mesh_refine_node`')
    expect(prompt).toContain('`merged_to_main`')
    expect(prompt).toContain('`pushed_feature_branch_needs_merge`')
    expect(prompt).toContain('`blocked_review`')
    expect(prompt).toContain('`cleanup_candidate`')
    expect(prompt).toContain('`not_mergeable`')
    expect(prompt).toContain('Do not strand completed branches')
  })
})
