/**
 * Repo-read coordinator rules layer.
 *
 * Properties pinned:
 *   - a repo's .adhdev/coordinator-rules.md replaces the bundled default at
 *     launch (the "rules merged = rules live" contract)
 *   - fail-open: missing / unreadable / stub files fall back to the bundled
 *     default, never to an empty rules layer
 *   - the compiled safety tail (destructive-git approval) is present no
 *     matter which source supplied the rules — a repo file cannot remove it
 *   - the soft-cap shed path drops notes/activity but NEVER the rules layer
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCoordinatorRules, splitRulesLayer } from '../../src/mesh/coordinator-rules.js';
import { DEFAULT_COORDINATOR_RULES } from '../../src/mesh/default-coordinator-rules.js';
import { buildCoordinatorSystemPrompt } from '../../src/mesh/coordinator-prompt.js';

const tmpDirs: string[] = [];
function makeRepo(rulesContent?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-rules-'));
    tmpDirs.push(dir);
    if (rulesContent !== undefined) {
        fs.mkdirSync(path.join(dir, '.adhdev'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.adhdev', 'coordinator-rules.md'), rulesContent);
    }
    return dir;
}
afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const REPO_RULES = [
    '## Orchestration Workflow',
    'Repo-specific workflow body. '.repeat(20),
    '',
    '## Rules',
    '- Repo-specific rule: always deploy on Tuesdays. '.repeat(10),
].join('\n');

function baseCtx(overrides: Record<string, unknown> = {}) {
    return {
        mesh: {
            id: 'mesh_x', name: 'testmesh', repoIdentity: 'vilmire/adhdev',
            defaultBranch: 'main', nodes: [{ id: 'node_1', workspace: '/tmp/ws' }], policy: {},
        },
        coordinatorCliType: 'claude-cli',
        ...overrides,
    } as any;
}

describe('resolveCoordinatorRules', () => {
    it('falls back to the bundled default with no workspace', () => {
        const r = resolveCoordinatorRules(undefined);
        expect(r.source).toBe('bundled');
        expect(r.text).toBe(DEFAULT_COORDINATOR_RULES);
        expect(DEFAULT_COORDINATOR_RULES).toContain('## Orchestration Workflow');
        expect(DEFAULT_COORDINATOR_RULES).toContain('## Rules');
    });

    it('reads the repo file when present and meaningful', () => {
        const repo = makeRepo(REPO_RULES);
        const r = resolveCoordinatorRules(repo);
        expect(r.source).toBe('repo');
        expect(r.text).toBe(REPO_RULES);
        expect(r.differsFromBundled).toBe(true);
    });

    it('treats a stub file as absent (fail-open to bundled)', () => {
        const repo = makeRepo('# TODO\n');
        expect(resolveCoordinatorRules(repo).source).toBe('bundled');
    });

    it('treats a missing file as absent', () => {
        const repo = makeRepo(undefined);
        expect(resolveCoordinatorRules(repo).source).toBe('bundled');
    });
});

describe('splitRulesLayer', () => {
    it('splits on the ## Rules header', () => {
        const { workflow, rules } = splitRulesLayer(REPO_RULES);
        expect(workflow).toContain('## Orchestration Workflow');
        expect(workflow).not.toContain('## Rules');
        expect(rules.startsWith('## Rules')).toBe(true);
    });

    it('keeps everything in the rules half when the header is missing', () => {
        const { workflow, rules } = splitRulesLayer('custom rules with no headers at all');
        expect(workflow).toBe('');
        expect(rules).toBe('custom rules with no headers at all');
    });
});

describe('prompt assembly with the rules layer', () => {
    it('uses the bundled default when ctx.repoRules is omitted', () => {
        const prompt = buildCoordinatorSystemPrompt(baseCtx());
        expect(prompt).toContain('## Orchestration Workflow');
        expect(prompt).toContain('### Non-negotiable');
        expect(prompt).toContain('Never run destructive git operations');
    });

    it('repo rules replace the bundled text but never the safety tail', () => {
        const repo = makeRepo(REPO_RULES);
        const prompt = buildCoordinatorSystemPrompt(baseCtx({ repoRules: resolveCoordinatorRules(repo) }));
        expect(prompt).toContain('always deploy on Tuesdays');
        // A bundled-default-only phrase must be gone (wholesale replacement).
        expect(prompt).not.toContain('Batch-first rule');
        // The compiled safety tail still rides.
        expect(prompt).toContain('Never run destructive git operations');
        expect(prompt).toContain('Coordinator runtime is not a delegation default');
    });

    it('soft-cap shedding drops notes, never the rules layer', () => {
        // Enough notes to blow the 96KB cap and force the shed path.
        const notes = Array.from({ length: 400 }, (_, i) => ({
            id: `n${i}`, text: `note ${i} ${'x'.repeat(280)}`, createdAt: new Date().toISOString(),
        }));
        const prompt = buildCoordinatorSystemPrompt(baseCtx({ operatingNotes: notes }));
        expect(prompt).toContain('## Orchestration Workflow');
        expect(prompt).toContain('### Non-negotiable');
    });
});
