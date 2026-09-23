// ---------------------------------------------------------------------------
// turn-ledger/active-ledger — the process's active turn ledger (C-W8)
// ---------------------------------------------------------------------------
// ONE late-bound slot for the ledger boot constructed (`wireTurnLedger`): the
// turn IPC handlers (commands/low-family/turn-ledger-ipc.ts) and the few mesh/
// writers that must emit evidence from outside a component-scoped call (the
// queue-side direct-dispatch cancel) read it here. Null before boot binds it,
// after dispose, and in a process that never arms a ledger (the mcp-server —
// which reaches the daemon's ledger over IPC instead). A type-only leaf so
// mesh/ modules on the queue path can import it without an import cycle.
// ---------------------------------------------------------------------------

import type { TurnLedger } from './ledger.js';

let activeLedger: TurnLedger | null = null;

export function setActiveTurnLedger(ledger: TurnLedger | null): void {
    activeLedger = ledger;
}

export function getActiveTurnLedger(): TurnLedger | null {
    return activeLedger;
}
