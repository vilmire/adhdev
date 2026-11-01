/** Starter skills and directory import (design 2026-11-01-procedure-skills.md §8, acceptance 8). */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { AssistantSkillStore } from '../../src/assistant/skills/skill-store.js';
import { STARTER_SKILLS, ensureStarterSkills } from '../../src/assistant/skills/starter-skills.js';
import { importFromDirectory, resolveSkillDirectory, scanSkillDirectory } from '../../src/assistant/skills/dir-import.js';
import { detectCredential, scanWriteContent } from '../../src/assistant/store-guards.js';
import { assistantStoreHandlers } from '../../src/commands/high-family/assistant-store.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';

let dir: string;
const mk = () => new AssistantSkillStore({ configDir: dir, now: () => new Date('2026-11-01T00:00:00Z') });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'adhdev-starter-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('starter skills', () => {
    it('ships exactly the three product-generic skills, content-clean', () => {
        expect(STARTER_SKILLS.map((d) => d.name)).toEqual(['mesh-dispatch-hygiene', 'branch-convergence-report', 'deploy-verify-checklist']);
        for (const d of STARTER_SKILLS) {
            expect(detectCredential(d.body) ?? scanWriteContent(d.body)).toBeNull();
            expect(d.body).not.toMatch(/deploy:preview|adhf|vilmire|wrangler|rc\.\d|oss\//i); // no ADHDev-specific procedure in the product
        }
    });

    it('installing twice creates each once, as origin starter', () => {
        const s = mk();
        expect(ensureStarterSkills(s).installed).toHaveLength(3);
        expect(ensureStarterSkills(s)).toMatchObject({ installed: [], skipped: expect.any(Array) });
        const list = s.list();
        expect(list).toHaveLength(3);
        expect(list.every((x) => x.origin === 'starter' && x.status === 'active' && !x.problem)).toBe(true);
        expect(list[0]!.triggers.length).toBeGreaterThan(0);
    });

    it('an existing skill of the same name is left alone', () => {
        const s = mk();
        s.manage({ action: 'create', name: 'deploy-verify-checklist', description: 'mine', body: 'my steps' }, 'owner', null);
        expect(ensureStarterSkills(s).installed).not.toContain('deploy-verify-checklist');
        expect(s.list().find((x) => x.name === 'deploy-verify-checklist')).toMatchObject({ origin: 'owner', description: 'mine' });
    });

    it('after the owner archives a starter skill it is not installed again', () => {
        const s = mk();
        ensureStarterSkills(s);
        expect(s.manage({ action: 'archive', name: 'mesh-dispatch-hygiene' }, 'owner', null)).toEqual({ result: 'applied' });
        expect(ensureStarterSkills(mk()).installed).toEqual([]);
        const fresh = mk();
        expect(fresh.list().find((x) => x.name === 'mesh-dispatch-hygiene')!.status).toBe('archived');
    });

    it('an agent patch to a starter skill is staged (protected_skill)', () => {
        const s = mk();
        ensureStarterSkills(s);
        const out = s.manage({ action: 'patch', name: 'deploy-verify-checklist', old: 'Stop and tell the user', new: 'Stop and tell them' }, 'human', { sessionId: 's', turnId: 't' });
        expect(out).toMatchObject({ result: 'staged', reason: 'protected_skill' });
    });

    it('the live-skill cap still applies', () => {
        const s = mk();
        for (let i = 0; i < 100; i++) s.manage({ action: 'create', name: `s${i}`, description: 'd', body: 'b' }, 'owner', null);
        expect(ensureStarterSkills(s).installed).toEqual([]);
    });
});

