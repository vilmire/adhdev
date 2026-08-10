/**
 * NATIVE TURN-TERMINAL SIGNAL.
 *
 * The defect this closes, measured on 40 local codex rollouts:
 *   - 990 completed turns, of which 193 (19.5%) carried NO assistant text.
 *   - All 193 were dropped by codex-cli-transcript's `if (!text) return`, so the
 *     completion engine saw "no final assistant" and could only be released by a
 *     timeout — the root of the infinite-generating class.
 *   - 992 of 997 turns were explicitly terminated (task_complete / turn_aborted);
 *     the 5 exceptions were process crashes, which is why ONE outer timeout stays.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    resolveNativeCompletionSignalSpec,
    selectTurnTerminalMarker,
    providerHasNativeTurnSignal,
    type NativeTurnTerminalMarker,
} from '../../src/providers/completion/native-turn-signal';

let tmpDir = '';

vi.mock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return { ...actual, homedir: () => tmpDir };
});

const T0 = 1_000_000;

describe('resolveNativeCompletionSignalSpec — declaration, not provider branching', () => {
    it('reads a full codex-shaped declaration', () => {
        const spec = resolveNativeCompletionSignalSpec({
            mode: 'native-source',
            completionSignal: {
                recordType: 'task_complete',
                abortRecordType: 'turn_aborted',
                summaryField: 'last_agent_message',
                turnIdField: 'turn_id',
            },
        });
        expect(spec).toEqual({
            recordType: 'task_complete',
            abortRecordType: 'turn_aborted',
            summaryField: 'last_agent_message',
            turnIdField: 'turn_id',
        });
    });

    it('accepts a minimal declaration (recordType alone)', () => {
        expect(resolveNativeCompletionSignalSpec({ completionSignal: { recordType: 'done' } }))
            .toEqual({ recordType: 'done' });
    });

    it('returns null for a provider that declares no signal (claude-cli / hermes-cli path)', () => {
        expect(resolveNativeCompletionSignalSpec({ mode: 'native-source' })).toBeNull();
        expect(resolveNativeCompletionSignalSpec(undefined)).toBeNull();
        expect(resolveNativeCompletionSignalSpec(null)).toBeNull();
    });

    it('rejects a malformed declaration rather than half-adopting it', () => {
        expect(resolveNativeCompletionSignalSpec({ completionSignal: 'task_complete' })).toBeNull();
        expect(resolveNativeCompletionSignalSpec({ completionSignal: { recordType: '   ' } })).toBeNull();
        expect(resolveNativeCompletionSignalSpec({ completionSignal: {} })).toBeNull();
    });
});

describe('selectTurnTerminalMarker — turn scoping', () => {
    const mk = (over: Partial<NativeTurnTerminalMarker>): NativeTurnTerminalMarker => ({
        receivedAt: T0, outcome: 'completed', summary: 'done', ...over,
    });

    it('prefers the provider-native turn id over any timestamp heuristic', () => {
        const markers = [
            mk({ receivedAt: T0 - 5_000, turnId: 'turn-A', summary: 'prior turn' }),
            mk({ receivedAt: T0 + 1_000, turnId: 'turn-B', summary: 'this turn' }),
        ];
        expect(selectTurnTerminalMarker(markers, { turnId: 'turn-A' })?.summary).toBe('prior turn');
        expect(selectTurnTerminalMarker(markers, { turnId: 'turn-B' })?.summary).toBe('this turn');
    });

    it('returns null when the wanted turn id has no marker yet (turn still running)', () => {
        const markers = [mk({ turnId: 'turn-A' })];
        expect(selectTurnTerminalMarker(markers, { turnId: 'turn-B' })).toBeNull();
    });

    it('falls back to the turn-start boundary when no turn id is known', () => {
        const markers = [mk({ receivedAt: T0 + 500 })];
        expect(selectTurnTerminalMarker(markers, { turnStartedAt: T0 })).not.toBeNull();
    });

    it('(ANTIGRAVITY-PREMATURE-COMPLETION) rejects a marker predating this turn', () => {
        const markers = [mk({ receivedAt: T0 - 1 })];
        expect(selectTurnTerminalMarker(markers, { turnStartedAt: T0 })).toBeNull();
    });

    it('rejects an unscoped marker rather than failing open', () => {
        const markers = [mk({})];
        expect(selectTurnTerminalMarker(markers, {})).toBeNull();
    });

    it('handles empty / missing marker lists', () => {
        expect(selectTurnTerminalMarker([], { turnStartedAt: T0 })).toBeNull();
        expect(selectTurnTerminalMarker(null, { turnStartedAt: T0 })).toBeNull();
    });
});

// ─── The 19.5% case, against the real codex record shape ────────────────────

/** Writes a rollout with explicit per-line envelope types (event_msg vs response_item). */
function writeRollout(sessionId: string, lines: Array<{ type: string; payload: Record<string, unknown>; ts?: number }>): string {
    const dir = path.join(tmpDir, '.codex', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const sessionTs = 1_800_000_000_000;
    const out = [
        JSON.stringify({ type: 'session_meta', timestamp: sessionTs, payload: { id: sessionId, cwd: '/workspaces/project', timestamp: sessionTs } }),
        ...lines.map((l, i) => JSON.stringify({ type: l.type, timestamp: l.ts ?? (sessionTs + 1_000 * (i + 1)), payload: l.payload })),
    ];
    fs.writeFileSync(filePath, out.join('\n') + '\n', 'utf-8');
    return filePath;
}

const SID = '22222222-0000-0000-0000-00000000000';

describe('codex reader surfaces a terminal marker even with NO assistant text (the 19.5%)', () => {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-codex-signal-'));
        vi.resetModules();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = '';
    });

    it('a turn ending in a tool call with an EMPTY last_agent_message still yields a terminal marker', async () => {
        const sessionId = `${SID}1`;
        const p = writeRollout(sessionId, [
            { type: 'event_msg', payload: { type: 'task_started' } },
            { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] } },
            { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
            // The exact live shape: terminal event, no summary text at all.
            { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '' } },
        ]);
        const { readSession } = await import('../../src/providers/native-history/codex-cli-transcript');
        const session = readSession(p);
        const markers = session?.turnTerminalMarkers ?? [];
        expect(markers, 'no terminal marker surfaced for an assistant-less turn').toHaveLength(1);
        expect(markers[0].outcome).toBe('completed');
        expect(markers[0].summary).toBe('');
        expect(markers[0].turnId).toBe('turn-1');
    });

    it('a normal turn still carries its summary text through the marker', async () => {
        const sessionId = `${SID}2`;
        const p = writeRollout(sessionId, [
            { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
            { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2', last_agent_message: 'all done' } },
        ]);
        const { readSession } = await import('../../src/providers/native-history/codex-cli-transcript');
        const session = readSession(p);
        const markers = session?.turnTerminalMarkers ?? [];
        expect(markers).toHaveLength(1);
        expect(markers[0].summary).toBe('all done');
        expect(markers[0].outcome).toBe('completed');
        // The assistant bubble is still produced for chat display (no regression).
        expect(session?.messages.some(m => m.role === 'assistant' && m.content === 'all done')).toBe(true);
    });

    it('turn_aborted surfaces as an aborted marker, not a completion', async () => {
        const sessionId = `${SID}3`;
        const p = writeRollout(sessionId, [
            { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
            { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-3' } },
        ]);
        const { readSession } = await import('../../src/providers/native-history/codex-cli-transcript');
        const session = readSession(p);
        const markers = session?.turnTerminalMarkers ?? [];
        expect(markers).toHaveLength(1);
        expect(markers[0].outcome).toBe('aborted');
        expect(markers[0].turnId).toBe('turn-3');
    });

    it('a turn still in flight produces NO terminal marker', async () => {
        const sessionId = `${SID}4`;
        const p = writeRollout(sessionId, [
            { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
            { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
        ]);
        const { readSession } = await import('../../src/providers/native-history/codex-cli-transcript');
        const session = readSession(p);
        expect(session?.turnTerminalMarkers ?? []).toHaveLength(0);
    });
});

describe('providerHasNativeTurnSignal — who gets the native path', () => {
    it('codex-cli qualifies via its built-in reader even without a manifest declaration', () => {
        expect(providerHasNativeTurnSignal({ type: 'codex-cli', nativeHistory: { mode: 'native-source' } })).toBe(true);
    });

    it('ANY provider qualifies by manifest declaration alone — no code change needed', () => {
        expect(providerHasNativeTurnSignal({
            type: 'some-future-cli',
            nativeHistory: { mode: 'native-source', completionSignal: { recordType: 'turn_done' } },
        })).toBe(true);
    });

    it('claude-cli and hermes-cli do NOT qualify (no terminal record exists)', () => {
        expect(providerHasNativeTurnSignal({ type: 'claude-cli', nativeHistory: { mode: 'native-source' } })).toBe(false);
        expect(providerHasNativeTurnSignal({ type: 'hermes-cli' })).toBe(false);
        expect(providerHasNativeTurnSignal(null)).toBe(false);
    });
});

describe('signal-less providers keep the inference path (no regression)', () => {
    // claude-cli has no turn-terminal record type at all; hermes-cli has no native
    // transcript. Both must resolve to "no signal" so the engine keeps using shape
    // inference for them rather than silently gaining a native path they cannot support.
    it('claude-cli-shaped nativeHistory declares no completion signal', () => {
        const claudeNativeHistory = {
            $schema: 'adhdev:native-history/claude-jsonl@1',
            format: 'claude-jsonl',
            mode: 'native-source',
            contractVersion: '2.0',
        };
        expect(resolveNativeCompletionSignalSpec(claudeNativeHistory)).toBeNull();
    });

    it('hermes-cli (no nativeHistory at all) declares no completion signal', () => {
        expect(resolveNativeCompletionSignalSpec(null)).toBeNull();
    });
});
