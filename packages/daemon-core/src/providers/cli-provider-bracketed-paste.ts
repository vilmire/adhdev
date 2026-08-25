import type { InputEnvelope } from './contracts.js';

/**
 * Determines whether a given input envelope contains image parts that require
 * routing through a POSIX bracketed-paste channel.
 *
 * Image-bearing envelopes: the prompt body holds materialized image
 * paths. Flag it so the driver can deliver the body through the
 * provider's declared paste channel (POSIX bracketed paste) instead
 * of a raw write — a raw write loses every image but the last on
 * claude-cli (heuristic-paste threshold + pipe chunking; see
 * fsm-driver's POSIX-IMAGE-PASTE note). Providers without the spec
 * opt-in keep the legacy raw write.
 */
export function shouldUseBracketedPasteForEnvelope(input: InputEnvelope): boolean {
    return input.parts.some((part) => part.type === 'image');
}

/**
 * Builds the options object for adapter.sendMessage().
 *
 * Note: the flag key is only present when true so the
 * text-only call shape stays byte-identical to before.
 */
export function buildAdapterSendOpts(force: boolean, bracketedPaste: boolean): { force?: boolean; bracketedPaste?: boolean } {
    return {
        ...(force ? { force: true } : {}),
        ...(bracketedPaste ? { bracketedPaste: true } : {}),
    };
}
