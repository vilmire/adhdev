/**
 * `fetchCodexQuota` prefers the local rollout logs over the app-server.
 *
 * The point of the change: the app-server path spawns the CLI and has it call
 * an endpoint that, measured 2026-08-20, answers 401 for a perfectly valid
 * account. The same numbers were already on disk. So a current local reading
 * must satisfy the request outright — no spawn, no request — and the transport
 * must run only when the local answer is missing or stale.
 *
 * `spawn` is stubbed to a throwing double throughout: the assertion "no process
 * was started" is enforced structurally rather than by inspecting a counter
 * after the fact.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchCodexQuota } from '../../src/quota/fetchers/codex';
import { CODEX_ROLLOUT_STALE_AFTER_MS } from '../../src/quota/fetchers/codex-rollout';
import type { QuotaSpawn } from '../../src/quota/fetchers/deps';

const NOW = Date.parse('2026-08-20T06:00:00.000Z');

let tempRoot: string;
let env: NodeJS.ProcessEnv;
let spawnCalls: number;

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-codex-first-'));
    env = { CODEX_HOME: tempRoot } as NodeJS.ProcessEnv;
    spawnCalls = 0;
});

afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Any use of this fails loudly rather than silently reaching a real CLI. */
const forbiddenSpawn: QuotaSpawn = () => {
    spawnCalls += 1;
    throw new Error('spawned the codex CLI when a local reading was available');
};

function writeReading(isoTimestamp: string, usedPercent: number): void {
    const dir = path.join(tempRoot, 'sessions', '2026', '08', '20');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'rollout-2026-08-20T05-31-00-aaa.jsonl'),
        JSON.stringify({
            timestamp: isoTimestamp,
            type: 'event_msg',
            payload: {
                type: 'token_count',
                rate_limits: {
                    primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1787796696 },
                    secondary: null,
                    plan_type: 'plus',
                },
            },
        }) + '\n',
        'utf-8',
    );
}

describe('local-first ordering', () => {
    it('answers from the rollout log without spawning anything', async () => {
        writeReading('2026-08-20T05:31:25.185Z', 2);

        const quota = await fetchCodexQuota({ env, now: () => NOW, spawn: forbiddenSpawn });

        expect(quota.status).toBe('ok');
        expect(quota.weekly?.usedPercent).toBe(2);
        expect(quota.metadata?.source).toBe('rollout');
        expect(spawnCalls).toBe(0);
    });

    it('falls back to the app-server when there is no local reading', async () => {
        // Nothing written. The fallback is expected to run — and here it is the
        // throwing double, whose failure the fetcher must absorb into a
        // snapshot rather than propagate (the never-throw contract).
        const quota = await fetchCodexQuota({ env, now: () => NOW, spawn: forbiddenSpawn });

        expect(spawnCalls).toBe(1);
        expect(quota.status === 'error' || quota.status === 'unavailable').toBe(true);
        expect(quota.provider).toBe('codex-cli');
    });

    it('falls back when the local reading has aged out', async () => {
        writeReading(new Date(NOW - CODEX_ROLLOUT_STALE_AFTER_MS - 60_000).toISOString(), 40);

        const quota = await fetchCodexQuota({ env, now: () => NOW, spawn: forbiddenSpawn });

        expect(spawnCalls).toBe(1);
        // The app-server double failed, so the stale-but-real local reading is
        // what gets reported — with its honest age, never restated as fresh.
        expect(quota.weekly?.usedPercent).toBe(40);
        expect(quota.status).toBe('error');
        expect(quota.error).toContain('stale');
        expect(quota.metadata?.source).toBe('rollout');
    });
});
