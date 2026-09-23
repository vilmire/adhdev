/**
 * SessionOutputFanout — where CLI PTY output bytes leave the session core
 * (wiring-unification B5, design §B1 "Output bytes stay off the bus").
 *
 * Output is too high-volume for the lifecycle bus, so it gets its own single
 * path: `DaemonCliManager` writes every PTY chunk here (it is handed to the
 * cli-manager as its `getP2p()` broadcaster), and the host runtime attaches
 * ONE sink that applies the shared policy — CLI-only gate, chat-output
 * activity (which also drives the transcript replica's throttled dirty
 * trigger), then the transport send. Before B5 each host wrote that policy
 * into its own `getP2p` lambda and the two copies had drifted (standalone
 * skipped the activity mark whenever no dashboard was connected).
 *
 * A chunk that arrives before a sink is attached (restore replays during
 * boot, before the host runtime exists) is dropped — exactly what both hosts
 * did before, since neither transport was up yet.
 */

export type SessionOutputSink = (sessionId: string, data: string) => void;

export class SessionOutputFanout {
    private sink: SessionOutputSink | null = null;

    /** Attach the one sink; returns the detach. A second attach replaces the first. */
    attach(sink: SessionOutputSink): () => void {
        this.sink = sink;
        return () => {
            if (this.sink === sink) this.sink = null;
        };
    }

    get attached(): boolean {
        return this.sink !== null;
    }

    /** The cli-manager's `getP2p().broadcastSessionOutput` contract. */
    broadcastSessionOutput(sessionId: string, data: string): void {
        this.sink?.(sessionId, data);
    }
}
