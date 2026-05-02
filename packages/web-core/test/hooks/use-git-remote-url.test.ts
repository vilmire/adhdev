import { describe, expect, it } from 'vitest';
import { extractGitHubUrl } from '../../src/hooks/useGitRemoteUrl';

describe('extractGitHubUrl', () => {
    it('converts SSH remote URL to HTTPS GitHub URL', () => {
        const result = extractGitHubUrl('git@github.com:owner/repo.git');
        expect(result).toBe('https://github.com/owner/repo');
    });

    it('converts HTTPS remote URL with .git suffix to clean GitHub URL', () => {
        const result = extractGitHubUrl('https://github.com/owner/repo.git');
        expect(result).toBe('https://github.com/owner/repo');
    });

    it('returns null for non-GitHub remote URLs', () => {
        expect(extractGitHubUrl('https://gitlab.com/owner/repo.git')).toBeNull();
        expect(extractGitHubUrl('git@bitbucket.org:owner/repo.git')).toBeNull();
        expect(extractGitHubUrl(null)).toBeNull();
        expect(extractGitHubUrl(undefined)).toBeNull();
    });
});
