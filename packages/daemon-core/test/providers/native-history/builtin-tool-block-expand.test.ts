/**
 * (TOOL-EXPAND) Tool-bubble truncation and on-demand expansion for the
 * BUILT-IN readers.
 *
 * The declarative counterpart is covered by
 * `spec/native-history-tool-block-expand.test.ts`. This file covers the readers
 * that parse their provider's format in hand-written code, where the ref is
 * minted and resolved by the same parser rather than by a `tools` map.
 *
 * Three properties are asserted per participating reader, because any one of
 * them failing produces a DIFFERENT visible defect:
 *
 *   1. a long block is capped AND stamped   → without this, no expand button
 *   2. a short block is capped-not-stamped  → without this, a button that
 *                                              returns the same text back
 *   3. the stamped ref round-trips to text longer than the bubble
 *                                            → without this, a button that
 *                                              always errors
 *
 * Caps are asserted by arithmetic against the exported constants rather than by
 * restating 240/600, so a future cap change cannot leave a test green against a
 * stale number.
 *
 * The two NON-participating readers (hermes/antigravity) are asserted to refuse
 * with a typed reason, since "no tool bubbles to expand" must be a truthful
 * answer rather than a crash or an empty body.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    TOOL_CALL_SUMMARY_MAX,
    TOOL_RESULT_SUMMARY_MAX,
} from '../../../src/providers/spec/native-history-tool-blocks.js';
import { expandBuiltinReaderToolBlock } from '../../../src/providers/native-history/builtin-tool-block-expand.js';
import { readSession as readClaudeSession } from '../../../src/providers/native-history/claude-cli-transcript.js';
import { readSession as readGrokSession } from '../../../src/providers/native-history/grok-cli-transcript.js';

let tmpHome = '';
let realHome = '';

beforeEach(() => {
    realHome = os.homedir();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-tool-expand-'));
    // The readers resolve their stores under the home directory, so the test
    // store has to BE the home directory — otherwise the dispatcher resolves
    // the developer's real transcripts and the assertions read whatever
    // happens to be on the machine.
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    if (tmpHome && fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Far longer than the call cap, and meaningfully longer once flattened. */
const LONG_COMMAND = `rg --files-with-matches ${'--glob=!node_modules/ '.repeat(40)}pattern`;
/** Far longer than the result cap. */
const LONG_RESULT = Array.from({ length: 200 }, (_, i) => `src/module-${i}/index.ts`).join('\n');
/** Comfortably UNDER both caps — must never be stamped. */
const SHORT_COMMAND = 'ls -la';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function writeJsonl(filePath: string, records: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function flatLength(s: string): number {
    return s.replace(/\s+/g, ' ').trim().length;
}

describe('claude-cli built-in reader', () => {
    const WORKSPACE = '/tmp/ws-claude';

    function writeClaudeTranscript(): string {
        // `cwdAsDashes` maps the workspace to the project directory name.
        const dir = path.join(tmpHome, '.claude', 'projects', WORKSPACE.replace(/\//g, '-'));
        const filePath = path.join(dir, `${SESSION_ID}.jsonl`);
        writeJsonl(filePath, [
            {
                type: 'user', sessionId: SESSION_ID, cwd: WORKSPACE, timestamp: 1_700_000_000_000,
                message: { role: 'user', content: [{ type: 'text', text: 'find the files' }] },
            },
            {
                type: 'assistant', sessionId: SESSION_ID, timestamp: 1_700_000_001_000,
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'tool_use', name: 'Bash', input: { command: LONG_COMMAND } },
                        { type: 'tool_use', name: 'Bash', input: { command: SHORT_COMMAND } },
                    ],
                },
            },
            {
                type: 'user', sessionId: SESSION_ID, timestamp: 1_700_000_002_000,
                message: { role: 'user', content: [{ type: 'tool_result', content: LONG_RESULT }] },
            },
        ]);
        return filePath;
    }

    it('caps a long tool call and stamps an addressable ref', () => {
        const filePath = writeClaudeTranscript();
        const session = readClaudeSession(filePath)!;
        expect(session).toBeTruthy();

        const call = session.messages.find((m) => m.kind === 'tool' && m.content.startsWith('Bash:'))!;
        expect(call).toBeTruthy();
        // `Bash: ` prefix plus a body capped at exactly the call max.
        expect(flatLength(call.content)).toBeLessThanOrEqual(TOOL_CALL_SUMMARY_MAX + 'Bash: '.length);
        expect(flatLength(call.content)).toBeLessThan(flatLength(LONG_COMMAND));
        expect(call.toolBlockRef).toEqual({
            sourceMtimeMs: session.sourceMtimeMs,
            recordIndex: 1,
            blockIndex: 0,
        });
    });

    it('does NOT stamp a tool call that fits under the cap', () => {
        const filePath = writeClaudeTranscript();
        const session = readClaudeSession(filePath)!;
        const shortCall = session.messages.find((m) => m.content === `Bash: ${SHORT_COMMAND}`)!;
        expect(shortCall).toBeTruthy();
        // Nothing was lost, so offering to expand would return the same text.
        expect(shortCall.toolBlockRef).toBeUndefined();
    });

    it('caps a long tool result and stamps it', () => {
        const filePath = writeClaudeTranscript();
        const session = readClaudeSession(filePath)!;
        const result = session.messages.find((m) => m.kind === 'tool' && m.content.startsWith('src/module-0'))!;
        expect(result).toBeTruthy();
        expect(flatLength(result.content)).toBeLessThanOrEqual(TOOL_RESULT_SUMMARY_MAX);
        expect(result.toolBlockRef).toMatchObject({ recordIndex: 2, blockIndex: 0 });
    });

    it('round-trips a stamped ref back to the untruncated body', () => {
        const filePath = writeClaudeTranscript();
        const session = readClaudeSession(filePath)!;
        const result = session.messages.find((m) => m.kind === 'tool' && m.content.startsWith('src/module-0'))!;

        const expanded = expandBuiltinReaderToolBlock(
            'claude-cli',
            { sessionId: SESSION_ID, providerSessionId: SESSION_ID, workspace: WORKSPACE },
            result.toolBlockRef!,
        );
        expect(expanded.ok).toBe(true);
        if (!expanded.ok) return;
        expect(expanded.result).toBe(LONG_RESULT);
        expect(expanded.truncated).toBe(true);
        // The whole point: expanding shows MORE than the bubble did.
        expect(expanded.result!.length).toBeGreaterThan(result.content.length);
    });

    it('refuses a ref whose mtime seal no longer matches', () => {
        const filePath = writeClaudeTranscript();
        const session = readClaudeSession(filePath)!;
        const result = session.messages.find((m) => m.toolBlockRef)!;

        const stale = { ...result.toolBlockRef!, sourceMtimeMs: result.toolBlockRef!.sourceMtimeMs + 1 };
        const expanded = expandBuiltinReaderToolBlock(
            'claude-cli',
            { sessionId: SESSION_ID, providerSessionId: SESSION_ID, workspace: WORKSPACE },
            stale,
        );
        // Must refuse rather than resolve: the indices could now name a
        // different tool's output, and showing that is worse than showing none.
        expect(expanded).toEqual({ ok: false, reason: 'source_changed' });
    });

    it('refuses a ref pointing past the end of the transcript', () => {
        const filePath = writeClaudeTranscript();
        const session = readClaudeSession(filePath)!;
        const expanded = expandBuiltinReaderToolBlock(
            'claude-cli',
            { sessionId: SESSION_ID, providerSessionId: SESSION_ID, workspace: WORKSPACE },
            { sourceMtimeMs: session.sourceMtimeMs, recordIndex: 9999, blockIndex: 0 },
        );
        expect(expanded).toEqual({ ok: false, reason: 'block_not_found' });
    });
});

