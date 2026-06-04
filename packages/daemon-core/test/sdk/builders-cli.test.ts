/**
 * Unit tests for the four CLI v1 builders.
 *
 * These are guard tests against the kind of regression that wedged
 * codex-cli #102 — small enough to read end-to-end, each table row
 * captures one (manifest fragment + input frame → expected verdict)
 * pair, named after the contract case it exercises. When a builder
 * changes shape, the failing assertion line names the case directly
 * instead of dropping the maintainer into a 100-line stack trace.
 */

import { describe, expect, it } from 'vitest';
import {
    buildDetectStatusFromTui,
    buildParseApprovalFromTui,
    buildParseSessionFromTui,
    normalizeMessageIdentity,
} from '../../src/providers/sdk/v1/index.js';

// ─── buildDetectStatusFromTui ──────────────────────────────────────────────

describe('buildDetectStatusFromTui', () => {
    const spec = {
        spinner: {
            $schema: 'adhdev:tui/spinner@1' as const,
            patterns: [
                { regex: 'Esc to interrupt', flags: 'i' },
                { regex: 'Thinking', flags: 'i' },
            ],
            scope: 'live-frame-tail' as const,
            scopeWindowLines: 8,
        },
        settledPrompt: {
            $schema: 'adhdev:tui/settled-prompt@1' as const,
            regex: '^>\\s*$',
            flags: 'm' as const,
            scope: 'last-n-lines' as const,
            scopeWindowLines: 6,
        },
    };

    const detect = buildDetectStatusFromTui(spec as any);

    it('returns generating when the live frame shows a spinner cue', () => {
        const result = detect({
            screenText: '> Working on it\nEsc to interrupt',
            rawBuffer: '> Working on it\nEsc to interrupt',
            tail: '> Working on it\nEsc to interrupt',
        } as any);
        expect(result).toBe('generating');
    });

    it('returns idle when only the settled-prompt regex matches', () => {
        const screen = 'Welcome\n>\n';
        const result = detect({
            screenText: screen,
            rawBuffer: screen,
            tail: screen,
        } as any);
        expect(result).toBe('idle');
    });

    it('returns null when neither cue matches — the engine keeps prior status', () => {
        const result = detect({
            screenText: 'noise\nmore noise',
            rawBuffer: 'noise\nmore noise',
            tail: 'noise\nmore noise',
        } as any);
        expect(result).toBeNull();
    });
});

// ─── buildParseApprovalFromTui ──────────────────────────────────────────────

describe('buildParseApprovalFromTui', () => {
    const modal = {
        $schema: 'adhdev:tui/modal@1' as const,
        questionPattern: 'Do you want to proceed\\?',
        questionFlags: 'i',
        buttonPattern: '^\\s*\\d+\\.\\s+(.+)$',
        buttonFlags: 'm',
    };

    const parse = buildParseApprovalFromTui(modal as any);

    it('extracts message + buttons when a modal frame is present', () => {
        const screen = [
            'Do you want to proceed?',
            '  1. Yes',
            '  2. No',
        ].join('\n');
        const r = parse({ screenText: screen, rawBuffer: screen, buffer: screen, tail: screen } as any);
        expect(r).not.toBeNull();
        expect(r?.message).toContain('proceed');
        expect(r?.buttons).toEqual(['Yes', 'No']);
    });

    it('returns null when no modal question is visible', () => {
        const r = parse({ screenText: 'idle frame', rawBuffer: '', buffer: '', tail: '' } as any);
        expect(r).toBeNull();
    });
});

// ─── buildParseSessionFromTui ──────────────────────────────────────────────

