/**
 * Minimal CLI adapter driven by a single spec.json.
 *
 * Replaces the per-provider scripts/v1/*.js + cli-state-engine.ts dance
 * for providers that ship a spec.json. Each PTY data chunk triggers a
 * single re-evaluation of the latest screen against the spec; the
 * verdict is the source of truth — no separately-tracked activeModal
 * mirror, no cooldown, no debounce.
 *
 * Stateless wrt parser logic. The only state we keep is:
 *   - latest accumulated screen text (capped)
 *   - latest verdict we emitted (so we only notify on change)
 *
 * Consecutive same-shape decisions (write A then write B) are
 * distinguishable via the verdict's `signature` (built from the choice
 * text), so callers can reliably tell when one decision has been
 * resolved and a new one has taken its place.
 */
'use strict';

import { evaluateScreen, resolveChoiceKey, type CliSpec, type Verdict } from './evaluate.js';
import { createScreenSink, type ScreenSink } from './screen.js';
import type { PtyRuntimeTransport, PtyTransportFactory, PtySpawnOptions } from '../../cli-adapters/pty-transport.js';

export interface SpecAdapterEvents {
    onVerdict(verdict: Verdict): void;
    onExit(code: number | null): void;
}

export class SpecAdapter {
    private pty: PtyRuntimeTransport | null = null;
    private sink: ScreenSink | null = null;
    private lastSignature: string | null = null;
    private lastStatus: Verdict['status'] | null = null;

    constructor(
        private readonly spec: CliSpec,
        private readonly events: SpecAdapterEvents,
    ) {}

    spawn(factory: PtyTransportFactory, opts: PtySpawnOptions): void {
        const args = this.spec.spawn_args ?? [];
        this.sink = createScreenSink({ cols: opts.cols, rows: opts.rows });
        this.pty = factory.spawn(this.spec.binary, args, opts);
        this.pty.onData((chunk) => this.feed(chunk));
        this.pty.onExit((info) => {
            this.events.onExit(typeof info.exitCode === 'number' ? info.exitCode : null);
            this.sink?.dispose();
            this.sink = null;
        });
    }

    /** Send a user-typed message and submit it. */
    sendMessage(text: string): void {
        if (!this.pty) return;
        this.pty.write(text);
        this.pty.write(this.spec.send.submit);
    }

    /** Send the keystroke for a numbered choice from the latest decision. */
    sendChoice(choiceIndex: number): void {
        if (!this.pty) return;
        this.pty.write(resolveChoiceKey(this.spec, choiceIndex));
    }

    /** Hard kill. */
    kill(): void {
        try { this.pty?.kill?.(); } catch { /* ignore */ }
        this.pty = null;
        this.sink?.dispose();
        this.sink = null;
    }

    /** Most recent verdict the adapter would emit if evaluated now. */
    evaluate(): Verdict {
        const screen = this.sink?.snapshot() ?? '';
        return evaluateScreen(screen, this.spec);
    }

    private feed(chunk: string): void {
        this.sink?.write(chunk);
        const verdict = this.evaluate();
        // Notify on any change of status OR change of decision signature.
        // Same status with the same decision content is a no-op repaint;
        // same status with a different decision content is a brand-new
        // decision and must fire so the dashboard can re-prompt the user.
        const sig = verdict.status === 'decision_required' ? verdict.signature : null;
        if (verdict.status !== this.lastStatus || sig !== this.lastSignature) {
            this.lastStatus = verdict.status;
            this.lastSignature = sig;
            this.events.onVerdict(verdict);
        }
    }
}
