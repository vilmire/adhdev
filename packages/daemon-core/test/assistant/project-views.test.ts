import { describe, expect, it } from 'vitest';
import { isUnmanagedRepoIdentity } from '../../src/assistant/project-views.js';

describe('isUnmanagedRepoIdentity', () => {
    it('treats remote, local-name and real path identities as projects', () => {
        for (const id of ['github.com/vilmire/adhdev', 'local/todo-web', 'local/5e25f4abf52510677f716c76340f6e424e77fb24', '/Users/me/demo/remotes/todo-web', 'C:\\Users\\me\\code\\app']) {
            expect(isUnmanagedRepoIdentity(id), id).toBe(false);
        }
    });

    it('keeps scratch identities apart', () => {
        for (const id of ['', 'test-repo', 'scratch/x', 'local:abc', '/tmp/x', '/private/tmp/claude/scratch/repo', '/var/folders/ml/T/repo', 'C:\\Users\\me\\AppData\\Local\\Temp\\repo']) {
            expect(isUnmanagedRepoIdentity(id), id).toBe(true);
        }
    });
});
