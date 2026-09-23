/**
 * provider-event-port — the provider-side half of the SessionEventPort.
 *
 * Wiring-unification Phase B2 (docs/design/2026-09-23-wiring-unification.md §4 B1
 * "Emit sites — the four detection points").
 *
 * Provider instances never see the lifecycle bus; they hold a nullable
 * `SessionEventPort` (B1, `sessions/session-port.ts`) and call it at the four
 * detection points:
 *
 *   - CLI FSM         completion/status-transition.ts  status/modal/prompt
 *   - IDE poll        ide-provider-instance.ts         status + immediate provider events
 *   - Extension poll  extension-provider-instance.ts   status + immediate provider events
 *   - ACP update      acp-provider-instance.ts         status + immediate provider events
 *
 * The port stays null until boot wires it (B4/B5), so every helper here is a
 * no-op without one. The per-instance `pendingEvents` buffer these helpers
 * used to also write (for the pre-B5 `onEvent`/collectAllStates() drain) is
 * gone (wiring-unification B residue cleanup) — the port is the only
 * delivery path now.
 *
 * This module owns only pure diff helpers and the guarded call wrappers; the
 * diff STATE (last fingerprints) lives on each instance.
 */

import { normalizeSessionStatus, type SessionStatus } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import type { SessionEventPort } from '../sessions/session-port.js';
import type { EnrichedProviderEvent, PromptTransport, StatusCause } from '../sessions/lifecycle-events.js';
import type { AdapterChangeCause } from '../cli-adapter-types.js';
import type { InteractivePrompt } from './types/interactive-prompt.js';
import type { SessionModalState } from './provider-instance.js';

export type { SessionEventPort };

// ─── Guarded port calls ───────────────────────────────────────────────────

function guard(what: string, sessionId: string, fn: () => void): void {
    try {
        fn();
    } catch (error) {
        // A port failure must never break the provider's own detection tick.
        LOG.warn('EventPort', `[EventPort] ${what} for ${sessionId} failed: ${(error as Error)?.message ?? error}`);
    }
}

/**
 * Emit one status edge. Raw provider spellings are normalized onto the
 * canonical `SessionStatus`; an unrecognised spelling or a no-op edge
 * (`prev === next` after normalization) emits nothing. Returns whether an edge
 * was emitted.
 */
export function emitStatusEdge(
    port: SessionEventPort | null | undefined,
    sessionId: string,
    prevRaw: unknown,
    nextRaw: unknown,
    cause: StatusCause,
    providerType?: string,
): boolean {
    if (!port || !sessionId) return false;
    const prev = normalizeSessionStatus(prevRaw);
    const next = normalizeSessionStatus(nextRaw);
    if (!prev || !next || prev === next) return false;
    guard('status', sessionId, () => port.status(sessionId, prev as SessionStatus, next as SessionStatus, cause, providerType));
    return true;
}

export function emitModal(
    port: SessionEventPort | null | undefined,
    sessionId: string,
    modal: SessionModalState | null,
): void {
    if (!port || !sessionId) return;
    guard('modal', sessionId, () => port.modal(sessionId, modal));
}

export function emitPrompt(
    port: SessionEventPort | null | undefined,
    sessionId: string,
    prompt: InteractivePrompt | null,
    transport: PromptTransport,
): void {
    if (!port || !sessionId) return;
    // Snapshot: the adapter mutates its held prompt in place (multiSelect upgrade),
    // so a subscriber that keeps the payload must not see it change underneath.
    const snapshot = prompt ? structuredClone(prompt) : null;
    guard('prompt', sessionId, () => port.prompt(sessionId, snapshot, snapshot ? transport : null));
}

/**
 * Forward an enriched provider event immediately. The only delivery path
 * since wiring-unification B5 — there is no per-instance buffer to also
 * write, so this simply guards the port call.
 */
export function forwardProviderEvent(
    port: SessionEventPort | null | undefined,
    sessionId: string,
    enriched: EnrichedProviderEvent,
): void {
    if (!port || !sessionId) return;
    guard('providerEvent', sessionId, () => port.providerEvent(sessionId, enriched));
}

// ─── Fingerprints ─────────────────────────────────────────────────────────

/**
 * Prompt identity for edge detection: promptId plus one multiSelect bit per
 * question. The Claude TUI upgrades `multiSelect` IN PLACE on the held prompt
 * (same object, same promptId), so the bits are the only way to see that
 * update; everything else a re-render touches (option text, focus) is
 * deliberately excluded so a repaint never re-emits.
 */
export function promptFingerprint(prompt: InteractivePrompt | null | undefined): string {
    if (!prompt || typeof prompt.promptId !== 'string') return '';
    const bits = Array.isArray(prompt.questions)
        ? prompt.questions.map((q) => (q?.multiSelect ? '1' : '0')).join('')
        : '';
    return `${prompt.promptId}:${bits}`;
}

/** Modal identity: message + button labels. '' means no modal. */
export function modalFingerprint(modal: { message?: unknown; buttons?: unknown } | null | undefined): string {
    if (!modal) return '';
    const message = typeof modal.message === 'string' ? modal.message : '';
    const buttons = Array.isArray(modal.buttons) ? modal.buttons.map((b) => String(b)).join('\u0001') : '';
    return `${message}\u0002${buttons}`;
}

// ─── CLI status cause ─────────────────────────────────────────────────────

/**
 * Why the CLI tick's status edge happened. The daemon-side overlays win
 * because they are what actually changed the reported status: the question
 * picker folds `waiting_approval` into `waiting_choice`, and the auto-approve
 * mask holds `generating`. Otherwise the adapter's own change cause decides;
 * prompt-only causes (and a tick with no adapter cause) are an FSM read.
 */
export function cliStatusCause(input: {
    questionPicker: boolean;
    autoApproveMasked: boolean;
    adapterCause?: AdapterChangeCause | null;
}): StatusCause {
    if (input.questionPicker) return 'question_picker';
    if (input.autoApproveMasked) return 'auto_approve_mask';
    if (input.adapterCause === 'pty_exit') return 'pty_exit';
    if (input.adapterCause === 'provider_failure') return 'provider_failure';
    return 'fsm_state';
}
