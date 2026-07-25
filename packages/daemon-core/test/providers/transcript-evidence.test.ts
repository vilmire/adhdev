import { describe, expect, it } from 'vitest';
import {
    resolveTranscriptAuthorityProfile,
    type TranscriptAuthorityInput,
} from '../../src/providers/transcript-evidence.js';
import type { ProviderCanonicalHistoryConfig } from '../../src/providers/contracts.js';

const canonicalNative = { format: 'jsonl' } as unknown as ProviderCanonicalHistoryConfig;
const disabledNative = { mode: 'disabled' } as unknown as ProviderCanonicalHistoryConfig;
const mirrorNative = { mode: 'materialized-mirror' } as unknown as ProviderCanonicalHistoryConfig;
const bufferTui = { transcriptPty: { scope: 'buffer' } } as Record<string, unknown>;

describe('resolveTranscriptAuthorityProfile — provider class matrix', () => {
    it('claude-cli shape: native-source + write-lag immediate', () => {
        const profile = resolveTranscriptAuthorityProfile({
            transcriptAuthority: 'provider',
            nativeHistory: canonicalNative,
        });
        expect(profile).toMatchObject({
            class: 'native-source',
            timing: 'immediate',
            providerOwnsTranscript: true,
            emitsPtyTurnEvents: true,
        });
        expect(profile.nativeHistory).toBe(canonicalNative);
    });

    it('codex/kimi shape: native-source + floor, PTY turn events unreliable', () => {
        const profile = resolveTranscriptAuthorityProfile({
            transcriptAuthority: 'provider',
            nativeHistory: canonicalNative,
            requiresFinalAssistantBeforeIdle: true,
        });
        expect(profile).toMatchObject({
            class: 'native-source',
            timing: 'floor',
            providerOwnsTranscript: true,
            emitsPtyTurnEvents: false,
        });
    });

    it('antigravity shape: native-source + hold, hold wins over floor', () => {
        const profile = resolveTranscriptAuthorityProfile({
            transcriptAuthority: 'provider',
            nativeHistory: canonicalNative,
            requiresFinalAssistantBeforeIdle: true,
            holdCompletionForTranscript: true,
        });
        expect(profile).toMatchObject({
            class: 'native-source',
            timing: 'hold',
            emitsPtyTurnEvents: false,
        });
    });

    it('pure-PTY shape: no authority, no native history, buffer-scope transcript', () => {
        const profile = resolveTranscriptAuthorityProfile({ tui: bufferTui });
        expect(profile).toMatchObject({
            class: 'pure-pty',
            timing: 'immediate',
            providerOwnsTranscript: false,
            emitsPtyTurnEvents: false,
        });
        expect(profile.nativeHistory).toBeUndefined();
    });

    it('daemon-owned default: plain provider with none of the markers', () => {
        expect(resolveTranscriptAuthorityProfile({})).toMatchObject({
            class: 'daemon-owned',
            timing: 'immediate',
            providerOwnsTranscript: false,
            emitsPtyTurnEvents: true,
        });
    });

    it('null/undefined provider resolves to the conservative daemon-owned default', () => {
        for (const input of [null, undefined]) {
            expect(resolveTranscriptAuthorityProfile(input)).toEqual({
                class: 'daemon-owned',
                timing: 'immediate',
                providerOwnsTranscript: false,
                emitsPtyTurnEvents: true,
            });
        }
    });

    it('disabled / materialized-mirror native history is NOT native-source', () => {
        // Falls through to pure-pty when the buffer-scope shape also matches…
        expect(resolveTranscriptAuthorityProfile({ nativeHistory: disabledNative, tui: bufferTui }).class)
            .toBe('daemon-owned'); // nativeHistory is truthy ⇒ isPurePtyTranscriptProvider also rejects
        expect(resolveTranscriptAuthorityProfile({ nativeHistory: mirrorNative }).class).toBe('daemon-owned');
        expect(resolveTranscriptAuthorityProfile({ nativeHistory: disabledNative }).nativeHistory).toBeUndefined();
    });

    it('provider-owned transcript without native history stays out of native-source', () => {
        const profile = resolveTranscriptAuthorityProfile({ transcriptAuthority: 'provider' });
        expect(profile.class).toBe('daemon-owned');
        expect(profile.providerOwnsTranscript).toBe(true);
    });

    it('exhaustive flag combinations never produce an inconsistent profile', () => {
        const nativeOptions = [undefined, canonicalNative, disabledNative] as const;
        const boolOptions = [undefined, true] as const;
        const tuiOptions = [undefined, bufferTui] as const;
        const authorityOptions = [undefined, 'provider', 'daemon'] as const;
        for (const nativeHistory of nativeOptions) {
            for (const requiresFinalAssistantBeforeIdle of boolOptions) {
                for (const holdCompletionForTranscript of boolOptions) {
                    for (const tui of tuiOptions) {
                        for (const transcriptAuthority of authorityOptions) {
                            const input: TranscriptAuthorityInput = {
                                transcriptAuthority,
                                nativeHistory,
                                requiresFinalAssistantBeforeIdle,
                                holdCompletionForTranscript,
                                tui,
                            };
                            const profile = resolveTranscriptAuthorityProfile(input);
                            // Timing precedence: hold > floor > immediate.
                            if (holdCompletionForTranscript) expect(profile.timing).toBe('hold');
                            else if (requiresFinalAssistantBeforeIdle) expect(profile.timing).toBe('floor');
                            else expect(profile.timing).toBe('immediate');
                            // Class is single-valued and consistent with its inputs.
                            if (profile.class === 'native-source') expect(nativeHistory).toBe(canonicalNative);
                            if (profile.class === 'pure-pty') {
                                expect(transcriptAuthority).not.toBe('provider');
                                expect(nativeHistory).toBeUndefined();
                                expect(tui).toBe(bufferTui);
                            }
                            // Turn-event reliability: only daemon-owned or write-lag native.
                            expect(profile.emitsPtyTurnEvents).toBe(
                                profile.class === 'daemon-owned'
                                || (profile.class === 'native-source' && profile.timing === 'immediate'),
                            );
                            // nativeHistory is surfaced iff the class is native-source.
                            expect(profile.nativeHistory !== undefined).toBe(profile.class === 'native-source');
                        }
                    }
                }
            }
        }
    });
});
