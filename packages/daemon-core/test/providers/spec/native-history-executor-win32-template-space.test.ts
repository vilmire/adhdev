/**
 * win32 template-space separator regression tests (jsonl session LIST path).
 *
 * Bug (win32 only): the declarative jsonl session lister decomposed path
 * templates with '/'-based splits AFTER path.join(os.homedir(), …) had
 * converted the expanded root to backslashes. `lastIndexOf('/')` missed →
 * directory template collapsed to '' → expandDirGlob walked the drive root
 * ('/' ⇒ C:\) → 0 matches → `{ success: true, sessions: [] }` for EVERY
 * declarative jsonl provider whose template starts with '~/' (claude-cli,
 * codex-cli, cursor-cli, kimi). POSIX was unaffected because path.join
 * keeps '/', which is why host-only testing never caught it.
 *
 * These tests run on any host: they feed win32-shaped (backslash) strings
 * straight into the template-space decomposition helpers, and mock
 * os.homedir() to a win32 value so tilde expansion reproduces exactly what
 * a Windows daemon produces. POSIX end-to-end enumeration coverage lives in
 * test/providers/list-saved-sessions-native-source.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';

// Declared via vi.hoisted: vi.mock is hoisted above every top-level statement,
// so a plain `const WIN_HOME` below it is still in its temporal dead zone when
// the factory runs ("Cannot access 'WIN_HOME' before initialization"). vi.hoisted
// lifts the value with the mock so both land before module evaluation.
const { WIN_HOME } = vi.hoisted(() => ({ WIN_HOME: 'C:\\Users\\tester' }));

// Only the executor's 'node:os' import is mocked; the rest of the module
// graph keeps the real builtin. The tests below call pure string helpers
// only, so the mocked homedir never reaches the filesystem.
vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, default: actual, homedir: () => WIN_HOME };
});

import {
    expandTemplateRootForEnumeration,
    splitTemplateDirLeaf,
    splitTemplateRoot,
    staticTemplateBase,
    toPosixPath,
} from '../../../src/providers/spec/native-history-executor.js';

describe('toPosixPath', () => {
    it('converts win32 separators to posix', () => {
        expect(toPosixPath('C:\\Users\\tester\\.claude\\projects')).toBe('C:/Users/tester/.claude/projects');
    });

    it('leaves posix paths untouched', () => {
        expect(toPosixPath('/Users/tester/.claude/projects')).toBe('/Users/tester/.claude/projects');
    });
});

describe('expandTemplateRootForEnumeration — win32 homedir', () => {
    it('expands ~ into a fully posix template even when homedir uses backslashes', () => {
        const out = expandTemplateRootForEnumeration(
            '~/.claude/projects/{cwd_claude_project}/{session_id}.jsonl',
            {},
        );
        // Pre-fix on win32: path.join(homedir, …) produced an all-backslash
        // string here, and every downstream '/'-split collapsed.
        expect(out).toBe('C:/Users/tester/.claude/projects/{cwd_claude_project}/{session_id}.jsonl');
        expect(out).not.toContain('\\');
    });

    it('normalizes backslashes arriving via ${ENV} values', () => {
        const out = expandTemplateRootForEnumeration(
            '${TEST_NH_ROOT}/sessions/{yyyy}/{mm}',
            { envOverrides: { TEST_NH_ROOT: 'D:\\store\\codex' } },
        );
        expect(out).toBe('D:/store/codex/sessions/{yyyy}/{mm}');
    });

    it('keeps posix expansion shape on relative templates', () => {
        expect(expandTemplateRootForEnumeration('sessions/{yyyy}', {})).toBe('sessions/{yyyy}');
    });
});

describe('splitTemplateDirLeaf — the enumerateSessionFiles decomposition', () => {
    it('splits a posix-expanded template into directory + leaf', () => {
        expect(splitTemplateDirLeaf('C:/Users/tester/.claude/projects/*/{session_id}.jsonl'))
            .toEqual({ dirPart: 'C:/Users/tester/.claude/projects/*', leaf: '{session_id}.jsonl' });
    });

    it('never collapses a win32-expanded template to an empty directory', () => {
        // The exact production collapse: pre-fix, enumerateSessionFiles ran
        // lastIndexOf('/') over the all-backslash win32 expansion, got -1,
        // and treated the WHOLE path as the leaf with an empty directory
        // template — expandDirGlob('') then scanned the drive root
        // (C:\ Users, Windows, AMD…) and matched nothing.
        const expanded = expandTemplateRootForEnumeration(
            '~/.claude/projects/{cwd_claude_project}/{session_id}.jsonl',
            {},
        );
        const { dirPart, leaf } = splitTemplateDirLeaf(expanded);
        expect(dirPart).toBe('C:/Users/tester/.claude/projects/{cwd_claude_project}');
        expect(leaf).toBe('{session_id}.jsonl');
    });
});

describe('splitTemplateRoot — the expandDirGlob decomposition', () => {
    it('seeds a win32 drive root from a backslash template', () => {
        // Pre-fix: template.split('/') kept the whole backslash path as ONE
        // relative segment, so the walk statted a literal 'C:\Users\…\*' dir
        // name and matched nothing.
        expect(splitTemplateRoot('C:\\Users\\tester\\.claude\\projects\\*'))
            .toEqual({ root: 'C:/', segments: ['Users', 'tester', '.claude', 'projects', '*'] });
    });

    it('seeds a win32 drive root from a forward-slash template', () => {
        expect(splitTemplateRoot('D:/store/codex/sessions/*'))
            .toEqual({ root: 'D:/', segments: ['store', 'codex', 'sessions', '*'] });
    });

    it('does not treat a bare drive letter as a relative segment', () => {
        // 'C:' as the seed would resolve against the process cwd on that
        // drive instead of the drive root.
        expect(splitTemplateRoot('C:\\')).toEqual({ root: 'C:/', segments: [''] });
    });

    it('keeps posix-absolute seeding unchanged', () => {
        expect(splitTemplateRoot('/Users/tester/.codex/sessions/*'))
            .toEqual({ root: '/', segments: ['Users', 'tester', '.codex', 'sessions', '*'] });
    });

    it('keeps relative seeding unchanged', () => {
        expect(splitTemplateRoot('sessions/*/main'))
            .toEqual({ root: 'sessions', segments: ['*', 'main'] });
    });
});

describe('staticTemplateBase — the projects-root scan decomposition', () => {
    it('derives the static base from a win32 backslash head', () => {
        // scanProjectsRootForSessionFile: pre-fix the '\'-separated head
        // survived split('/') as one segment, so the scan base became the
        // whole template (vars included) and statSync always missed.
        expect(staticTemplateBase('C:\\Users\\tester\\.claude\\projects\\{cwd_claude_project}\\{session_id}.jsonl'))
            .toBe('C:/Users/tester/.claude/projects');
    });

    it('stops at the first wildcard segment', () => {
        expect(staticTemplateBase('C:/Users/tester/.kimi-code/sessions/*/session_*')).toBe('C:/Users/tester/.kimi-code/sessions');
    });

    it('keeps posix behavior unchanged', () => {
        expect(staticTemplateBase('/Users/tester/.claude/projects/{cwd_claude_project}/{session_id}.jsonl'))
            .toBe('/Users/tester/.claude/projects');
    });

    it('returns empty when the template has no static head', () => {
        expect(staticTemplateBase('{cwd}/sessions/{yyyy}')).toBe('');
    });
});
