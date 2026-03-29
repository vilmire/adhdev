/**
 * ptyBus — Simple event bus for PTY output.
 *
 * Dashboard writes PTY data to the bus.
 * CliTerminalPane subscribes to the bus and writes to xterm.
 * This decouples Dashboard (which has p2pManager access) from CliTerminalPane (web-core).
 */

type PtyListener = (cliId: string, data: string) => void;

const listeners = new Set<PtyListener>();

export const ptyBus = {
    /** Emit PTY data (called by Dashboard's writePty) */
    emit(cliId: string, data: string): void {
        for (const fn of listeners) {
            fn(cliId, data);
        }
    },

    /** Subscribe to PTY data (called by CliTerminalPane) */
    on(fn: PtyListener): () => void {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    },
};