describe('grok-cli built-in reader', () => {
    const WORKSPACE = '/tmp/ws-grok';

    function writeGrokTranscript(): string {
        const dir = path.join(tmpHome, '.grok', 'sessions', encodeURIComponent(WORKSPACE), SESSION_ID);
        const filePath = path.join(dir, 'chat_history.jsonl');
        writeJsonl(filePath, [
            { type: 'system', content: 'system prompt — never surfaced' },
            { type: 'user', content: [{ type: 'text', text: '<user_query>go</user_query>' }] },
            {
                type: 'assistant',
                content: '',
                tool_calls: [{ id: 'c1', name: 'run_terminal_command', arguments: JSON.stringify({ command: LONG_COMMAND }) }],
            },
            { type: 'tool_result', tool_call_id: 'c1', content: [{ type: 'text', text: LONG_RESULT }] },
        ]);
        return filePath;
    }

    it('stamps a record-level ref (blockIndex -1) that skips non-chat records', () => {
        const filePath = writeGrokTranscript();
        const session = readGrokSession(filePath, SESSION_ID, WORKSPACE)!;
        expect(session).toBeTruthy();

        const call = session.messages.find((m) => m.content.startsWith('[tool: run_terminal_command]'))!;
        expect(call).toBeTruthy();
        // recordIndex 2, NOT 1: the dropped `system` record still occupies a
        // position in the record array the expand path rebuilds. This is the
        // off-by-one that would silently return the wrong tool's output.
        expect(call.toolBlockRef).toEqual({
            sourceMtimeMs: session.sourceMtimeMs,
            recordIndex: 2,
            blockIndex: -1,
        });
    });

    it('round-trips a tool result back to the untruncated body', () => {
        const filePath = writeGrokTranscript();
        const session = readGrokSession(filePath, SESSION_ID, WORKSPACE)!;
        const result = session.messages.find((m) => m.content.startsWith('src/module-0'))!;
        expect(result.toolBlockRef).toMatchObject({ recordIndex: 3, blockIndex: -1 });

        const expanded = expandBuiltinReaderToolBlock(
            'grok-cli',
            { sessionId: SESSION_ID, providerSessionId: SESSION_ID, workspace: WORKSPACE },
            result.toolBlockRef!,
        );
        expect(expanded.ok).toBe(true);
        if (!expanded.ok) return;
        expect(expanded.result).toBe(LONG_RESULT);
        expect(expanded.result!.length).toBeGreaterThan(result.content.length);
    });
});

describe('readers with nothing to expand', () => {
    // Not an oversight — measured. hermes emits every row as `kind:'standard'`
    // (no tool bubbles at all) and antigravity's live .db path does the same,
    // while its legacy brain path carries row content in full and never
    // truncates. Neither has a positional record index a ref could address.
    it.each(['hermes-cli', 'antigravity-cli'])('refuses %s with a typed reason', (reader) => {
        const expanded = expandBuiltinReaderToolBlock(
            reader,
            { sessionId: SESSION_ID, workspace: '/tmp/ws' },
            { sourceMtimeMs: 1, recordIndex: 0, blockIndex: -1 },
        );
        expect(expanded).toEqual({ ok: false, reason: 'unsupported_source' });
    });

    it('refuses an unknown reader rather than throwing', () => {
        const expanded = expandBuiltinReaderToolBlock(
            'some-future-cli',
            { sessionId: SESSION_ID, workspace: '/tmp/ws' },
            { sourceMtimeMs: 1, recordIndex: 0, blockIndex: -1 },
        );
        expect(expanded).toEqual({ ok: false, reason: 'unsupported_source' });
    });
});
