/**
 * FSM spec lint — unescaped `^`/`$` in a `matches` condition without the `m` flag.
 *
 * The evaluator compiles `matches` with `flags ?? 'i'` — no `m`. So an unescaped
 * `^`/`$` anchors to the start/end of the WHOLE screen buffer, not to a line, and
 * a condition that reads like a per-line test silently never (or always) fires.
 * (Live precedent: a grok trust modal was misread as idle for exactly this
 * reason — see the FSM-spec-matches-no-m-flag note.)
 *
 * This is a WARNING, never an error: specs load out-of-tree from the providers
 * channel, and failing them closed on a stylistic lint would kill a working
 * third-party provider on upgrade. Structural validation (validateFsmSpec) is
 * unchanged.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { collectFsmSpecWarnings, validateFsmSpec, loadFsmSpec } from '../../../src/providers/spec/fsm-loader.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const CLI_ROOT = path.join(REPO_ROOT, 'adhdev-providers/cli');

function v4Spec(over: Record<string, unknown>): unknown {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'lint-fixture',
        binary: 'demo',
        send_message: { submit_key: '\r' },
        states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }, { id: 'busy', label: 'Busy', status: 'generating' }],
        transitions: [{ from: 'idle', to: 'busy', when: over }],
    };
}

describe('collectFsmSpecWarnings — line-anchor lint', () => {
    it('warns on ^ without the m flag', () => {
        const warns = collectFsmSpecWarnings(v4Spec({ matches: '^\\s*Do you trust' }));
        expect(warns).toHaveLength(1);
        expect(warns[0]).toMatch(/without the "m" flag/);
        expect(warns[0]).toContain('transitions[0].when');
    });

    it('warns on $ without the m flag', () => {
        expect(collectFsmSpecWarnings(v4Spec({ matches: 'proceed\\?$' }))).toHaveLength(1);
    });

    it('does NOT warn when the m flag is present', () => {
        expect(collectFsmSpecWarnings(v4Spec({ matches: '^\\s*Do you trust', flags: 'im' }))).toEqual([]);
    });

    it('does NOT warn for the (?:^|\\n) line-start idiom', () => {
        expect(collectFsmSpecWarnings(v4Spec({ matches: '(?:^|\\n)\\s*Do you trust' }))).toEqual([]);
    });

    it('does NOT warn for the (?=\\n|$) line-end idiom (used by claude-cli 4.0)', () => {
        expect(collectFsmSpecWarnings(v4Spec({ matches: '(?:^|\\n)\\s*esc to interrupt\\s*(?=\\n|$)' }))).toEqual([]);
    });

    it('still warns when only ONE anchor is an idiom and the other is bare', () => {
        expect(collectFsmSpecWarnings(v4Spec({ matches: '(?:^|\\n)\\s*esc to interrupt\\s*$' }))).toHaveLength(1);
    });

    it('does NOT warn for an ESCAPED caret or dollar (literal characters)', () => {
        expect(collectFsmSpecWarnings(v4Spec({ matches: 'cost: \\$5' }))).toEqual([]);
        expect(collectFsmSpecWarnings(v4Spec({ matches: 'a\\^b' }))).toEqual([]);
    });

    it('does NOT warn for a ^ that is a character-class negation', () => {
        expect(collectFsmSpecWarnings(v4Spec({ matches: 'Run [^\\n]+ now' }))).toEqual([]);
    });

    it('recurses into all/any/not', () => {
        const warns = collectFsmSpecWarnings(v4Spec({
            all: [{ matches: 'ok' }, { any: [{ not: { matches: '^bad' } }] }],
        }));
        expect(warns).toHaveLength(1);
        expect(warns[0]).toContain('transitions[0].when.all[1].any[0].not');
    });

    it('is advisory only — a warning spec still VALIDATES and LOADS', () => {
        const spec = v4Spec({ matches: '^\\s*Do you trust' });
        expect(validateFsmSpec(spec)).toEqual([]); // no error added
        expect(collectFsmSpecWarnings(spec)).toHaveLength(1);
    });
});

describe('built-in specs are lint-clean', () => {
    const specFiles: string[] = [];
    for (const dir of fs.readdirSync(CLI_ROOT).sort()) {
        const specDir = path.join(CLI_ROOT, dir, 'specs');
        if (!fs.existsSync(specDir)) continue;
        for (const f of fs.readdirSync(specDir).filter(n => n.endsWith('.json')).sort()) {
            specFiles.push(path.join(specDir, f));
        }
    }

    it('covers every provider spec on disk (scan-target count guard)', () => {
        // 8 built-in CLI providers ship v4 specs; the scan must not silently
        // shrink to zero (a wrong CLI_ROOT would make every case below vacuous).
        const providers = new Set(specFiles.map(f => path.basename(path.dirname(path.dirname(f)))));
        expect(providers.size).toBeGreaterThanOrEqual(8);
        expect(specFiles.length).toBeGreaterThanOrEqual(providers.size);
    });

    // The ONE known advisory hit across all built-ins, reviewed 2026-09-08 and
    // deliberately left as-is: claude-cli's busy→idle guard consumes trailing
    // lines to the END OF THE `body` SECTION, so a bare `$` (whole-haystack
    // anchor, no `m`) is the CORRECT semantics — not the per-line mistake the
    // lint targets. It is listed here rather than silenced in the engine so a
    // NEW violation still turns this test red. This is exactly why the lint is a
    // warning and never an error.
    const KNOWN_ADVISORY: Record<string, number> = { 'claude-cli/specs/4.0.json': 1 };

    it.each(specFiles.map(f => [path.relative(CLI_ROOT, f), f]))('%s has zero unreviewed lint warnings', (name, file) => {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw.$schema !== 'adhdev:cli/spec@4') return; // v1/v3 are out of scope
        const warns = collectFsmSpecWarnings(raw);
        expect(warns).toHaveLength(KNOWN_ADVISORY[name as string] ?? 0);
    });

    it('the known-advisory list stays minimal (one entry, one hit)', () => {
        expect(Object.values(KNOWN_ADVISORY)).toEqual([1]);
    });

    it('loadFsmSpec surfaces a warnings array on the ok result', () => {
        const spec = specFiles.find(f => f.endsWith(path.join('antigravity-cli', 'specs', '4.0.json')))!;
        const res = loadFsmSpec(spec);
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.warnings).toEqual([]);
    });
});
