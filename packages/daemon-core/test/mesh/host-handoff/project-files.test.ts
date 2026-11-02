import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { exportProjectApprovalFiles, importProjectApprovalFiles, verifyProjectApprovalFiles } from '../../../src/mesh/host-handoff/project-files.js';

function fixture() {
    const source = mkdtempSync(join(tmpdir(), 'handoff-approvals-source-'));
    const target = mkdtempSync(join(tmpdir(), 'handoff-approvals-target-'));
    mkdirSync(join(source, 'assistant', 'staged'), { recursive: true });
    mkdirSync(join(source, 'assistant', 'staged-control'), { recursive: true });
    const original = JSON.stringify({ version: 1, id: 'ctl-aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'session_control', meshId: 'project',
        project: 'Project', role: 'coordinator', action: 'restart', sessionId: 'old-session', trigger: 'owner_request',
        createdAt: 100, expiresAt: 1000, interpretedFrom: 'restart when safe' });
    writeFileSync(join(source, 'assistant', 'staged-control', 'ctl-aaaaaaaaaaaaaaaaaaaaaaaa.json'), original);
    writeFileSync(join(source, 'assistant', 'staged', 'note-other.json'), JSON.stringify({ id: 'note-other', kind: 'note', meshId: 'other-project' }));
    writeFileSync(join(source, 'assistant', 'staged', 'global-memory.json'), JSON.stringify({ id: 'global-memory', kind: 'memory', op: { scope: 'global', text: 'global preference' } }));
    return { source, target, original };
}

describe('project approval file preservation', () => {
    it('copies exact pending approval bytes/id/expiry, leaves originals and unrelated proposals intact, and retries idempotently', () => {
        const { source, target, original } = fixture();
        const files = exportProjectApprovalFiles(source, 'project', ref => ref);
        expect(files).toHaveLength(1);
        importProjectApprovalFiles(target, 'project', files);
        importProjectApprovalFiles(target, 'project', files);
        const relative = join('assistant', 'staged-control', files[0]!.name);
        expect(readFileSync(join(source, relative), 'utf8')).toBe(original);
        expect(readFileSync(join(target, relative), 'utf8')).toBe(original);
        expect(readFileSync(join(source, 'assistant', 'staged', 'note-other.json'), 'utf8')).toContain('other-project');
    });

    it('rejects a conflicting retained target approval without replacing its bytes', () => {
        const { source, target } = fixture();
        const files = exportProjectApprovalFiles(source, 'project', ref => ref);
        const dir = join(target, 'assistant', 'staged-control'); mkdirSync(dir, { recursive: true });
        const path = join(dir, files[0]!.name); writeFileSync(path, 'retained unrelated bytes');
        expect(() => importProjectApprovalFiles(target, 'project', files)).toThrow('conflicts');
        expect(readFileSync(path, 'utf8')).toBe('retained unrelated bytes');
    });

    it('rejects traversal, foreign project identity and duplicate files', () => {
        const { source } = fixture();
        const [file] = exportProjectApprovalFiles(source, 'project', ref => ref);
        expect(() => verifyProjectApprovalFiles([{ ...file!, name: '../escape.json' }], 'project')).toThrow();
        expect(() => verifyProjectApprovalFiles([{ ...file!, meshId: 'other' }], 'project')).toThrow('another project');
        const data = file!.data.replace('\"meshId\":\"project\"', '\"meshId\":\"foreign\"');
        expect(() => verifyProjectApprovalFiles([{ ...file!, data, sha256: createHash('sha256').update(data).digest('hex') }], 'project')).toThrow('payload belongs');
        expect(() => verifyProjectApprovalFiles([file!, file!], 'project')).toThrow('duplicate');
    });

    it('rejects an approval directory symlink instead of following it into another instance', () => {
        const { source, target } = fixture();
        mkdirSync(join(target, 'assistant'));
        symlinkSync(join(source, 'assistant', 'staged-control'), join(target, 'assistant', 'staged-control'), 'dir');
        expect(() => importProjectApprovalFiles(target, 'project', exportProjectApprovalFiles(source, 'project', ref => ref))).toThrow('local directory');
    });
});
