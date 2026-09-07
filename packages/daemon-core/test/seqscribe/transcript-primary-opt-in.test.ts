import { afterEach, describe, expect, it } from 'vitest';
import { applyDaemonEnvOverrides } from '../../src/config/env-overrides.js';
import { readTranscriptForDaemonConsumer } from '../../src/mesh/transcript-daemon-consumer-read.js';
import {
    TRANSCRIPT_MODE_ENV,
    __resetTranscriptModeWarningsForTests,
    resolveTranscriptMode,
} from '../../src/seqscribe/transcript-mode.js';

/**
 * §8 unit 9 pre-req — the DAEMON half of the transcript replica opt-in.
 *
 * transcript-mode.test.ts already covers `resolveTranscriptMode` in isolation.
 * What was missing — and what made "replica has never run live" possible while
 * every unit test was green — is proof of the SEAM: that the persisted
 * `config.json` `envOverrides` map is a channel that actually reaches
 * `resolveTranscriptMode`, and through it the consumer read gate
 * (mesh/transcript-daemon-consumer-read.ts §5.5 condition 1).
 *
 * The seam matters because the two ends were built independently and neither
 * one names the other: `env-overrides.ts` knows nothing about transcript, and
 * `transcript-mode.ts` reads a bare `process.env`. The only thing joining them
 * is boot ordering (boot/daemon-lifecycle.ts §1.1 applies the map before any
 * lazy flag read). These cases pin that join, so a future change that moves
 * the apply-step after a transcript read — or that makes the mode a
 * module-load-time constant, which `applyDaemonEnvOverrides` explicitly
 * CANNOT retroactively fix — turns red here instead of silently shipping a
 * daemon that reports `primary` in config and runs `shadow` in fact.
 *
 * ★ The default-stays-shadow cases are the load-bearing half. Turning this on
 * is an operator decision (it makes a replicaHealthy session unsubscribe
 * legacy `session.chat_tail`), so "no config, no env" MUST resolve to
 * `shadow`, and the consumer gate must decline.
 */