describe('buildParseSessionFromTui', () => {
    const tui = {
        spinner: {
            $schema: 'adhdev:tui/spinner@1',
            patterns: [{ regex: 'Esc to interrupt', flags: 'i' }],
            scope: 'live-frame-tail',
            scopeWindowLines: 8,
        },
        settledPrompt: {
            $schema: 'adhdev:tui/settled-prompt@1',
            regex: '^>\\s*$',
            flags: 'm',
            scope: 'last-n-lines',
            scopeWindowLines: 6,
        },
        transcriptPty: {
            $schema: 'adhdev:tui/transcript-pty@1' as const,
            assistantPrefix: { regex: '^•\\s+(.*)$' },
            userPrefix: { regex: '^>\\s+(.*)$' },
            scope: 'buffer' as const,
        },
    };

    const parse = buildParseSessionFromTui(tui as any);

    it('extracts user + assistant lines from a buffer with transcript prefixes', () => {
        const buffer = [
            '> hi there',
            '• hello back',
            '>',
        ].join('\n');
        const r = parse({ buffer, rawBuffer: buffer, screenText: buffer, tail: buffer });
        const roles = r.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant']);
        expect(r.messages[0]?.content).toContain('hi');
        expect(r.messages[1]?.content).toContain('hello');
    });

    it('reports idle when the trailing frame shows a settled prompt', () => {
        const buffer = '> hi\n• reply\n>\n';
        const r = parse({ buffer, rawBuffer: buffer, screenText: buffer, tail: buffer });
        expect(r.status).toBe('idle');
    });

    // ─── tui/session-id-extraction@1 ───────────────────────────────────────
    // Verifies the new primitive: when a manifest declares a regex with a
    // capture group, the synth result must surface the captured group as
    // `providerSessionId`. When the regex is absent the field stays unset.

    it('omits providerSessionId when sessionIdExtraction is not configured', () => {
        const buffer = '> hi\n• reply\n>\n';
        const r = parse({ buffer, rawBuffer: buffer, screenText: buffer, tail: buffer });
        expect(r.providerSessionId).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(r, 'providerSessionId')).toBe(false);
    });

    it('extracts providerSessionId from the codex-style footer using the documented regex', () => {
        const codexTui = {
            ...tui,
            sessionIdExtraction: {
                $schema: 'adhdev:tui/session-id-extraction@1' as const,
                // Same pattern shipped in the schema examples and documented in
                // the SDK guide — capture group 1 = UUID.
                regex: '(?:gpt-|o\\d|codex-)[^·]+·[^·]+·\\s*([0-9a-f-]{36})',
                scope: 'tail' as const,
                label: 'codex-footer',
            },
        };
        const codexParse = buildParseSessionFromTui(codexTui as any);
        const buffer = [
            '> draft a haiku',
            '• sure, here goes…',
            '',
            'gpt-5.5 high · ~/Work/adhdev · 019e8e58-4bd2-7c80-8f5b-b49b6c0e25fa',
        ].join('\n');
        const r = codexParse({ buffer, rawBuffer: buffer, screenText: buffer, tail: buffer });
        expect(r.providerSessionId).toBe('019e8e58-4bd2-7c80-8f5b-b49b6c0e25fa');
    });

    it('leaves providerSessionId unset when the extraction regex does not match', () => {
        const codexTui = {
            ...tui,
            sessionIdExtraction: {
                $schema: 'adhdev:tui/session-id-extraction@1' as const,
                regex: 'session id:\\s*([0-9a-f-]{36})',
                flags: 'i',
                scope: 'tail' as const,
            },
        };
        const codexParse = buildParseSessionFromTui(codexTui as any);
        const buffer = '> hi\n• reply with no session footer\n>\n';
        const r = codexParse({ buffer, rawBuffer: buffer, screenText: buffer, tail: buffer });
        expect(r.providerSessionId).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(r, 'providerSessionId')).toBe(false);
    });
});

// ─── normalizeMessageIdentity ──────────────────────────────────────────────

describe('normalizeMessageIdentity', () => {
    it('stamps stable providerUnitKey + bubbleId for each message', () => {
        const stamped = normalizeMessageIdentity([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
        ], 'idle');
        expect(stamped).toHaveLength(2);
        for (const m of stamped) {
            expect(m).toHaveProperty('bubbleId');
            expect(m).toHaveProperty('providerUnitKey');
            expect(typeof (m as any).bubbleId).toBe('string');
            expect((m as any).bubbleId.length).toBeGreaterThan(0);
        }
        // bubbleIds must be unique per message in the same pass.
        expect((stamped[0] as any).bubbleId).not.toBe((stamped[1] as any).bubbleId);
    });

    it('marks the trailing assistant as streaming when the session is generating', () => {
        const stamped = normalizeMessageIdentity([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'partial' },
        ], 'generating');
        expect((stamped[1] as any).bubbleState).toBe('streaming');
    });

    it('returns an empty array unchanged', () => {
        expect(normalizeMessageIdentity([], 'idle')).toEqual([]);
    });
});
