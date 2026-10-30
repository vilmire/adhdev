import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { preserveCodexGeneratingOnIdle } from '../../../src/providers/completion/codex-idle-observation.js';
import { CliProviderInstance } from '../../../src/providers/cli-provider-instance.js';
import { minimalSpecPath } from '../../helpers/minimal-spec.js';
import { evaluateFsm } from '../../../src/providers/spec/fsm-evaluator.js';
const T = 1_800_000_000_000;
afterEach(() => vi.useRealTimers());
function rig() {
    vi.useFakeTimers(); vi.setSystemTime(T + 10_000);
    const open = { nativeSessionId: 'native', turnId: 'one', startedAt: T + 100, inputAt: T + 200, inputDigest: 'digest' };
    const host: any = { type: 'codex-cli', providerSessionId: 'native', generatingStartedAt: T + 300,
        lastAcknowledgedUserInputAt: T, lastAcknowledgedInputDigest: 'digest',
        completingTurnTaskId: () => 'task', currentAttemptRef: () => ({ attemptId: 'attempt', generation: 0 }),
        lastAcknowledgedTurnOwner: JSON.stringify(['task', { attemptId: 'attempt', generation: 0 }]),
        readExternalCompletionMessages: vi.fn(() => { host.lastCodexOpenTurn = open; host.nativeTurnSampleAt = Date.now(); return []; }) };
    return { host, open };
}
describe('Codex native veto before committing screen idle', () => {
    it('preserves a live native turn through the real no-spinner stable arm and continuing command returns', () => {
        const { host } = rig();
        const spec = JSON.parse(fs.readFileSync(new URL('../../../../../../adhdev-providers/cli/codex-cli/specs/4.0.json', import.meta.url), 'utf8'));
        const screen = 'Tool returned: Script completed\nInner command is still running\n› ';
        const frame = evaluateFsm(spec, 'busy', screen, { row: 2, col: 2 }, screen.split('\n'),
            { now: T + 10_000, stateEnteredAt: T, regionLastChangedAt: new Map() });
        expect(frame.fired?.to).toBe('idle'); // actual screen classifier reproduces false turn idle
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(true);
        expect(preserveCodexGeneratingOnIdle(host)).toBe(true); // readout does not probe
        expect(host.readExternalCompletionMessages).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5_001);
        expect(preserveCodexGeneratingOnIdle(host)).toBe(true); // project the committed decision until the tick
        const refresh = host.readExternalCompletionMessages;
        host.readExternalCompletionMessages = () => []; // a probe cannot renew an expired sample
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(false);
        expect(preserveCodexGeneratingOnIdle(host)).toBe(false);
        host.readExternalCompletionMessages = refresh;
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(true);
    });
    it('accepts ACK then PTY generating then a delayed native task_started flush', () => {
        const { host, open } = rig();
        open.startedAt = T + 400; open.inputAt = T + 500;
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(true);
    });
    it.each(['terminal', 'abort', 'failure', 'unavailable', 'pending'])('releases on %s without retaining a previous observation', state => {
        const { host } = rig(); expect(preserveCodexGeneratingOnIdle(host, true)).toBe(true);
        vi.advanceTimersByTime(1_000);
        host.readExternalCompletionMessages = () => {
            host.lastCodexOpenTurn = undefined; host.nativeTurnSampleAt = Date.now();
            host.nativeHistoryReadPending = state === 'pending';
            return state === 'unavailable' ? null : [];
        };
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(false);
        expect(preserveCodexGeneratingOnIdle(host)).toBe(false);
    });
    it.each(['native', 'digest', 'old', 'future', 'task', 'attempt', 'generation', 'disposed', 'other-provider'])('does not hold for %s evidence', mismatch => {
        const { host, open } = rig();
        if (mismatch === 'native') open.nativeSessionId = 'foreign';
        if (mismatch === 'digest') open.inputDigest = 'foreign';
        if (mismatch === 'old') open.startedAt = T - 1;
        if (mismatch === 'future') open.inputAt = T + 20_000;
        if (mismatch === 'task') host.completingTurnTaskId = () => 'new-task';
        if (mismatch === 'attempt') host.currentAttemptRef = () => ({ attemptId: 'new-attempt', generation: 0 });
        if (mismatch === 'generation') host.currentAttemptRef = () => ({ attemptId: 'attempt', generation: 1 });
        if (mismatch === 'disposed') host.disposed = true;
        if (mismatch === 'other-provider') host.type = 'claude-cli';
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(false);
    });
    it('reuses a fresh probe for one second and preserves the accepted-turn fence after an unavailable read', () => {
        const { host, open } = rig();
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(true);
        vi.advanceTimersByTime(999);
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(true);
        expect(host.readExternalCompletionMessages).toHaveBeenCalledTimes(1);
        const refresh = host.readExternalCompletionMessages;
        host.readExternalCompletionMessages = () => null;
        vi.advanceTimersByTime(1);
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(false);
        host.readExternalCompletionMessages = refresh;
        open.turnId = 'foreign';
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(false);
        expect(preserveCodexGeneratingOnIdle(host)).toBe(false);
    });
    it('rejects a task boundary during the read and a foreign native turn under the same ACK', () => {
        const { host, open } = rig();
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(true);
        open.turnId = 'other'; expect(preserveCodexGeneratingOnIdle(host, true)).toBe(false);
        vi.advanceTimersByTime(5_000);
        expect(preserveCodexGeneratingOnIdle(host, true)).toBe(false);
        const next = rig().host;
        next.readExternalCompletionMessages = () => { next.completingTurnTaskId = () => 'new-task'; return []; };
        expect(preserveCodexGeneratingOnIdle(next, true)).toBe(false);
    });
});

