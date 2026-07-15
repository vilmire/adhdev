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

import * as fs from 'node:fs';
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

    // ─── tui/transcript-pty userBackgroundSgr (cursor-agent bubble fix) ─────
    // cursor-agent renders the user's submitted turn + composer echo inside a
    // colored box (SGR 48;5;233 / 48;5;235) but the assistant answer as a plain
    // no-background line. With a permissive assistantPrefix, the ANSI-stripped
    // user echo would leak into an assistant bubble. userBackgroundSgr classifies
    // bg-boxed lines as user turns before the assistant rule runs.
    const cursorTui = {
        transcriptPty: {
            $schema: 'adhdev:tui/transcript-pty@1' as const,
            // Same permissive prefix cursor-cli ships: grabs any non-empty line.
            assistantPrefix: { regex: '^\\s*(\\S.*)$' },
            userBackgroundSgr: ['48;5;233', '48;5;235'],
            chromePatterns: [
                { regex: '\\bWorking\\b' },
                { regex: '^\\s*(?:Auto|Plan|Ask)\\s*$' },
                { regex: '^\\s*→\\s+Add a follow-up', flags: 'i' },
                { regex: '^\\s*Tip:', flags: 'i' },
                { regex: '^\\s*(?:~|/)[^\\n]*$' },
            ],
            scope: 'buffer' as const,
        },
    };
    const cursorParse = buildParseSessionFromTui(cursorTui as any);

    it('classifies a bg-boxed user turn as user and leaves the plain answer as the only assistant bubble', () => {
        // Minimal synthetic frame: boxed user turn (bg 235) + wrapped
        // continuation (bg 233) + plain assistant answer (no bg).
        const buffer = [
            ' \x1b[48;5;235m Provider smoke test. Reply with one line:\x1b[49m',
            ' \x1b[48;5;233m   do not run tools.\x1b[49m',
            ' \x1b[G  CURSOR OK 2+2=4',
        ].join('\n');
        const r = cursorParse({ buffer, rawBuffer: buffer, screenText: buffer, tail: buffer });
        const assistant = r.messages.filter((m) => m.role === 'assistant');
        const user = r.messages.filter((m) => m.role === 'user');
        // The only assistant bubble is the real answer.
        expect(assistant.map((m) => m.content)).toEqual(['CURSOR OK 2+2=4']);
        // The prompt echo + its wrapped continuation are attributed to the user.
        expect(user.some((m) => m.content.includes('Provider smoke test'))).toBe(true);
        // No assistant bubble contains the user's prompt text.
        expect(assistant.some((m) => m.content.includes('Provider smoke test'))).toBe(false);
    });

    it('does not leak the user prompt echo into an assistant bubble on a real cursor-agent buffer', () => {
        // Real PTY capture from cursor-agent v2026.07.09 (Provider smoke test →
        // "CURSOR OK 2+2=4"). See fixtures/cursor-agent-buffer-raw.bin.
        const fixturePath = new URL('./fixtures/cursor-agent-buffer-raw.bin', import.meta.url);
        const buffer = fs.readFileSync(fixturePath, 'utf8');
        const r = cursorParse({ buffer, rawBuffer: buffer, screenText: buffer, tail: buffer });
        const assistant = r.messages.filter((m) => m.role === 'assistant');
        // The real answer is present as an assistant bubble.
        expect(assistant.some((m) => m.content.includes('CURSOR OK 2+2=4'))).toBe(true);
        // The user's prompt never appears in an assistant bubble.
        expect(assistant.some((m) => m.content.includes('Provider smoke test'))).toBe(false);
        expect(assistant.some((m) => m.content.includes('tools or read files'))).toBe(false);
    });

    // ─── value-agnostic userBackgroundSgr sentinel ("*") ──────────────────────
    // CURSOR-PROMPT-ECHO-DOUBLECLASSIFY-RCA-2026-07-15: the exact-color allowlist
    // (48;5;233 / 48;5;235) is correct for TODAY's cursor-agent but re-broke every
    // time a TUI changed its box color (opencode rc.531 was the first recurrence).
    // The "*" sentinel keys off the *presence* of a background-color SGR — 256-color
    // OR truecolor — so a boxed user turn is classified user regardless of the exact
    // color, while a plain no-bg assistant line stays assistant. This is the shipped
    // cursor-cli config.
    const cursorAgnosticTui = {
        transcriptPty: {
            $schema: 'adhdev:tui/transcript-pty@1' as const,
            assistantPrefix: { regex: '^\\s*(\\S.*)$' },
            userBackgroundSgr: ['*'],
            // Mirror the shipped cursor-cli chromePatterns so the fixture assertion
            // reflects the real provider config (incl. the "Auto · N%" footer).
            chromePatterns: [
                { regex: '\\bWorking\\b' },
                { regex: '(?:ctrl\\+c|esc) to (?:cancel|interrupt|stop|skip)', flags: 'i' },
                { regex: '^\\s*(?:Auto|Plan|Ask)\\b[^\\n]*·' },
                { regex: '^\\s*(?:Auto|Plan|Ask)\\s*$' },
                { regex: '^\\s*→\\s+Add a follow-up', flags: 'i' },
                { regex: '^\\s*Tip:', flags: 'i' },
                { regex: '^\\s*Cursor Agent\\s*$' },
                { regex: '^\\s*v\\d+\\.\\d' },
                { regex: '^\\s*(?:~|/)[^\\n]*$' },
                { regex: '·\\s*$' },
                { regex: '^\\s*[A-Za-z][\\w.-]*/[\\w./-]+\\s*$' },
                { regex: '^\\s*[╭╰│>❯›]' },
            ],
            scope: 'buffer' as const,
        },
    };
    const cursorAgnosticParse = buildParseSessionFromTui(cursorAgnosticTui as any);

    it('"*" sentinel classifies the real cursor buffer identically to the exact allowlist (no echo leak)', () => {
        const fixturePath = new URL('./fixtures/cursor-agent-buffer-raw.bin', import.meta.url);
        const buffer = fs.readFileSync(fixturePath, 'utf8');
        const r = cursorAgnosticParse({ buffer, rawBuffer: buffer, screenText: buffer, tail: buffer });
        const assistant = r.messages.filter((m) => m.role === 'assistant');
        const user = r.messages.filter((m) => m.role === 'user');
        // (a) the user turn is classified user.
        expect(user.some((m) => m.content.includes('Provider smoke test'))).toBe(true);
        // (b) the echoed prompt does NOT produce a second assistant bubble.
        expect(assistant.some((m) => m.content.includes('Provider smoke test'))).toBe(false);
        expect(assistant.some((m) => m.content.includes('tools or read files'))).toBe(false);
        // (c) the real assistant reply IS classified assistant.
        expect(assistant.map((m) => m.content)).toEqual(['CURSOR OK 2+2=4']);
    });

    it('"*" sentinel catches a TRUECOLOR bg box the 256-color allowlist would miss', () => {
        // Regression the RCA feared: a future cursor-agent (or any boxed TUI) that
        // switches to truecolor `48;2;r;g;b`. The old ['48;5;233','48;5;235']
        // allowlist would not match, the boxed prompt would fall through to the
        // permissive assistantPrefix, and the user echo would leak as a CURSOR
        // AGENT bubble. The "*" sentinel matches any bg-color SGR, so it does not.
        const buffer = [
            ' \x1b[48;2;30;30;30m Truecolor test prompt from the user\x1b[49m',
            ' \x1b[48;2;40;40;40m   wrapped continuation of the prompt\x1b[49m',
            ' \x1b[G  ASSISTANT REPLY on a plain line',
        ].join('\n');
        const r = cursorAgnosticParse({ buffer, rawBuffer: buffer, screenText: buffer, tail: buffer });
        const assistant = r.messages.filter((m) => m.role === 'assistant');
        const user = r.messages.filter((m) => m.role === 'user');
        // Boxed truecolor lines → user.
        expect(user.some((m) => m.content.includes('Truecolor test prompt'))).toBe(true);
        expect(user.some((m) => m.content.includes('wrapped continuation'))).toBe(true);
        // Plain reply → the ONLY assistant bubble; no prompt echo leak.
        expect(assistant.map((m) => m.content)).toEqual(['ASSISTANT REPLY on a plain line']);
        expect(assistant.some((m) => m.content.includes('Truecolor test prompt'))).toBe(false);
    });

    it('"*" sentinel keeps a plain no-bg assistant line as assistant (no over-capture)', () => {
        // A genuine assistant answer carries no background SGR — it must stay
        // assistant even with the value-agnostic sentinel active.
        const buffer = [
            ' \x1b[48;5;235m the user asked something\x1b[49m',
            ' \x1b[G  plain assistant answer with no background',
            ' \x1b[38;5;12m colored FOREGROUND only, still assistant\x1b[39m',
        ].join('\n');
        const r = cursorAgnosticParse({ buffer, rawBuffer: buffer, screenText: buffer, tail: buffer });
        const assistant = r.messages.filter((m) => m.role === 'assistant');
        const user = r.messages.filter((m) => m.role === 'user');
        expect(user.map((m) => m.content)).toEqual(['the user asked something']);
        // Foreground-only color (38;5;…) must NOT be treated as a user box.
        expect(assistant.some((m) => m.content.includes('colored FOREGROUND only'))).toBe(true);
        expect(assistant.some((m) => m.content.includes('plain assistant answer'))).toBe(true);
        expect(user.some((m) => m.content.includes('FOREGROUND'))).toBe(false);
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

    // CHAT-FLAP-LONG-CONVO root-fix invariant: appending a message to the tail
    // must NOT change the providerUnitKey / bubbleId of any pre-existing message.
    // A `index`-embedded key breaks this — every earlier bubble shifts, web-core
    // sees a new React key, and the bubble remounts (a visible flash).
    it('keeps providerUnitKey/bubbleId stable for existing messages when the tail grows', () => {
        const base = [
            { role: 'user', content: 'question one' },
            { role: 'assistant', content: 'answer one' },
        ];
        const grown = [
            ...base,
            { role: 'user', content: 'question two' },
        ];
        const before = normalizeMessageIdentity(base, 'idle');
        const after = normalizeMessageIdentity(grown, 'idle');
        for (let i = 0; i < before.length; i += 1) {
            expect((after[i] as any).providerUnitKey).toBe((before[i] as any).providerUnitKey);
            expect((after[i] as any).bubbleId).toBe((before[i] as any).bubbleId);
        }
        // The new message must get its own distinct key.
        expect((after[2] as any).providerUnitKey).not.toBe((after[1] as any).providerUnitKey);
    });

    it('gives identical repeated lines distinct keys via occurrence ordinal', () => {
        const stamped = normalizeMessageIdentity([
            { role: 'assistant', content: 'ok' },
            { role: 'assistant', content: 'ok' },
        ], 'idle');
        expect((stamped[0] as any).providerUnitKey).not.toBe((stamped[1] as any).providerUnitKey);
        // …but appending does not renumber the earlier duplicate.
        const grown = normalizeMessageIdentity([
            { role: 'assistant', content: 'ok' },
            { role: 'assistant', content: 'ok' },
            { role: 'assistant', content: 'ok' },
        ], 'idle');
        expect((grown[0] as any).providerUnitKey).toBe((stamped[0] as any).providerUnitKey);
        expect((grown[1] as any).providerUnitKey).toBe((stamped[1] as any).providerUnitKey);
    });

    it('does not embed the array index in the v2-pty providerUnitKey', () => {
        const stamped = normalizeMessageIdentity([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' },
        ], 'idle');
        // Old format was v2-pty:role:kind:INDEX:hash — the index segment is gone.
        expect((stamped[1] as any).providerUnitKey).toMatch(/^v2-pty:assistant:standard:[0-9a-f]+:#0$/);
    });
});
