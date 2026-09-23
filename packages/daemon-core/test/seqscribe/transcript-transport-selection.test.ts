import { afterEach, describe, expect, it } from 'vitest';
import {
    __resetTranscriptTransportSelectionForTests,
    recordTranscriptTransportSelection,
    transcriptTransportSelectionCounters,
} from '../../src/seqscribe/transcript-transport-selection.js';

afterEach(() => {
    __resetTranscriptTransportSelectionForTests();
});

describe('transcript transport selection counters', () => {
    it('starts at zero', () => {
        expect(transcriptTransportSelectionCounters()).toEqual({ replicaSelected: 0, legacySelected: 0 });
    });

    it('counts replica selections independently from legacy', () => {
        recordTranscriptTransportSelection('replica');
        recordTranscriptTransportSelection('replica');
        recordTranscriptTransportSelection('legacy');

        expect(transcriptTransportSelectionCounters()).toEqual({ replicaSelected: 2, legacySelected: 1 });
    });

    it('reset clears both counters', () => {
        recordTranscriptTransportSelection('replica');
        recordTranscriptTransportSelection('legacy');
        __resetTranscriptTransportSelectionForTests();
        expect(transcriptTransportSelectionCounters()).toEqual({ replicaSelected: 0, legacySelected: 0 });
    });

    it('returns a copy, not a live reference', () => {
        const snapshot = transcriptTransportSelectionCounters();
        recordTranscriptTransportSelection('replica');
        expect(snapshot.replicaSelected).toBe(0);
    });
});
