import { describe, it, expect } from 'vitest';
import { captureCompletionIdentity, boundCompletionMarker } from '../../../src/providers/completion/native-completion-binding.js';
const T = Date.now() - 1_000;
function rig() {
    const host: any = { instanceId: 's', generatingStartedAt: T + 2, lastAcknowledgedUserInputAt: T,
        lastAcknowledgedInputDigest: 'digest', currentAttemptRef: () => ({ attemptId: 'a', generation: 1 }), completingTurnTaskId: () => 'task',
        lastNativeTurnTerminalMarkers: [{ nativeSessionId: 'native', turnId: 'turn', startedAt: T + 1, inputAt: T + 1,
            inputDigest: 'digest', receivedAt: T + 3, outcome: 'completed', summary: 'Native final' }] };
    const pending: any = { turnStartedAt: T + 2, taskId: 'task' };
    captureCompletionIdentity(host, pending);
    return { host, pending };
}
describe('late native binding retains the original attempt and ACK', () => {
    it('binds eventual verified native identity and replays the same marker', () => {
        const { host, pending } = rig(); expect(boundCompletionMarker(host, pending)).toBeNull();
        host.providerSessionId = 'native';
        expect(boundCompletionMarker(host, pending)?.summary).toBe('Native final');
        expect(boundCompletionMarker(host, pending)?.turnId).toBe('turn');
    });
    it.each(['input', 'attempt', 'turn', 'session'])('rejects a stale final after %s changes', change => {
        const { host, pending } = rig(); host.providerSessionId = 'native';
        if (change === 'input') host.lastAcknowledgedInputDigest = 'new';
        if (change === 'attempt') host.currentAttemptRef = () => ({ attemptId: 'b', generation: 2 });
        if (change === 'turn') host.generatingStartedAt++;
        if (change === 'session') host.providerSessionId = 'other';
        expect(boundCompletionMarker(host, pending)).toBeNull();
    });
});
