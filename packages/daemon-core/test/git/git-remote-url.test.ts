import { describe, expect, it, vi } from 'vitest';
import { handleGitCommand, isGitCommandName, type GitCommandServices } from '../../src/git/git-commands.js';

describe('git_remote_url command', () => {
    it('git_remote_url is a valid GitCommandName via isGitCommandName', () => {
        expect(isGitCommandName('git_remote_url')).toBe(true);
    });

    it('handleGitCommand git_remote_url calls services.getRemoteUrl with workspace and remote', async () => {
        const getRemoteUrl = vi.fn().mockResolvedValue({ remoteUrl: 'git@github.com:owner/repo.git', remote: 'origin' });
        const services: GitCommandServices = { getRemoteUrl };

        const result = await handleGitCommand('git_remote_url', { workspace: '/repo', remote: 'origin' }, services);

        expect(getRemoteUrl).toHaveBeenCalledWith({ workspace: '/repo', remote: 'origin' });
        expect(result).toEqual({ success: true, remoteUrl: 'git@github.com:owner/repo.git', remote: 'origin' });
    });

    it('missing getRemoteUrl service returns serviceNotImplemented failure', async () => {
        const services: GitCommandServices = {};

        const result = await handleGitCommand('git_remote_url', { workspace: '/repo' }, services);

        expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
        expect((result as { error: string }).error).toContain('git_remote_url is not implemented');
    });
});
