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

vi.mock('../../src/git/git-worktree.js', () => ({
  createWorktree: vi.fn().mockResolvedValue({ worktreePath: '/repo/feat-x', branch: 'feat/x', baseSync: { action: 'up_to_date' } }),
  removeWorktree: vi.fn(),
  deleteBranchRef: vi.fn()
}))

describe('clone_mesh_node identity propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        throw new Error('git config user.name missing');
      }
      return '';
    });

    const result: any = await meshNodeCloneHandlers.clone_mesh_node(ctx, { meshId: 'mesh_1', sourceNodeId: 'node_base', branch: 'feat/x' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Cannot clone: source repository lacks an explicit user\.name/);
  })

  it('propagates user.name and user.email to cloned worktree and submodules', async () => {
    const inline = { id: 'mesh_1', name: 'test_mesh', nodes: [{ id: 'node_base', workspace: '/repo', daemonId: 'daemon_self' }] }
    const getMeshForCommand = vi.fn(async () => ({ mesh: inline, inline: true, source: 'inline_cache' }))
    const dispatchMeshCommand = vi.fn()
    const ctx: any = {
      getMeshForCommand,
      requireMeshHostMutationOwner: async () => null,
      updateInlineMeshNode: vi.fn(),
      deps: { statusInstanceId: 'daemon_self', dispatchMeshCommand },
    }

    vi.mocked(gitExecutor.execGitStdout).mockImplementation(async (cwd: string, args: readonly string[]) => {
      if (args.includes('user.name')) return 'Test User';
      if (args.includes('user.email')) return 'test@example.com';
      return '';
    });

    vi.mocked(gitExecutor.runGit).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

    const result: any = await meshNodeCloneHandlers.clone_mesh_node(ctx, { meshId: 'mesh_1', sourceNodeId: 'node_base', branch: 'feat/x' });
    
    // 1. Clone should not be rejected
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // 2. Identity is set in the cloned worktree
    expect(vi.mocked(gitExecutor.runGit)).toHaveBeenCalledWith(
      { workspace: result.worktreePath, repoRoot: result.worktreePath, isGitRepo: true },
      ['config', 'user.name', 'Test User']
    );
    expect(vi.mocked(gitExecutor.runGit)).toHaveBeenCalledWith(
      { workspace: result.worktreePath, repoRoot: result.worktreePath, isGitRepo: true },
      ['config', 'user.email', 'test@example.com']
    );

    // 3. Submodule is also initialized and configured
    expect(vi.mocked(gitExecutor.runGit)).toHaveBeenCalledWith(
      { workspace: result.worktreePath, repoRoot: result.worktreePath, isGitRepo: true },
      ['submodule', 'update', '--init', '--recursive'],
      expect.anything()
    );
    expect(vi.mocked(gitExecutor.runGit)).toHaveBeenCalledWith(
      { workspace: result.worktreePath, repoRoot: result.worktreePath, isGitRepo: true },
      ['submodule', 'foreach', '--recursive', 'git config user.name \'Test User\' && git config user.email \'test@example.com\' || true']
    );
  })
})
