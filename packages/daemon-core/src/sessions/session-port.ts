/**
 * SessionEventPort — the narrow emit surface a provider instance receives.
 *
 * Wiring-unification Phase B1 (docs/design/2026-09-23-wiring-unification.md §4 B1).
 *
 * Provider instances never see the bus: they get this port through
 * `InstanceContext.lifecycle`. The registry stays the only emitter of
 * `registered` / `binding` / `terminated`, so `exited` routes through
 * `registry.terminate(..., 'pty_exit', ...)` and never emits on its own — a PTY
 * exit racing an explicit stop or an auto-clean still yields exactly one
 * `terminated`.
 */

import type { SessionStatus } from '@adhdev/mesh-shared';
import type { SessionTermination } from '@adhdev/session-host-core';
import type { InteractivePrompt } from '../providers/types/interactive-prompt.js';
import type { SignalDetection } from '../providers/spec/signal-rules.js';
import type { SessionModalState } from '../providers/provider-instance.js';
import type { SessionLifecycleBus } from './lifecycle-bus.js';
import type { EnrichedProviderEvent, PromptTransport, StatusCause } from './lifecycle-events.js';
import type { SessionRegistry } from './registry.js';
import type { SessionLaunchRecord } from './launch-record.js';

export interface SessionSignalDetail {
    providerType?: string;
    workspace?: string;
    runtimeSettings: Readonly<Record<string, unknown>>;
    signal: SignalDetection;
}

export interface SessionEventPort {
    /**
     * A real status edge. `providerType` defaults to the registry entry's type.
     * `prev === next` is not an edge and is ignored.
     */
    status(sessionId: string, prev: SessionStatus, next: SessionStatus, cause: StatusCause, providerType?: string): void;
    modal(sessionId: string, modal: SessionModalState | null): void;
    prompt(sessionId: string, prompt: InteractivePrompt | null, transport: PromptTransport): void;
    signal(sessionId: string, detail: SessionSignalDetail): void;
    /** TRANSITIONAL (B -> C): the untyped provider event bag, delivered immediately. */
    providerEvent(sessionId: string, event: EnrichedProviderEvent): void;
    /** The PTY child exited. Routed to `registry.terminate(sessionId, 'pty_exit', …)`. */
    exited(sessionId: string, termination: SessionTermination | undefined, runtimeSettings: Readonly<Record<string, unknown>>): void;
    /**
     * Phase E: the session's launch record (the registry owns it). The one read
     * on this port — the instance manager stamps it onto collected provider
     * states so status builders can publish it over P2P.
     */
    launchRecord?(sessionId: string): Readonly<SessionLaunchRecord> | undefined;
}

export interface CreateSessionEventPortOptions {
    now?: () => number;
}

export function createSessionEventPort(
    bus: SessionLifecycleBus,
    registry: SessionRegistry,
    options: CreateSessionEventPortOptions = {},
): SessionEventPort {
    const now = options.now ?? Date.now;
    return {
        status(sessionId, prev, next, cause, providerType) {
            if (prev === next) return;
            bus.emit({
                kind: 'status',
                sessionId,
                at: now(),
                providerType: providerType ?? registry.get(sessionId)?.providerType ?? 'unknown',
                prev,
                next,
                cause,
            });
        },
        modal(sessionId, modal) {
            bus.emit({ kind: 'modal', sessionId, at: now(), modal });
        },
        prompt(sessionId, prompt, transport) {
            bus.emit({ kind: 'prompt', sessionId, at: now(), prompt, transport });
        },
        signal(sessionId, detail) {
            bus.emit({ kind: 'signal', sessionId, at: now(), ...detail });
        },
        providerEvent(sessionId, event) {
            bus.emit({ kind: 'provider_event', sessionId, at: now(), event });
        },
        exited(sessionId, termination, runtimeSettings) {
            registry.terminate(sessionId, 'pty_exit', { termination, runtimeSettings });
        },
        launchRecord(sessionId) {
            return registry.get(sessionId)?.launch;
        },
    };
}