describe('Codex instance shared status and existing tick', () => {
    it.each(['terminal', 'pending', 'unavailable'])('keeps the committed projection across tick jitter, then releases on %s', async release => {
        vi.useFakeTimers(); vi.setSystemTime(T);
        const id = '11111111-1111-4111-8111-111111111111';
        let observation: any;
        const instance: any = new CliProviderInstance({ _resolvedSpecPath: minimalSpecPath(),
            type: 'codex-cli', name: 'Synthetic Codex', category: 'cli', spawn: { command: 'codex', args: [] },
            nativeHistory: { mode: 'native-source', scripts: { readSession: 'readNativeHistory' } },
            scripts: { readNativeHistory: () => observation },
        } as any, '/synthetic/workspace', [], 'synthetic-instance', undefined, { providerSessionId: id, launchMode: 'resume' });
        instance.historyWriter = Object.fromEntries(['appendNewMessages', 'compactHistorySession', 'seedSessionHistory', 'appendSystemMarker',
            'promoteHistorySession', 'writeSessionStart'].map(key => [key, vi.fn()]));
        instance.currentAttemptRef = () => ({ attemptId: 'attempt', generation: 0 });
        instance.completingTurnTaskId = () => 'task';
        let screenStatus = 'generating';
        instance.adapter = { chatMessagesOwnedExternally: true, getStatus: () => ({ status: screenStatus, activeModal: null, messages: [] }),
            getScriptParsedStatus: () => ({ status: 'idle', messages: [] }), getRuntimeMetadata: () => null,
            getInteractivePromptTransport: () => null, hasPendingResponse: () => false };
        instance.recordAcknowledgedUserInput('Synthetic acknowledged input');
        vi.advanceTimersByTime(100);
        instance.lastStatus = 'idle';
        instance.detectStatusTransition();
        expect(instance.generatingStartedAt).toBe(T + 100);
        vi.advanceTimersByTime(500);
        screenStatus = 'idle';
        observation = { providerSessionId: id, sourcePath: '/synthetic/rollout.jsonl', sourceMtimeMs: Date.now(),
            messages: [{ role: 'user', content: 'Synthetic acknowledged input', receivedAt: T + 500 }],
            codexOpenTurn: { nativeSessionId: id, turnId: 'one', startedAt: T + 400, inputAt: T + 500, inputDigest: instance.lastAcknowledgedInputDigest } };
        instance.detectStatusTransition();
        expect(instance.lastStatus).toBe('generating'); expect(instance.completedDebouncePending).toBeNull();
        const state = instance.getState();
        expect(state.status).toBe('generating'); expect(state.activeChat.status).toBe('generating');
        // A dashboard read can run after sample expiry and before a delayed tick.
        const read = vi.spyOn(instance, 'readExternalCompletionMessages');
        vi.advanceTimersByTime(5_050);
        const beforeProbe = instance.getState();
        expect(beforeProbe.status).toBe(instance.lastStatus);
        expect(beforeProbe.activeChat.status).toBe(instance.lastStatus);
        expect(read).not.toHaveBeenCalled();
        await instance.onTick();
        expect(instance.lastStatus).toBe('generating');
        expect(instance.getState().status).toBe('generating');
        observation = { ...observation, codexOpenTurn: undefined, turnTerminalMarkers: [{ ...observation.codexOpenTurn,
            receivedAt: T + 500, outcome: 'completed', summary: 'Synthetic final' }] };
        if (release === 'pending') observation = { ...observation, stale: true, unavailableReason: 'native_history_loading' };
        if (release === 'unavailable') observation = null;
        vi.advanceTimersByTime(5_050);
        expect(instance.getState().status).toBe(instance.lastStatus);
        await instance.onTick();
        expect(instance.lastStatus).toBe('idle'); expect(instance.getState().status).toBe('idle');
        vi.clearAllTimers();
    });
    it('does not probe the Codex RPC wire path', () => {
        const instance: any = Object.create(CliProviderInstance.prototype);
        instance.type = 'codex-cli'; instance.adapter = { getInteractivePromptTransport: () => 'wire' };
        instance.readExternalCompletionMessages = vi.fn();
        expect(instance.preserveCodexGeneratingOnIdle(true)).toBe(false);
        expect(instance.readExternalCompletionMessages).not.toHaveBeenCalled();
    });
});
