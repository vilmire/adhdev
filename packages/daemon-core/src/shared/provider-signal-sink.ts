/**
 * PROVIDER-SIGNAL seam — a producer-neutral bridge between spec-declared screen
 * signal detection and whoever wants to act on it.
 *
 * Exactly the same inversion, and for exactly the same reason, as
 * `session-termination-sink.ts` (read that module's header first; this one
 * follows its contract deliberately rather than inventing a second shape):
 *
 * The observation ("this CLI printed something a declared signal rule matched,
 * and here are the captured parameters") is produced in `providers/spec` — the
 * FSM driver is the only place that sees the rendered frame. The consumer is the
 * mesh coordinator notification path. But `providers/**` must not value-import
 * `mesh/**` — an enforced layering boundary (scripts/check-import-boundaries.mjs).
 *
 * So the provider layer PUBLISHES here and knows nothing about the mesh; the
 * mesh layer SUBSCRIBES from `boot/daemon-lifecycle.ts` and owns what — if
 * anything — to do with it. Arrow direction: providers -> shared <- mesh.
 *
 * Neutrality is the point: this module imports no layer, only the logger and the
 * detection type. Do not let it grow a mesh import.
 */

import type { SignalRuleKind } from '../providers/spec/signal-rules.js';
import { LOG } from '../logging/logger.js';

/**
 * A declared signal rule matched a rendered frame.
 *
 * Deliberately carries no mesh vocabulary (no meshId, no taskId, no coordinator
 * flag): the producer does not know whether this session is mesh-bound. That
 * resolution belongs to the subscriber, which owns the binding rules. Keeping
 * the payload mesh-free is what lets this seam serve a second consumer (a
 * dashboard surface, a webhook) later without a shape change.
 */
export interface ProviderSignalObservation {
    /** Owning session id (session registry / read-path targetSessionId). */
    sessionId: string;
    /** Provider type whose screen matched (e.g. 'claude', 'codex'). */
    providerType?: string;
    /** Working directory the session runs in. */
    workspace?: string;
    /** The spec rule that matched. Enum-like token, validated at compile time. */
    ruleId: string;
    /** Coarse class the consumer routes on. */
    kind: SignalRuleKind;
    /**
     * Captured parameters, already sanitized and length-capped by the detector
     * (see sanitizeSignalParamValue).
     *
     * ★ UNTRUSTED. These values are agent/provider-authored text that will reach
     * a coordinator LLM. A consumer must render them as QUOTED VALUES in a
     * fixed template — never concatenate them into an instruction, and never
     * forward them as a bare sentence. See mesh/mesh-signal-bridge.ts for the
     * reference rendering.
     */
    params: Record<string, string>;
    /** Wall-clock ms the frame was evaluated. */
    detectedAt: number;
    /**
     * Runtime settings as mirrored onto the adapter. The subscriber reads the
     * mesh binding stamps out of this; the producer forwards them opaquely —
     * same contract as SessionTerminationObservation.runtimeSettings.
     */
    runtimeSettings: Record<string, unknown>;
}

/**
 * May return a promise (the mesh subscriber queues a durable pending event).
 * The publisher never awaits it, but returning it lets a test drive the seam to
 * completion deterministically.
 */
export type ProviderSignalObserver = (
    observation: ProviderSignalObservation,
) => void | Promise<void>;

let observer: ProviderSignalObserver | null = null;

/** Wire the observer at daemon boot; pass null to disable (tests, no mesh). */
export function configureProviderSignalObserver(next: ProviderSignalObserver | null): void {
    observer = next;
}

/**
 * Publish a signal observation.
 *
 * Best-effort by construction, and load-bearing rather than lazy: this runs on
 * the PTY screen-evaluation path, so a throwing subscriber must never propagate
 * back and turn an advisory signal into a broken status engine. With no observer
 * wired this is a silent no-op — the correct behavior for a non-mesh daemon.
 */
export function publishProviderSignal(observation: ProviderSignalObservation): void {
    if (!observer) return;
    const warn = (e: any) => LOG.warn(
        'ProviderSignal',
        `Signal observer failed for ${observation.sessionId} (${observation.ruleId}): ${e?.message || e}`,
    );
    try {
        // Catch the async rejection too: a rejecting observer would otherwise
        // surface as an unhandled rejection on the screen-evaluation path.
        void Promise.resolve(observer(observation)).catch(warn);
    } catch (e: any) {
        warn(e);
    }
}
