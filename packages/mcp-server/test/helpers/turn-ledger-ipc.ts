import assert from 'node:assert/strict';
// Test helper (C-W8): an mcp-server test process has no booted daemon, but the
// direct-dispatch tools now open / deliver / close their `mesh_direct` attempt
// over the daemon's turn IPC (`turn_observe` / `turn_cancel`). This arms an
// in-process turn ledger on the SAME `@adhdev/daemon-core` instance the tools
// import (the dist barrel) and answers a fake transport's turn IPC through the
// real daemon-side handlers — so the attempt rows the tools' reads see are the
// ones a real daemon would have written.
import {
    createMeshRuntimeTurnLedger,
    getActiveTurnLedger,
    meshLedgerHandlers,
    setActiveTurnLedgerForIpc,
    turnLedgerIpcHandlers,
} from '@adhdev/daemon-core';

export function armTestTurnLedger(selfDaemonId = 'daemon-coordinator'): { dispose(): void } {
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId, publisher: null });
    setActiveTurnLedgerForIpc(ledger);
    return { dispose: () => setActiveTurnLedgerForIpc(null) };
}

/**
 * Close the owned synthetic attempts after each test, including the native
 * checkpoint required by the real stopping protocol. No real session exists. The ledger allows ≤1 open attempt per SESSION across
 * meshes and the store file outlives a test, so fixtures that reuse a session
 * id call this between cases. Await this before releasing the active ledger; a cancel alone retains the writer.
 */
export async function closeOpenTestAttempts(): Promise<void> {
    const ledger = getActiveTurnLedger();
    if (!ledger) return;
    for (const attempt of ledger.store.listOpenAttempts({ ownerDaemonId: ledger.selfDaemonId })) {
        ledger.observe({
            eventId: `test-close:${attempt.attemptId}:g${attempt.generation}`,
            at: Date.now(),
            source: 'intentional_cleanup',
            sessionId: attempt.sessionId,
            observedBy: ledger.selfDaemonId,
            attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
            kind: 'cancel',
            reason: 'intentional_cleanup',
        });
        assert.equal(ledger.getAttempt(attempt.attemptId)?.state, 'stopping');
        assert.equal(ledger.getAttempt(attempt.attemptId)?.terminal, null);
    }
    // Explicit fixture-only native acknowledgement. The real receipt verifier
    // still checks the complete stop request tuple before releasing authority.
    const checkpoint = createMeshRuntimeTurnLedger({ selfDaemonId: ledger.selfDaemonId, publisher: null,
        ports: { cancelDispatch: request => ({ ...request, success: true, quiescent: true, incarnation: 'mcp-owned-fixture-native' }) } });
    await checkpoint.resumeStoppingWriters();
    assert.equal(ledger.store.listOpenAttempts({ ownerDaemonId: ledger.selfDaemonId }).length, 0);
}

/** True for a command the helper answers (every daemon-side turn IPC command plus list_mesh_notes). */
export function isTurnIpcCommand(command: string): boolean {
    return Object.prototype.hasOwnProperty.call(turnLedgerIpcHandlers, command)
        || command === 'list_mesh_notes';
}

/** Answer one turn IPC command through the real daemon handler. */
export async function answerTurnIpc(command: string, args: Record<string, unknown> = {}): Promise<any> {
    const handler = (turnLedgerIpcHandlers as Record<string, (ctx: unknown, args: unknown) => Promise<unknown>>)[command]
        ?? (command === 'list_mesh_notes' ? (meshLedgerHandlers as Record<string, (ctx: unknown, args: unknown) => Promise<unknown>>).list_mesh_notes : undefined);
    if (handler) return handler({ deps: { statusInstanceId: 'daemon-coordinator' } }, args);
    throw new Error(`answerTurnIpc: no handler registered for '${command}'`);
}