describe('directory import', () => {
    let repo: string;
    const skillMd = (name: string, body = 'Do the thing.\n') => `---\nname: ${name}\ndescription: Procedure ${name}\n---\n${body}`;
    beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), 'adhdev-repo-'));
        for (const n of ['release-flow', 'hotfix-flow']) {
            mkdirSync(join(repo, 'docs', 'skills', n, 'references'), { recursive: true });
            writeFileSync(join(repo, 'docs', 'skills', n, 'SKILL.md'), skillMd(n));
        }
        writeFileSync(join(repo, 'docs', 'skills', 'release-flow', 'references', 'notes.md'), 'extra');
        mkdirSync(join(repo, 'docs', 'skills', 'broken'), { recursive: true });
        writeFileSync(join(repo, 'docs', 'skills', 'broken', 'SKILL.md'), 'no frontmatter');
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it('scans, dry-runs and imports Claude-Code-layout skills as origin imported (with references)', () => {
        const s = mk();
        const root = resolveSkillDirectory(repo, 'docs/skills')!;
        const scan = scanSkillDirectory(root, s);
        expect(scan.map((c) => c.name).sort()).toEqual(['broken', 'hotfix-flow', 'release-flow']);
        expect(scan.find((c) => c.name === 'broken')!.problems).toContain('skill_invalid_format');
        expect(importFromDirectory({ dir: root, skills: ['release-flow'] }, s).skills).toEqual([{ name: 'release-flow', result: 'would_import' }]);
        expect(s.list()).toEqual([]);
        const done = importFromDirectory({ dir: root, skills: ['release-flow', 'broken', 'nope'], dryRun: false }, s);
        expect(done.skills.map((r) => r.result)).toEqual(['applied', 'skill_invalid_format', 'skill_not_found']);
        expect(s.list()).toMatchObject([{ name: 'release-flow', origin: 'imported' }]);
        expect(s.view('release-flow')).toMatchObject({ result: 'ok', files: ['references/notes.md'] });
        expect(importFromDirectory({ dir: root, skills: ['release-flow'], dryRun: false }, s).skills[0]).toMatchObject({ result: 'skill_exists' });
    });

    it('only the two fixed sub-directories resolve, and never one that escapes the repo', () => {
        expect(resolveSkillDirectory(repo, '../etc')).toBeNull();
        expect(resolveSkillDirectory(repo, 'src')).toBeNull();
        expect(resolveSkillDirectory(repo, '.claude/skills')).toBeNull(); // absent
        const outside = mkdtempSync(join(tmpdir(), 'adhdev-outside-'));
        mkdirSync(join(repo, '.claude'), { recursive: true });
        symlinkSync(outside, join(repo, '.claude', 'skills'));
        expect(resolveSkillDirectory(repo, '.claude/skills')).toBeNull();
        rmSync(outside, { recursive: true, force: true });
    });

    it('the owner verb imports from a known project only and refuses an arbitrary subdir', async () => {
        const meshes = [{ id: 'mesh_a', name: 'ADHDev', repoIdentity: 'github.com/vilmire/adhdev', nodes: [{ id: 'n1', workspace: repo }] }] as any;
        const svc = createAssistantServices({ configDir: dir, listMeshes: () => meshes });
        setAssistantServicesForTests(svc);
        try {
            const run = (args: Record<string, unknown>) => assistantStoreHandlers[ASSISTANT_VERB.importSkills]({} as any, args);
            expect(await run({ source: 'dir', project: 'adhdev' })).toMatchObject({ success: true, result: 'scan', subdir: 'docs/skills' });
            expect(await run({ source: 'dir', project: 'adhdev', subdir: '../../etc' })).toMatchObject({ success: false, code: 'invalid_args' });
            expect(await run({ source: 'dir', project: 'nope' })).toMatchObject({ success: false, code: 'project_not_found' });
            expect(await run({ source: 'dir', project: 'adhdev', skills: ['hotfix-flow'], dryRun: false })).toMatchObject({ success: true, dryRun: false, skills: [{ name: 'hotfix-flow', result: 'applied' }] });
            expect(svc.skills.list().map((x) => x.name)).toEqual(['hotfix-flow']);
        } finally {
            setAssistantServicesForTests(null);
        }
    });
});
