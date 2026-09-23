import { afterEach, describe, expect, it } from 'vitest';
import { transcriptTransportReportHandlers } from '../../../src/commands/low-family/transcript-transport-report.js';
import type { LowFamilyContext } from '../../../src/commands/low-family/types.js';
import {
    __resetTranscriptTransportSelectionForTests,
    transcriptTransportSelectionCounters,
} from '../../../src/seqscribe/transcript-transport-selection.js';

function ctx(): LowFamilyContext {
    return { deps: {} as LowFamilyContext['deps'] };
}

afterEach(() => {
    __resetTranscriptTransportSelectionForTests();
});

describe('report_transcript_transport', () => {
    it('records a replica selection', async () => {
        const result = await transcriptTransportReportHandlers.report_transcript_transport!(ctx(), {
            selection: 'replica',
        });
        expect(result).toEqual({ success: true });
        expect(transcriptTransportSelectionCounters()).toEqual({ replicaSelected: 1, legacySelected: 0 });
    });

    it('records a legacy selection', async () => {
        const result = await transcriptTransportReportHandlers.report_transcript_transport!(ctx(), {
            selection: 'legacy',
        });
        expect(result).toEqual({ success: true });
        expect(transcriptTransportSelectionCounters()).toEqual({ replicaSelected: 0, legacySelected: 1 });
    });

    it('rejects a missing selection without incrementing any counter', async () => {
        const result = await transcriptTransportReportHandlers.report_transcript_transport!(ctx(), {});
        expect(result).toEqual({ success: false, error: "selection must be 'replica' or 'legacy'" });
        expect(transcriptTransportSelectionCounters()).toEqual({ replicaSelected: 0, legacySelected: 0 });
    });

    it('★ content boundary: an arbitrary string is rejected, not counted under a fabricated key', async () => {
        const result = await transcriptTransportReportHandlers.report_transcript_transport!(ctx(), {
            selection: 'some free text an attacker or a bug might send',
        });
        expect(result).toEqual({ success: false, error: "selection must be 'replica' or 'legacy'" });
        expect(transcriptTransportSelectionCounters()).toEqual({ replicaSelected: 0, legacySelected: 0 });
    });

    it('rejects a non-string selection (number, object)', async () => {
        expect(
            await transcriptTransportReportHandlers.report_transcript_transport!(ctx(), { selection: 1 }),
        ).toEqual({ success: false, error: "selection must be 'replica' or 'legacy'" });
        expect(
            await transcriptTransportReportHandlers.report_transcript_transport!(ctx(), {
                selection: { replica: true },
            }),
        ).toEqual({ success: false, error: "selection must be 'replica' or 'legacy'" });
    });
});
