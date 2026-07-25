/**
 * Transcript authority profile — the single place that classifies a provider
 * for completion/stall/redrive decisions.
 *
 * Historically five predicates coexisted (transcriptAuthority, nativeHistory
 * presence, adapter chatMessagesOwnedExternally, isPurePtyTranscriptProvider,
 * and the two completion-timing flags) and every judgment site combined a
 * different subset — each recurring "pure-PTY gate excludes native-source"
 * defect (kimi reconcile, antigravity tail/guard, codex floor, STARTED
 * redrive) was an instance of a site enumerating only some classes. This
 * module makes the enumeration itself the shared artifact: sites consume a
 * profile, never the raw predicates.
 *
 * Design: docs/design/2026-07-25-transcript-authority-unification.md (root
 * repo). This file is Phase P0 (layer A — pure, synchronous classification).
 * Layer B (the evidence-query choke point) lands in later phases.
 *
 * Rule for NEW code: call resolveTranscriptAuthorityProfile() — do not call
 * isPurePtyTranscriptProvider / isNativeSourceCanonicalHistory or read the
 * timing flags directly (annotate `// authority-ok: <why>` where a raw read
 * is genuinely about something other than completion classification).
 */

import type { ProviderCanonicalHistoryConfig } from './contracts.js';
import { isPurePtyTranscriptProvider } from '../cli-adapters/provider-cli-shared.js';
import { isNativeSourceCanonicalHistory } from '../config/chat-history.js';

/** Where the authoritative transcript for completion evidence lives. */
export type TranscriptClass = 'native-source' | 'pure-pty' | 'daemon-owned';

/**
 * When a completion may be emitted relative to the PTY idle verdict:
 *  - 'hold'      — idle holds for the native transcript to land (antigravity).
 *  - 'floor'     — idle without a final assistant holds under the CANON-C
 *                  min-elapsed floor (codex / kimi / cursor / opencode).
 *  - 'immediate' — emit immediately; a write-lag native source upgrades the
 *                  weak emit on reconcile (claude), daemon-owned emits plainly.
 */
export type CompletionTiming = 'hold' | 'floor' | 'immediate';

export interface TranscriptAuthorityProfile {
    class: TranscriptClass;
    timing: CompletionTiming;
    /** transcriptAuthority === 'provider' — provider parser output is canonical. */
    providerOwnsTranscript: boolean;
    /**
     * False ⇒ this class may run whole turns without PTY generating_started /
     * generating_completed events, so the ABSENCE of a turn-start event must
     * never be read as "dispatch not consumed" (the STARTED-redrive rule,
     * generalized). True only where PTY turn events are reliable.
     */
    emitsPtyTurnEvents: boolean;
    /** The provider's native history config when the class is native-source. */
    nativeHistory?: ProviderCanonicalHistoryConfig;
}

/**
 * Structural input — matches how judgment sites actually hold providers
 * (CliProviderModule / ProviderModule / nullable this.provider). Null or
 * undefined resolves to the conservative daemon-owned/immediate default,
 * matching the established null-provider ⇒ not-pure-PTY contract.
 */
export interface TranscriptAuthorityInput {
    transcriptAuthority?: 'provider' | 'daemon';
    nativeHistory?: ProviderCanonicalHistoryConfig;
    tui?: Record<string, unknown>;
    requiresFinalAssistantBeforeIdle?: boolean;
    holdCompletionForTranscript?: boolean;
}

export function resolveTranscriptAuthorityProfile(
    provider: TranscriptAuthorityInput | null | undefined,
): TranscriptAuthorityProfile {
    if (!provider) {
        return { class: 'daemon-owned', timing: 'immediate', providerOwnsTranscript: false, emitsPtyTurnEvents: true };
    }

    const nativeSource = isNativeSourceCanonicalHistory(provider.nativeHistory);
    const transcriptClass: TranscriptClass = nativeSource
        ? 'native-source'
        : isPurePtyTranscriptProvider(provider)
            ? 'pure-pty'
            : 'daemon-owned';

    const timing: CompletionTiming = provider.holdCompletionForTranscript === true
        ? 'hold'
        : provider.requiresFinalAssistantBeforeIdle === true
            ? 'floor'
            : 'immediate';

    // PTY turn events are unreliable for (a) pure-PTY (turns collapse
    // idle→idle; the parser, not the PTY event stream, notices the turn) and
    // (b) native-source classes that hold/floor precisely because their turn
    // activity lives in the native transcript rather than the PTY.
    const emitsPtyTurnEvents = transcriptClass === 'daemon-owned'
        || (transcriptClass === 'native-source' && timing === 'immediate');

    return {
        class: transcriptClass,
        timing,
        providerOwnsTranscript: provider.transcriptAuthority === 'provider',
        emitsPtyTurnEvents,
        ...(nativeSource && provider.nativeHistory ? { nativeHistory: provider.nativeHistory } : {}),
    };
}
