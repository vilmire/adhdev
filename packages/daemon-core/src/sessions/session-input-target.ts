/**
 * session-input-target — the daemon's live objects as a `SessionInputTarget`.
 *
 * Wiring-unification D2. A session's input surface is split across two objects
 * the daemon already holds: the CLI adapter (driver FIFO, split write, stop key,
 * drain reservation) and the provider instance (transcript ack; the ACP
 * transport). This module projects the pair into the one structural target
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

/** The adapter surface the projection reads (the spec adapter satisfies it; so does the ACP shim). */
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
    _acpInstance?: unknown;
}

/** The instance surface the projection reads. */
export interface SessionInputInstanceLike {
    category?: string;
    onEvent?(event: string, data?: unknown): unknown;
    recordAcknowledgedUserInput?(input: InputEnvelope | string, sourceMessageId?: string): void;
}

/** hermes-cli can paint a prompt before it accepts input; its first send waits this long while `starting`. */
export const HERMES_CLI_STARTING_SEND_SETTLE_MS = 2_000;

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
 * pair has no input surface at all. An ACP instance (or the ACP adapter shim)
 * becomes an ACP target — the agent owns its own busy refusal.
 */
export function buildSessionInputTarget(args: {
    adapter?: SessionInputAdapterLike | null;
    instance?: SessionInputInstanceLike | null;
    provider?: Pick<ProviderModule, 'name' | 'type' | 'capabilities' | 'category'> | null;
    sleep?: (ms: number) => Promise<void>;
}): SessionInputTarget | null {
    const { adapter, instance, provider } = args;
    const acpInstance = (instance?.category === 'acp' ? instance : (adapter?._acpInstance as SessionInputInstanceLike | undefined)) ?? null;
    if (acpInstance && typeof acpInstance.onEvent === 'function') {
        return {
            label: adapter?.cliType || provider?.type,
            getStatus: adapter?.getStatus ? (o) => adapter.getStatus!(o) : undefined,
            // Never reached: the service routes an ACP target through sendAcp.
            sendMessage: async () => ({ status: 'delivered' as const }),
            // Validation only (declared input support); the envelope itself goes to sendAcp.
            buildBody(input) {
                const envelope = toInputEnvelope(input);
                assertProviderSupportsDeclaredInput(provider, envelope);
                return envelope.parts.length > 0 || envelope.textFallback.trim() ? { text: envelope.textFallback || ' ' } : null;
            },
            async sendAcp(input) {
                const outcome = await acpInstance.onEvent!('send_message', { input: toInputEnvelope(input) }) as
                    { success?: boolean; error?: string; status?: string } | undefined;
                return { success: outcome?.success === true, ...(outcome?.error ? { error: outcome.error } : {}), ...(outcome?.status ? { status: outcome.status } : {}) };
            },
        };
    }
    if (!adapter) return null;
    const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const target: SessionInputTarget = {
        label: adapter.cliType,
        getStatus: (o) => adapter.getStatus?.(o),
        buildBody: (input) => buildCliInputBody(provider, input),
        async beforeWrite() {
            if (adapter.cliType !== 'hermes-cli') return;
            let status: string | undefined;
            try { status = adapter.getStatus?.()?.status; } catch { status = undefined; }
            if (status === 'starting') await sleep(HERMES_CLI_STARTING_SEND_SETTLE_MS);
        },
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
