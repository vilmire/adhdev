/**
 * Codex quota read from the CLI's own rollout logs.
 *
 * Every fixture below is written into a temp `$CODEX_HOME`; the real
 * `~/.codex` is never read or written by this suite. The record shape is copied
 * from an actual rollout observed 2026-08-20 (snake_case fields, `resets_at` in
 * Unix seconds, `primary` holding the 7-day window on a Plus account).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    fetchCodexQuotaFromRollout,
    parseRolloutLine,
    readLatestCodexRateLimits,
    codexHome,
    codexSessionsDir,
    CODEX_ROLLOUT_STALE_AFTER_MS,
} from '../../src/quota/fetchers/codex-rollout';

let tempRoot: string;
let env: NodeJS.ProcessEnv;

/** Fixed "now" so staleness assertions do not depend on wall-clock time. */
const NOW = Date.parse('2026-08-20T06:00:00.000Z');

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-codex-rollout-'));
    env = { CODEX_HOME: tempRoot } as NodeJS.ProcessEnv;
});

afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** A `token_count` record carrying rate limits, exactly as Codex writes it. */
function rateLimitLine(options: {
    timestamp: string;
    usedPercent?: number;
    windowMinutes?: number;
    resetsAt?: number;
    secondary?: { used_percent: number; window_minutes: number; resets_at: number } | null;
    planType?: string;
}): string {
    return JSON.stringify({
        timestamp: options.timestamp,
        type: 'event_msg',
        payload: {
            type: 'token_count',
            info: { total_token_usage: { total_tokens: 1702160 } },
            rate_limits: {
                limit_id: 'codex',
                limit_name: null,
                primary: {
                    used_percent: options.usedPercent ?? 2.0,
                    window_minutes: options.windowMinutes ?? 10080,
                    resets_at: options.resetsAt ?? 1787796696,
                },
                secondary: options.secondary ?? null,
                credits: { has_credits: false, unlimited: false, balance: '0' },
                plan_type: options.planType ?? 'plus',
                rate_limit_reached_type: null,
            },
        },
    });
}

/** An ordinary chat line — the overwhelming majority of a real rollout. */
function chatLine(timestamp: string, text: string): string {
    return JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: { type: 'agent_message', message: text },
    });
}

