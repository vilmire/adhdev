/**
 * The `send_message` provider event of a CLI provider instance: normalize the
 * input envelope, build the CLI prompt, apply the modal fail-closed hold, and
 * hand the body to the adapter's send guard.
 *
 * Split out of cli-provider-instance.ts (file-size gate).
 */
import { buildAdapterSendOpts, shouldUseBracketedPasteForEnvelope } from './cli-provider-bracketed-paste.js';
import { buildCliStructuredInputPrompt } from './cli-provider-input-prompt.js';
import { normalizeInputEnvelope } from './contracts.js';
import { assertProviderSupportsDeclaredInput } from './provider-input-support.js';
import type { ProviderSendMessageResult } from './provider-instance.js';
import { LOG } from '../logging/logger.js';
import type { CliProviderInstance } from './cli-provider-instance.js';

/** The CliProviderInstance members the send path reads or calls (compiler-checked; no cast). */
export type SendEventHost = Pick<CliProviderInstance, 'adapter' | 'provider' | 'type' | 'isModalParked' | 'resolveModalParkStatus'>;

export function sendMessageEvent(host: SendEventHost, data: any): Promise<ProviderSendMessageResult> {
    const input = normalizeInputEnvelope(data);
    assertProviderSupportsDeclaredInput(host.provider, input);
    const promptText = buildCliStructuredInputPrompt(input);
    if (promptText) {
        // FORCE-NO-OP (2026-09-13): force:true does NOT bypass the busy/generating
        // send guard — SpecCliAdapter (the only live CLI engine since 48e5ed1a)
        // accepts and ignores it by design. The flag survives only because it selects
        // the MODAL fail-closed hold below; busy-coordinator immediacy now comes from
        // the mesh delivery modes (MeshDeliveryMode).
        const force = data?.force === true;
        const bracketedPaste = shouldUseBracketedPasteForEnvelope(input);
        // Modal guard (fail-closed, load-bearing). If the coordinator is parked on
        // a harness modal (claude-cli AskUserQuestion → waiting_choice, or a
        // tool-consent waiting_approval), a delivered body's keystrokes are eaten
        // by the modal's key handler and silently select a choice the user never
        // made (data corruption). Hold in that narrow window — the event stays
        // queued and the reconcile loop redelivers once the modal is resolved.
        // ONLY the two modal states hold; a merely-generating coordinator does not
        // (its body is parked in the adapter FIFO by the send guard, not injected).
        if (force && host.isModalParked()) {
            LOG.info('CLI', `[${host.type}] force send_message held — coordinator parked on modal (${host.resolveModalParkStatus()})`);
            return Promise.resolve({ success: false, error: 'send_message held by active modal' });
        }
        // Wiring-unification D2: a parked body is keyed by the caller's
        // `messageId` when it has one (claims are by id, never by text).
        // User-facing sends reach the session through
        // SessionInputService.submit, not this event; this remains for
        // event-only callers (mesh idle reminder).
        const sendOpts: { force?: boolean; bracketedPaste?: boolean; messageId?: string } =
            buildAdapterSendOpts(force, bracketedPaste);
        if (typeof data?.messageId === 'string' && data.messageId.trim()) sendOpts.messageId = data.messageId.trim();
        // Return the completion to callers that need an acknowledgement.
        // Resolve failures explicitly so legacy event-only callers can safely
        // ignore the promise without creating unhandled rejections.
        return host.adapter.sendMessage(promptText, sendOpts).then(
            (result): ProviderSendMessageResult => ({ success: true, status: result?.status || 'delivered' }),
            (e: any): ProviderSendMessageResult => {
                LOG.warn('CLI', `[${host.type}] send_message failed: ${e?.message || e}`);
                return { success: false, error: String(e?.message || e) };
            },
        );
    }
    return Promise.resolve({ success: false, error: 'No CLI input prompt to send' });
}
