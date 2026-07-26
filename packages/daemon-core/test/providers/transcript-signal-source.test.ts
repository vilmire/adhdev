/**
 * TX-FSM Stage 0 (shadow) — TranscriptSignalSource normalization tests.
 *
 * Locks the daemon-side contracts:
 *  - classification via the authority profile (native-source only); every
 *    other class fails open with an unavailable snapshot
 *  - signal derivation from the flattened pipeline (no correlation ids, no
 *    approval signal)
 *  - mtime 0 = no freshness evidence (mirrors the growth-hold test lock)
 *  - the shadow log fires on CHANGE only
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranscriptSignalSource } from '../../src/providers/transcript-signal-source.js';
import { BUSY_LEASE_BOUND_MS } from '../../src/providers/busy-lease-gate.js';
import { LOG } from '../../src/logging/logger.js';
import type { TranscriptAuthorityProfile } from '../../src/providers/transcript-evidence.js';

const NOW = 1_000_000;
const GROWTH_QUIET_MS = 60_000;

const nativeProfile: TranscriptAuthorityProfile = {
    class: 'native-source',
    timing: 'floor',
    providerOwnsTranscript: true,
    emitsPtyTurnEvents: false,
};

const daemonOwnedProfile: TranscriptAuthorityProfile = {
    class: 'daemon-owned',
    timing: 'immediate',
    providerOwnsTranscript: false,
    emitsPtyTurnEvents: true,
};

function makeSource(overrides: Partial<ConstructorParameters<typeof TranscriptSignalSource>[0]> = {}) {
    return new TranscriptSignalSource({
        label: 'test-cli',
        profile: nativeProfile,
        finalAssistantPresent: () => false,
        growthQuietMs: GROWTH_QUIET_MS,
        ...overrides,
    });
}

describe('TranscriptSignalSource — envelope normalization', () => {
    it('produces an available snapshot from a resolved native read', () => {
        const src = makeSource({ finalAssistantPresent: () => true });
        const snap = src.buildSnapshot({
            messages: [{ role: 'assistant', content: 'done' }],
            probe: { msgCount: 5, sourceMtimeMs: NOW - 10_000, sourcePath: '/tmp/t.jsonl' },
        }, NOW);
        expect(snap.available).toBe(true);
        expect(snap.profile).toEqual({ class: 'native-source', timing: 'floor' });
        // Fresh mtime (< growthQuietMs) → growing + in-turn progress.
        expect(snap.signals.transcript_growing).toBe(true);
        expect(snap.signals.in_turn_progress).toBe(true);
        expect(snap.signals.final_assistant_present).toBe(true);
        expect(snap.detail).toEqual({ msgCount: 5, sourceMtimeMs: NOW - 10_000, ageMs: 10_000 });
    });

    it('reports quiet transcript once the mtime ages past the growth window', () => {
        const src = makeSource();
        const snap = src.buildSnapshot({
            messages: [],
            probe: { msgCount: 5, sourceMtimeMs: NOW - GROWTH_QUIET_MS },
        }, NOW);
        expect(snap.signals.transcript_growing).toBe(false);
        expect(snap.signals.in_turn_progress).toBe(false);
    });

    it('transcript_growing is fresh strictly INSIDE the growth window (Stage-1 growth-hold boundary lock)', () => {
        const src = makeSource();
        // age = growthQuietMs - 1 → still growing (the growth-hold holds).
        const inside = src.buildSnapshot({
            messages: [],
            probe: { msgCount: 5, sourceMtimeMs: NOW - (GROWTH_QUIET_MS - 1) },
        }, NOW);
        expect(inside.signals.transcript_growing).toBe(true);
        expect(inside.detail.ageMs).toBe(GROWTH_QUIET_MS - 1);
        // age = growthQuietMs exactly → no longer fresh (the growth-hold releases).
        const at = src.buildSnapshot({
            messages: [],
            probe: { msgCount: 5, sourceMtimeMs: NOW - GROWTH_QUIET_MS },
        }, NOW);
        expect(at.signals.transcript_growing).toBe(false);
    });

    it('mtime 0 = no freshness evidence → transcript_growing stays null (growth-hold lock parity)', () => {
        const src = makeSource();
        const snap = src.buildSnapshot({
            messages: [],
            probe: { msgCount: 5, sourceMtimeMs: 0 },
        }, NOW);
        expect(snap.available).toBe(true);
        expect(snap.detail.ageMs).toBeNull();
        expect(snap.signals.transcript_growing).toBeNull();
        expect(snap.signals.in_turn_progress).toBe(false);
    });

    it('in_turn_progress trips when the msgCount advances between samples', () => {
        const src = makeSource();
        const stale = { msgCount: 5, sourceMtimeMs: NOW - 120_000 };
        src.buildSnapshot({ messages: [], probe: stale }, NOW);
        const advanced = src.buildSnapshot({ messages: [], probe: { ...stale, msgCount: 6 } }, NOW + 1_000);
        expect(advanced.signals.in_turn_progress).toBe(true);
        // Same count again → back to quiet.
        const same = src.buildSnapshot({ messages: [], probe: { ...stale, msgCount: 6 } }, NOW + 2_000);
        expect(same.signals.in_turn_progress).toBe(false);
    });

    it('passes the turn boundary through to the final-assistant predicate', () => {
        const seen: (number | undefined)[] = [];
        const src = makeSource({
            turnStartedAt: () => 42,
            finalAssistantPresent: (_msgs, ts) => { seen.push(ts); return true; },
        });
        const snap = src.buildSnapshot({ messages: [], probe: { msgCount: 1, sourceMtimeMs: NOW } }, NOW);
        expect(seen).toEqual([42]);
        expect(snap.signals.final_assistant_present).toBe(true);
    });

    it('a throwing final-assistant predicate degrades the signal to null (fail-open, never throws)', () => {
        const src = makeSource({
            finalAssistantPresent: () => { throw new Error('parse quirk'); },
        });
        const snap = src.buildSnapshot({ messages: [], probe: { msgCount: 1, sourceMtimeMs: NOW } }, NOW);
        expect(snap.available).toBe(true);
        expect(snap.signals.final_assistant_present).toBeNull();
    });
});

describe('TranscriptSignalSource — fail-open unavailability', () => {
    it('non-native-source class → unavailable(no_native_source), all signals null', () => {
        const src = makeSource({ profile: daemonOwnedProfile });
        const snap = src.buildSnapshot({
            messages: [{ role: 'assistant' }],
            probe: { msgCount: 3, sourceMtimeMs: NOW },
        }, NOW);
        expect(snap.available).toBe(false);
        expect(snap.unavailableReason).toBe('no_native_source');
        expect(snap.signals).toEqual({
            final_assistant_present: null,
            in_turn_progress: null,
            transcript_growing: null,
        });
    });

    it('unresolved read (null probe/messages) → unavailable(unresolved)', () => {
        const src = makeSource();
        const snap = src.buildSnapshot({ messages: null, probe: null }, NOW);
        expect(snap.available).toBe(false);
        expect(snap.unavailableReason).toBe('unresolved');
    });

    it('read error → unavailable(error)', () => {
        const src = makeSource();
        const snap = src.buildSnapshot({ messages: null, probe: null, error: true }, NOW);
        expect(snap.available).toBe(false);
        expect(snap.unavailableReason).toBe('error');
    });
});

describe('TranscriptSignalSource — shadow log (change-gated)', () => {
    let infoSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { infoSpy = vi.spyOn(LOG, 'info').mockImplementation(() => {}); });
    afterEach(() => { infoSpy.mockRestore(); });

    it('logs once per observation CHANGE, not per sample', () => {
        const src = makeSource();
        const sample = { messages: [], probe: { msgCount: 5, sourceMtimeMs: NOW - 120_000 } };
        src.update(sample, NOW);
        src.update(sample, NOW + 1_000);
        src.update(sample, NOW + 2_000);
        expect(infoSpy).toHaveBeenCalledTimes(1);
        expect(infoSpy.mock.calls[0][1]).toContain('[shadow]');
        expect(infoSpy.mock.calls[0][1]).toContain('available=true');

        // A real change (count advanced) logs again.
        src.update({ messages: [], probe: { msgCount: 6, sourceMtimeMs: NOW + 2_000 } }, NOW + 3_000);
        expect(infoSpy).toHaveBeenCalledTimes(2);
    });

    it('logs the unavailable reason on the available→unavailable transition', () => {
        const src = makeSource();
        src.update({ messages: [], probe: { msgCount: 5, sourceMtimeMs: NOW } }, NOW);
        src.update({ messages: null, probe: null }, NOW + 1_000);
        expect(infoSpy).toHaveBeenCalledTimes(2);
        expect(infoSpy.mock.calls[1][1]).toContain('reason=unresolved');
    });
});

describe('TranscriptSignalSource — bounded busy lease (TX-FSM Stage 2)', () => {
    it('is never issued before any live sample (fail-open: no lease, never a wedge)', () => {
        const src = makeSource();
        expect(src.busyLease(NOW)).toEqual({ active: false, lastLiveAt: null, expiresAt: null, remainingMs: 0 });
        // A quiet sample (old mtime, no count advance) does NOT issue it either.
        src.buildSnapshot({ messages: [], probe: { msgCount: 5, sourceMtimeMs: NOW - 120_000 } }, NOW);
        expect(src.busyLease(NOW).active).toBe(false);
    });

    it('is issued by a live sample and stays active for exactly the bound', () => {
        const src = makeSource();
        src.buildSnapshot({ messages: [], probe: { msgCount: 5, sourceMtimeMs: NOW - 1_000 } }, NOW);
        const lease = src.busyLease(NOW);
        expect(lease.active).toBe(true);
        expect(lease.lastLiveAt).toBe(NOW);
        expect(lease.expiresAt).toBe(NOW + BUSY_LEASE_BOUND_MS);
        expect(lease.remainingMs).toBe(BUSY_LEASE_BOUND_MS);
        // Boundary: active one ms before expiry, expired AT the bound.
        expect(src.busyLease(NOW + BUSY_LEASE_BOUND_MS - 1).active).toBe(true);
        const expired = src.busyLease(NOW + BUSY_LEASE_BOUND_MS);
        expect(expired.active).toBe(false);
        expect(expired.remainingMs).toBe(0);
        // …and it stays expired (no implicit renewal) — the consumer returns to
        // its normal judgment after the bound, forever.
        expect(src.busyLease(NOW + BUSY_LEASE_BOUND_MS * 2).active).toBe(false);
    });

    it('renews on every subsequent live sample (a working transcript never hits the bound)', () => {
        const src = makeSource();
        src.buildSnapshot({ messages: [], probe: { msgCount: 5, sourceMtimeMs: NOW - 1_000 } }, NOW);
        // Quiet samples in between do not renew (stale mtime, no count advance)…
        src.buildSnapshot({ messages: [], probe: { msgCount: 5, sourceMtimeMs: NOW - 120_000 } }, NOW + 100_000);
        expect(src.busyLease(NOW + 100_000).lastLiveAt).toBe(NOW);
        // …but a count advance does (even with an mtime outside the freshness window).
        src.buildSnapshot({ messages: [], probe: { msgCount: 6, sourceMtimeMs: NOW - 120_000 } }, NOW + 150_000);
        expect(src.busyLease(NOW + 150_000).lastLiveAt).toBe(NOW + 150_000);
        expect(src.busyLease(NOW + 150_000).expiresAt).toBe(NOW + 150_000 + BUSY_LEASE_BOUND_MS);
    });

    it('is never issued by an unavailable sample (non-native class / unresolved / error)', () => {
        const daemonOwned = makeSource({ profile: daemonOwnedProfile });
        daemonOwned.buildSnapshot({ messages: [], probe: { msgCount: 5, sourceMtimeMs: NOW } }, NOW);
        expect(daemonOwned.busyLease(NOW).active).toBe(false);

        const unresolved = makeSource();
        unresolved.buildSnapshot({ messages: null, probe: null }, NOW);
        expect(unresolved.busyLease(NOW).active).toBe(false);

        const errored = makeSource();
        errored.buildSnapshot({ messages: null, probe: null, error: true }, NOW);
        expect(errored.busyLease(NOW).active).toBe(false);
    });

    it('honors a custom leaseBoundMs (rollout tuning) over the default', () => {
        const src = makeSource({ leaseBoundMs: 5_000 });
        src.buildSnapshot({ messages: [], probe: { msgCount: 5, sourceMtimeMs: NOW - 1_000 } }, NOW);
        expect(src.busyLease(NOW + 4_999).active).toBe(true);
        expect(src.busyLease(NOW + 5_000).active).toBe(false);
    });
});
