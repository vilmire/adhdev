/**
 * session-input-target — the daemon's live objects as a `SessionInputTarget`.
 *
 * Wiring-unification D2. A session's input surface is split across two objects
 * the daemon already holds: the CLI adapter (driver FIFO, split write, stop key,
 * drain reservation) and the provider instance (transcript ack). This module projects the pair into the one structural target
 * `SessionInputService.submit()` drives, so the service never imports a
 * concrete adapter/instance class and every origin gets the same projection.
 *
 * It also owns the ONE input → driver-body build (previously repeated by the
 * dashboard funnel, the mesh funnel and `CliProviderInstance.onEvent`):
 * a text-only envelope is written as its `textFallback` verbatim; a structured
 * one is checked against the provider's DECLARED input support, its images are
 * materialized to temp files, and the body is flagged for the provider's
 * bracketed-paste channel.
 */

import type { OutboundMessage } from '@adhdev/mesh-shared';
import { normalizeInputEnvelope, type InputEnvelope, type ProviderModule } from '../providers/contracts.js';
import { assertProviderSupportsDeclaredInput, assertTextOnlyInput } from '../providers/provider-input-support.js';
import { buildCliStructuredInputPrompt } from '../providers/cli-provider-input-prompt.js';
import { shouldUseBracketedPasteForEnvelope } from '../providers/cli-provider-bracketed-paste.js';
import type { ClaimedSessionInput, SessionInputBody, SessionInputTarget } from './session-input-service.js';

/** The adapter surface the projection reads (the spec adapter satisfies it). */
export interface SessionInputAdapterLike {
    cliType: string;
    getStatus?(options?: { allowParse?: boolean }): { status?: string } | undefined;
    sendMessage(text: string, options?: { bracketedPaste?: boolean; messageId?: string }): Promise<{ status: 'queued'; position?: number } | { status: 'delivered' } | void>;
    sendMessageDuringGeneration?(text: string, bracketedPaste?: boolean): { accepted: boolean; reason?: string };
    interruptTurn?: SessionInputTarget['interruptTurn'];
    hasQueuedSend?(messageId: string): boolean;
    claimQueuedSend?(messageId: string): ClaimedSessionInput | null;
    restoreQueuedSend?(claimed: ClaimedSessionInput): void;
    reserveDrain?(ttlMs: number): void;
    releaseDrain?(): void;
}

/** The instance surface the projection reads. */
export interface SessionInputInstanceLike {
    recordAcknowledgedUserInput?(input: InputEnvelope | string, sourceMessageId?: string): void;
}

export function toInputEnvelope(input: OutboundMessage['input']): InputEnvelope {
    return normalizeInputEnvelope({ input });
}

/**
 * Envelope → driver body. Throws (with the provider-named capability message)
 * when the provider cannot take the input — the service turns that into an
 * `unsupported_input` refusal.
 */
export function buildCliInputBody(
    provider: Pick<ProviderModule, 'name' | 'type' | 'capabilities'> | null | undefined,
    input: OutboundMessage['input'],
): SessionInputBody | null {
    const envelope = toInputEnvelope(input);
    const structured = envelope.parts.some((part) => part.type !== 'text');
    if (!structured) {
        assertTextOnlyInput(provider, envelope);
        return envelope.textFallback ? { text: envelope.textFallback } : null;
    }
    assertProviderSupportsDeclaredInput(provider, envelope);
    const text = buildCliStructuredInputPrompt(envelope);
    if (!text) return null;
    return { text, ...(shouldUseBracketedPasteForEnvelope(envelope) ? { bracketedPaste: true } : {}) };
}

/**
 * Project an adapter/instance pair into a `SessionInputTarget`. `null` when the
 * pair has no input surface at all.
 */
export function buildSessionInputTarget(args: {
    adapter?: SessionInputAdapterLike | null;
    instance?: SessionInputInstanceLike | null;
    provider?: Pick<ProviderModule, 'name' | 'type' | 'capabilities' | 'category'> | null;
}): SessionInputTarget | null {
    const { adapter, instance, provider } = args;
    if (!adapter) return null;
    const target: SessionInputTarget = {
        label: adapter.cliType,
        getStatus: (o) => adapter.getStatus?.(o),
        buildBody: (input) => buildCliInputBody(provider, input),
        sendMessage: (text, options) => adapter.sendMessage(text, options),
    };
    if (typeof adapter.sendMessageDuringGeneration === 'function') target.sendMessageDuringGeneration = (t, b) => adapter.sendMessageDuringGeneration!(t, b);
    if (typeof adapter.interruptTurn === 'function') target.interruptTurn = () => adapter.interruptTurn!();
    if (typeof adapter.hasQueuedSend === 'function') target.hasQueuedSend = (id) => adapter.hasQueuedSend!(id);
    if (typeof adapter.claimQueuedSend === 'function') target.claimQueuedSend = (id) => adapter.claimQueuedSend!(id);
    if (typeof adapter.restoreQueuedSend === 'function') target.restoreQueuedSend = (c) => adapter.restoreQueuedSend!(c);
    if (typeof adapter.reserveDrain === 'function') target.reserveDrain = (ms) => adapter.reserveDrain!(ms);
    if (typeof adapter.releaseDrain === 'function') target.releaseDrain = () => adapter.releaseDrain!();
    if (instance && typeof instance.recordAcknowledgedUserInput === 'function') {
        target.recordAcknowledgedUserInput = (input, sourceMessageId) => instance.recordAcknowledgedUserInput!(toInputEnvelope(input), sourceMessageId);
    }
    return target;
}
