import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containedRepoPath, isSafeBranchName, isSafeRefValue, isSafeRelativeRepo } from '../../src/mesh/mission-ref-input.js';
import { meshMissionGitCommandHandlers } from '../../src/commands/med-family/mesh-mission-git-commands.js';

describe('mission ref input hygiene (peer-supplied refs)', () => {
    it('accepts hex commits and plain branch names only', () => {
        expect(isSafeRefValue('commit', 'abc1234')).toBe(true);
        expect(isSafeRefValue('commit', 'HEAD')).toBe(false);
        expect(isSafeRefValue('commit', '--output=/tmp/x')).toBe(false);
        expect(isSafeRefValue('branch', 'feat/rc37-x')).toBe(true);
        expect(isSafeRefValue('branch', '-c')).toBe(false);
        expect(isSafeRefValue('branch', '--upload-pack=evil')).toBe(false);
        expect(isSafeRefValue('branch', 'a..b')).toBe(false);
        expect(isSafeRefValue('branch', 'x@{1}')).toBe(false);
        expect(isSafeRefValue('branch', 'x.lock')).toBe(false);
        expect(isSafeBranchName('main')).toBe(true);
        expect(isSafeBranchName('-main')).toBe(false);
    });

    it('refuses absolute, parent and backslash repo paths', () => {
        expect(isSafeRelativeRepo('oss')).toBe(true);
        expect(isSafeRelativeRepo('packages/x')).toBe(true);
        for (const bad of ['/etc', '../other', 'a/../../b', 'a\\b', 'C:/x', './x']) expect(isSafeRelativeRepo(bad)).toBe(false);
    });

    it('rejects a symlink that leaves the repo', () => {
        const root = mkdtempSync(join(tmpdir(), 'adhdev-refin-root-'));
        const outside = mkdtempSync(join(tmpdir(), 'adhdev-refin-out-'));
        mkdirSync(join(root, 'inner'));
        symlinkSync(outside, join(root, 'escape'));
        expect(containedRepoPath(root, 'inner')).toBeTruthy();
        expect(containedRepoPath(root, 'escape')).toBeUndefined();
        expect(containedRepoPath(root, 'missing')).toBeUndefined();
    });

    it('mesh_ref_containment_probe refuses unsafe entries before touching git', async () => {
        const probe = meshMissionGitCommandHandlers.mesh_ref_containment_probe;
        const ctx = { getMeshForCommand: async () => ({ mesh: { id: 'm1', nodes: [] } }), deps: { statusInstanceId: 'daemon_self' } } as any;
        // Control: a well-formed entry is answered (no local repos → unknown), so a refusal below is the validator's.
        const ok = await probe(ctx, { meshId: 'm1', entries: [{ kind: 'commit', value: 'abc1234' }] });
        expect(ok.success).toBe(true);
        for (const entries of [
            [{ kind: 'branch', value: '--upload-pack=x' }],
            [{ kind: 'commit', value: 'not-a-sha' }],
            [{ kind: 'commit', value: 'abc1234', repo: '../../etc' }],
        ]) {
            const res = await probe(ctx, { meshId: 'm1', entries });
            expect(res.success).toBe(false);
        }
        const res = await probe(ctx, { meshId: 'm1', entries: [{ kind: 'commit', value: 'abc1234' }], baseBranch: '-x' });
        expect(res.success).toBe(false);
    });
});
