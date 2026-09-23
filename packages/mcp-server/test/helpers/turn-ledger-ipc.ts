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
    setActiveTurnLedgerForIpc,
    turnLedgerIpcHandlers,
} from '@adhdev/daemon-core';

export function armTestTurnLedger(selfDaemonId = 'daemon-coordinator'): { dispose(): void } {
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId, publisher: null });
    setActiveTurnLedgerForIpc(ledger);
    return { dispose: () => setActiveTurnLedgerForIpc(null) };
}

/**
 * Close every open attempt the armed ledger holds (bookkeeping cancel, no
 * session side effect). The ledger allows ≤1 open attempt per SESSION across
 * meshes and the store file outlives a test, so fixtures that reuse a session
 * id call this between cases. Synchronous (ledger.observe is).
 */
export function closeOpenTestAttempts(): void {
    const ledger = getActiveTurnLedger();
    if (!ledger) return;
    for (const attempt of ledger.store.listOpenAttempts()) {
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
    }
}

/** True for a command the helper answers (every daemon-side turn IPC command). */
export function isTurnIpcCommand(command: string): boolean {
    return Object.prototype.hasOwnProperty.call(turnLedgerIpcHandlers, command);
}

/** Answer one turn IPC command through the real daemon handler. */
export async function answerTurnIpc(command: string, args: Record<string, unknown> = {}): Promise<any> {
    const handler = (turnLedgerIpcHandlers as Record<string, (ctx: unknown, args: unknown) => Promise<unknown>>)[command];
    return handler({ deps: { statusInstanceId: 'daemon-coordinator' } }, args);
}