describe('ADHDEV_SEQSCRIBE_TRANSCRIPT opt-in seam (design §8 unit 9)', () => {
    afterEach(() => {
        __resetTranscriptModeWarningsForTests();
    });

    /** The consumer-read call shape, reduced to what condition 1 needs. */
    function readWith(env: NodeJS.ProcessEnv) {
        return readTranscriptForDaemonConsumer({
            consumerId: 'daemon_worker_status_probe',
            ownerDaemonId: 'mach_opt_in_probe',
            rawSessionId: 'sess_opt_in_probe',
            maxAgeMs: 60_000,
            // Deliberately null: this asserts WHICH decline reason comes back.
            // A null store declines `no_node` — but only if the mode gate let
            // it through first. `mode_not_primary` vs `no_node` is therefore a
            // precise readout of whether the env reached the gate.
            store: null,
            env,
        });
    }

    it('persisted config override puts the daemon in primary and opens the consumer gate', () => {
        // Exactly what `adhdev config env set ADHDEV_SEQSCRIBE_TRANSCRIPT primary`
        // writes to config.json, applied the way boot applies it.
        const env: NodeJS.ProcessEnv = {};
        const result = applyDaemonEnvOverrides({ [TRANSCRIPT_MODE_ENV]: 'primary' }, env);

        expect(result.applied).toEqual({ [TRANSCRIPT_MODE_ENV]: 'primary' });
        expect(result.skippedRejected).toEqual([]);
        expect(resolveTranscriptMode(env)).toBe('primary');

        // Gate is open: the refusal is now about the missing store, NOT the mode.
        const outcome = readWith(env);
        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('no_node');
        expect(outcome.fallbackReason).not.toBe('mode_not_primary');
    });

    it('is a recognized flag key, so enabling it logs no "verify spelling" warning', () => {
        // Not cosmetic: that warning is the boot-log signal for a typo'd key.
        // If the correctly-spelled key also emits it, the signal is worthless
        // on the one boot an operator is actually reading it to confirm the
        // opt-in took.
        const messages: string[] = [];
        const result = applyDaemonEnvOverrides(
            { [TRANSCRIPT_MODE_ENV]: 'primary' },
            {},
            (msg) => messages.push(msg),
        );

        expect(result.unknownKeys).toEqual([]);
        expect(messages).toEqual([]);
    });

    it('★ DEFAULT — no config override and no env leaves the daemon in shadow, gate closed', () => {
        const env: NodeJS.ProcessEnv = {};
        const result = applyDaemonEnvOverrides(undefined, env);

        expect(result.applied).toEqual({});
        expect(env[TRANSCRIPT_MODE_ENV]).toBeUndefined();
        expect(resolveTranscriptMode(env)).toBe('shadow');
        expect(readWith(env).fallbackReason).toBe('mode_not_primary');
    });

    it('★ DEFAULT — an empty override map is equally inert', () => {
        const env: NodeJS.ProcessEnv = {};
        applyDaemonEnvOverrides({}, env);

        expect(env[TRANSCRIPT_MODE_ENV]).toBeUndefined();
        expect(resolveTranscriptMode(env)).toBe('shadow');
        expect(readWith(env).fallbackReason).toBe('mode_not_primary');
    });

    it('★ an unrelated persisted flag does not incidentally enable transcript primary', () => {
        const env: NodeJS.ProcessEnv = {};
        applyDaemonEnvOverrides({ ADHDEV_WORKER_MCP: 'on' }, env);

        expect(resolveTranscriptMode(env)).toBe('shadow');
        expect(readWith(env).fallbackReason).toBe('mode_not_primary');
    });

    it('a typo in the persisted VALUE falls back to shadow rather than half-enabling', () => {
        // `primry` is applied to the env verbatim — the override map does not
        // validate values — so the fail-safe has to come from the mode
        // resolver. An operator who fat-fingers the value gets the safe state,
        // not an unrecognized one.
        const env: NodeJS.ProcessEnv = {};
        applyDaemonEnvOverrides({ [TRANSCRIPT_MODE_ENV]: 'primry' }, env);

        expect(env[TRANSCRIPT_MODE_ENV]).toBe('primry');
        expect(resolveTranscriptMode(env)).toBe('shadow');
        expect(readWith(env).fallbackReason).toBe('mode_not_primary');
    });

    it('explicit process.env wins over the persisted override, in both directions', () => {
        // Lets an operator force `shadow` for one launch without editing
        // config.json — the emergency-off path for a canaried daemon.
        const forcedOff: NodeJS.ProcessEnv = { [TRANSCRIPT_MODE_ENV]: 'shadow' };
        applyDaemonEnvOverrides({ [TRANSCRIPT_MODE_ENV]: 'primary' }, forcedOff);
        expect(resolveTranscriptMode(forcedOff)).toBe('shadow');
        expect(readWith(forcedOff).fallbackReason).toBe('mode_not_primary');

        // And the converse: a launcher-set `primary` still wins when config says shadow.
        const forcedOn: NodeJS.ProcessEnv = { [TRANSCRIPT_MODE_ENV]: 'primary' };
        applyDaemonEnvOverrides({ [TRANSCRIPT_MODE_ENV]: 'shadow' }, forcedOn);
        expect(resolveTranscriptMode(forcedOn)).toBe('primary');
        expect(readWith(forcedOn).fallbackReason).toBe('no_node');
    });

    it('the key is not secret-shaped, so the persistence surface accepts it', () => {
        // `adhdev config env set` refuses secret-shaped keys outright. A key
        // that tripped that deny-list would make the documented opt-in command
        // fail at the CLI, before config.json is ever written.
        const result = applyDaemonEnvOverrides({ [TRANSCRIPT_MODE_ENV]: 'primary' }, {});
        expect(result.skippedRejected).toEqual([]);
    });
});
