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
    expect(prompt).toContain('Use at most one compact `mesh_read_chat` check')
    expect(prompt).toContain('Never launch a duplicate session or second worker solely because `mesh_read_chat` has no final assistant message')
  })
})
