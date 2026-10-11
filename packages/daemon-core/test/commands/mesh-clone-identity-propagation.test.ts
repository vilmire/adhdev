import { describe, expect, it, vi, beforeEach } from 'vitest'
import '../../src/commands/router'
import { meshNodeCloneHandlers } from '../../src/commands/med-family/mesh-node-clone.js'
import * as gitExecutor from '../../src/git/git-executor.js'

vi.mock('../../src/git/git-executor.js', () => ({
  execGitStdout: vi.fn(),
  runGit: vi.fn(),
  isPathInside: vi.fn(),
  normalizeGitOutput: vi.fn()
}))

describe('clone_mesh_node identity propagation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects clone if user.name or user.email is missing in source repo', async () => {
    const inline = { id: 'mesh_1', nodes: [{ id: 'node_base', workspace: '/repo', daemonId: 'daemon_self' }] }
    const getMeshForCommand = vi.fn(async () => ({ mesh: inline, inline: true, source: 'inline_cache' }))
    const dispatchMeshCommand = vi.fn()
    const ctx: any = {
      getMeshForCommand,
      requireMeshHostMutationOwner: async () => null,
      deps: { statusInstanceId: 'daemon_self', dispatchMeshCommand },
    }

    vi.mocked(gitExecutor.execGitStdout).mockImplementation(async (cwd: string, args: readonly string[]) => {
      if (args.includes('user.name')) {
        throw new Error('git config user.name missing'); // Simulate missing config
      }
      return '';
    });

    const result: any = await meshNodeCloneHandlers.clone_mesh_node(ctx, { meshId: 'mesh_1', sourceNodeId: 'node_base', branch: 'feat/x' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Cannot clone: source repository lacks an explicit user\.name/);
  })
})