function writeRollout(dateDir: string, name: string, lines: string[]): string {
    const dir = path.join(codexSessionsDir(env), ...dateDir.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
    return file;
}

describe('$CODEX_HOME is respected', () => {
    it('reads the override rather than a hardcoded ~/.codex', () => {
        expect(codexHome(env)).toBe(tempRoot);
        expect(codexSessionsDir(env)).toBe(path.join(tempRoot, 'sessions'));
    });

    it('falls back to ~/.codex when the variable is unset', () => {
        expect(codexHome({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.codex'));
    });
});

describe('parseRolloutLine', () => {
    it('maps a live-shaped record, converting resets_at seconds to ms', () => {
        const parsed = parseRolloutLine(
            rateLimitLine({ timestamp: '2026-08-20T05:31:25.185Z', resetsAt: 1787796696 }),
        );

        expect(parsed).not.toBeNull();
        // 10080 minutes is the 7-day window: it must land in `weekly`, NOT in
        // `session`, even though the CLI called it `primary`.
        expect(parsed?.weekly?.usedPercent).toBe(2);
        expect(parsed?.weekly?.windowMinutes).toBe(10080);
        expect(parsed?.session).toBeNull();
        expect(parsed?.weekly?.resetsAt).toBe(1787796696 * 1000);
        expect(parsed?.planType).toBe('plus');
        expect(parsed?.capturedAt).toBe(Date.parse('2026-08-20T05:31:25.185Z'));
    });

    it('sorts a 5h primary into the session slot', () => {
        const parsed = parseRolloutLine(
            rateLimitLine({
                timestamp: '2026-08-20T05:31:25.185Z',
                usedPercent: 40,
                windowMinutes: 300,
                secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1787796696 },
            }),
        );

        expect(parsed?.session?.usedPercent).toBe(40);
        expect(parsed?.weekly?.usedPercent).toBe(12);
    });

    it('returns null for lines that carry no reading, without throwing', () => {
        expect(parseRolloutLine(chatLine('2026-08-20T05:00:00.000Z', 'hello'))).toBeNull();
        expect(parseRolloutLine('')).toBeNull();
        expect(parseRolloutLine('not json at all')).toBeNull();
        // A truncated final line — the CLI was mid-write. The common case.
        expect(parseRolloutLine('{"timestamp":"2026-08-20T05:31:25.185Z","rate_limits":{"prim')).toBeNull();
    });

    it('refuses a reading it cannot date', () => {
        const undated = JSON.parse(rateLimitLine({ timestamp: 'x' })) as Record<string, unknown>;
        delete undated.timestamp;

        // Staleness cannot be judged without a capture time, and an undatable
        // reading presented as current is exactly the fabrication to avoid.
        expect(parseRolloutLine(JSON.stringify(undated))).toBeNull();
    });

    it('ignores a rate_limits object with no usable percentage', () => {
        const line = JSON.stringify({
            timestamp: '2026-08-20T05:31:25.185Z',
            type: 'event_msg',
            payload: { type: 'token_count', rate_limits: { primary: null, secondary: null } },
        });

        expect(parseRolloutLine(line)).toBeNull();
    });
});

describe('readLatestCodexRateLimits', () => {
    it('finds the newest reading at the END of a file full of chat', () => {
        writeRollout('2026/08/20', 'rollout-2026-08-20T05-00-00-aaa.jsonl', [
            rateLimitLine({ timestamp: '2026-08-20T05:00:00.000Z', usedPercent: 1 }),
            ...Array.from({ length: 400 }, (_, i) => chatLine('2026-08-20T05:10:00.000Z', `msg ${i}`)),
            rateLimitLine({ timestamp: '2026-08-20T05:31:25.185Z', usedPercent: 2 }),
        ]);

        const { reading } = readLatestCodexRateLimits(env, NOW);

        expect(reading?.weekly?.usedPercent).toBe(2);
    });

    it('survives a chunk boundary falling mid-record', () => {
        // The backward reader stitches chunks; a record split across the
        // boundary must still parse. Padding pushes the reading past 256 KB
        // from the end of the file.
        const padding = Array.from({ length: 900 }, (_, i) =>
            chatLine('2026-08-20T05:10:00.000Z', 'x'.repeat(400) + String(i)),
        );
        writeRollout('2026/08/20', 'rollout-2026-08-20T05-00-00-aaa.jsonl', [
            rateLimitLine({ timestamp: '2026-08-20T05:00:00.000Z', usedPercent: 7 }),
            ...padding,
        ]);

        const { reading } = readLatestCodexRateLimits(env, NOW);

        expect(reading?.weekly?.usedPercent).toBe(7);
    });

    it('keeps looking when the newest file holds no reading', () => {
        writeRollout('2026/08/20', 'rollout-2026-08-20T04-00-00-aaa.jsonl', [
            rateLimitLine({ timestamp: '2026-08-20T04:00:00.000Z', usedPercent: 5 }),
        ]);
        // A session that errored out before its first turn — normal, and must
        // not end the search.
        writeRollout('2026/08/20', 'rollout-2026-08-20T05-00-00-bbb.jsonl', [
            chatLine('2026-08-20T05:00:00.000Z', 'nothing useful'),
        ]);

        const { reading } = readLatestCodexRateLimits(env, NOW);

        expect(reading?.weekly?.usedPercent).toBe(5);
    });

    it('stops one file after the first hit instead of reading the whole history', () => {
        // Filenames sort by session START time, so the newest file is checked
        // first and exactly one more is opened to catch a long-running earlier
        // session holding a later record. Everything beyond that is wasted IO
        // on multi-MB logs — measured against the real ~/.codex, an earlier
        // version of this loop opened all 8.
        for (let i = 0; i < 6; i += 1) {
            writeRollout('2026/08/20', `rollout-2026-08-20T0${i}-00-00-aaa.jsonl`, [
                rateLimitLine({ timestamp: `2026-08-20T0${i}:00:00.000Z`, usedPercent: i }),
            ]);
        }

        const { reading, filesScanned } = readLatestCodexRateLimits(env, NOW);

        expect(filesScanned).toBe(2);
        expect(reading?.weekly?.usedPercent).toBe(5);
    });

    it('reports no reading when the sessions tree is absent entirely', () => {
        const { reading } = readLatestCodexRateLimits(env, NOW);

        expect(reading).toBeNull();
    });
});

describe('fetchCodexQuotaFromRollout', () => {
    it('returns an ok snapshot dated to the capture, with zero network calls', () => {
        writeRollout('2026/08/20', 'rollout-2026-08-20T05-31-00-aaa.jsonl', [
            rateLimitLine({ timestamp: '2026-08-20T05:31:25.185Z', usedPercent: 2 }),
        ]);

        // No `fetch` and no `spawn` are supplied: any attempt to use one would
        // reach the real implementations, and the assertions below would not be
        // what failed. The suite's real guarantee is structural — this module
        // imports neither.
        const quota = fetchCodexQuotaFromRollout({ env, now: () => NOW });

        expect(quota?.status).toBe('ok');
        expect(quota?.error).toBeNull();
        expect(quota?.weekly?.usedPercent).toBe(2);
        expect(quota?.metadata?.source).toBe('rollout');
        expect(quota?.metadata?.planType).toBe('plus');
        // Dated to when Codex measured it, not to when we read the file.
        expect(quota?.updatedAt).toBe(Date.parse('2026-08-20T05:31:25.185Z'));
    });

    it('marks an aged-out reading stale instead of presenting it as current', () => {
        const captured = NOW - CODEX_ROLLOUT_STALE_AFTER_MS - 60 * 60 * 1000;
        writeRollout('2026/08/19', 'rollout-2026-08-19T20-00-00-aaa.jsonl', [
            rateLimitLine({ timestamp: new Date(captured).toISOString(), usedPercent: 33 }),
        ]);

        const quota = fetchCodexQuotaFromRollout({ env, now: () => NOW });

        expect(quota?.status).toBe('error');
        expect(quota?.error).toContain('stale');
        expect(quota?.metadata?.failureKind).toBe('no-data');
        // The measured number is still reported — with its true age — because
        // a real dated reading beats no information. What must never happen is
        // it being dated to now or adjusted upward by guesswork.
        expect(quota?.weekly?.usedPercent).toBe(33);
        expect(quota?.updatedAt).toBe(captured);
    });

    it('returns null — not a fabricated snapshot — when there is nothing to read', () => {
        expect(fetchCodexQuotaFromRollout({ env, now: () => NOW })).toBeNull();
    });

    it('returns null rather than throwing on a corrupt rollout', () => {
        writeRollout('2026/08/20', 'rollout-2026-08-20T05-00-00-aaa.jsonl', [
            '{{{ not json',
            '  binary garbage',
            '{"timestamp":"2026-08-20T05:00:00.000Z","payload":{"rate_limits":',
        ]);

        expect(fetchCodexQuotaFromRollout({ env, now: () => NOW })).toBeNull();
    });
});
