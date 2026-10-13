import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFsmSpecWarnings, loadFsmSpec, validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';

function spec(when: unknown) {
    return {
        $schema: 'adhdev:cli/spec@4', id: 'section-lint', binary: 'demo',
        send_message: { submit_key: '\r' }, sections: { tail: { from_bottom: 2 } },
        states: [{ id: 'idle', label: 'Idle', initial: true }, { id: 'busy', label: 'Busy' }],
        transitions: [{ from: 'idle', to: 'busy', when }],
    };
}

describe('ignored composite-section lint', () => {
    it.each(['all', 'any', 'not'])('warns on %s parent section without changing legacy load semantics', kind => {
        const leaf = { matches: 'Working' };
        const raw = spec({ section: 'tail', [kind]: kind === 'not' ? leaf : [leaf] });
        expect(validateFsmSpec(raw)).toEqual([]);
        const warnings = collectFsmSpecWarnings(raw);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('transitions[0].when.section is ignored');
        expect(warnings[0]).toContain('each screen-content leaf');
    });

    it('reports nested paths and keeps inspecting children for other lint', () => {
        const raw = spec({ all: [{ not: { section: 'tail', any: [{ matches: '^Working' }] } }] });
        const warnings = collectFsmSpecWarnings(raw);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toContain('transitions[0].when.all[0].not.section is ignored');
        expect(warnings[1]).toContain('without the "m" flag');
    });

    it('accepts explicit regex/stability leaf sections through all/any/not', () => {
        expect(collectFsmSpecWarnings(spec({ all: [
            { any: [{ section: 'tail', matches: 'Working' }] },
            { not: { section: 'tail', matches: 'cancel' } },
            { section: 'tail', stable_ms: 2500 },
        ] }))).toEqual([]);
    });

    it('surfaces the warning from loadFsmSpec for out-of-tree specs', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fsm-section-lint-'));
        try {
            const file = join(dir, 'spec.json');
            writeFileSync(file, JSON.stringify(spec({ section: 'tail', any: [{ matches: 'Working' }] })));
            const result = loadFsmSpec(file);
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.warnings).toEqual([expect.stringContaining('.section is ignored')]);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
