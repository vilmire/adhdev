/**
 * Shared fixtures for the keyed chat transcript tests (design 2026-09-28):
 * build observations, run frames through `KeyedChatSessionState`, and replay
 * the produced rows into a `KeyedTranscriptFolder` exactly as a SUB would
 * deliver them (payload JSON round-trip, contiguous seq).
 */

import { KeyedChatSessionState, type KeyedChatFrame } from '../../src/seqscribe/transcript-keyed-frame.js';
import type { KeyedChatRow } from '../../src/seqscribe/transcript-keyed-folder.js';
import type { TranscriptObservation, TranscriptObservationMessage } from '../../src/seqscribe/transcript-observation.js';

export const WRITER = 'adhdev-writer-test';
export const DAEMON = 'daemon_mach_test';
export const SESSION = 'sess-keyed-1';

export interface BubbleSpec {
    id: string;
    ord: string;
    text: string;
    role?: string;
    kind?: string;
    bubbleState?: string;
    streaming?: boolean;
    turnKey?: string;
    srcId?: string | null;
}

export function message(spec: BubbleSpec): TranscriptObservationMessage {
    return {
        messageId: spec.id,
        ord: spec.ord,
        role: spec.role ?? 'assistant',
        kind: spec.kind ?? 'standard',
        content: spec.text,
        turnKey: spec.turnKey ?? 't1',
        bubbleState: spec.bubbleState ?? 'final',
        srcId: spec.srcId ?? null,
        ...(spec.streaming !== undefined ? { meta: { streaming: spec.streaming } } : {}),
    };
}

export function observation(
    bubbles: BubbleSpec[],
    overrides: Partial<TranscriptObservation> = {},
): TranscriptObservation {
    return {
        sessionId: SESSION,
        providerType: 'claude-cli',
        historySessionId: 'hist-1',
        providerSessionId: 'prov-1',
        status: 'idle',
        providerObservedStatus: 'idle',
        title: 'title',
        messages: bubbles.map(message),
        coverage: { mode: 'full', omittedBefore: false },
        ledgerEpoch: 'abc123',
        ...overrides,
    };
}

/** Deterministic, compressible-resistant filler text of exactly `length` chars. */
export function filler(seed: number, length: number): string {
    let s = '';
    let x = (seed * 2654435761) >>> 0;
    while (s.length < length) {
        x = (x * 1103515245 + 12345) >>> 0;
        s += x.toString(36);
    }
    return s.slice(0, length);
}

/** Fractional-index-like ord keys that sort as their index (fixed width). */
export function ordOf(index: number): string {
    return `a${index.toString(36).padStart(6, '0')}`;
}

export class FrameDriver {
    readonly state: KeyedChatSessionState;
    private seq = 0;
    readonly frames: KeyedChatFrame[] = [];
    nowMs = 1_000_000;

    constructor(readonly writer: string = WRITER, epoch = 'epoch-a') {
        this.state = new KeyedChatSessionState(SESSION, epoch);
    }

    /** Build + commit one frame; returns null when nothing changed. */
    step(obs: TranscriptObservation, verifiedClear = false): KeyedChatFrame | null {
        const built = this.state.build(obs, {
            writerId: this.writer,
            producerDaemonId: DAEMON,
            observedAt: new Date(this.nowMs).toISOString(),
            nowMs: this.nowMs,
            verifiedClear,
        });
        this.nowMs += 350;
        if (built.status !== 'frame') return null;
        this.state.commit(built.frame, this.nowMs);
        this.frames.push(built.frame);
        return built.frame;
    }

    /** The frame's rows as a SUB would deliver them. */
    rowsOf(frame: KeyedChatFrame): KeyedChatRow[] {
        return frame.rows.map((row) => ({
            writer: this.writer,
            seq: ++this.seq,
            kind: row.kind,
            payload: JSON.parse(JSON.stringify(row.payload)),
        }));
    }
}
