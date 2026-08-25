import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STALE_AFTER_MS, fetchClaudeQuota } from '../../src/quota/fetchers/claude';
import { SNAPSHOT_VERSION } from '../../src/quota/statusline/snapshot';
import { installClaudeStatusline, resolveInstallPaths } from '../../src/quota/statusline/install';

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);

let tempRoot: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-claude-quota-'));
    env = {
        ADHDEV_CONFIG_DIR: path.join(tempRoot, 'adhdev'),
        CLAUDE_CONFIG_DIR: path.join(tempRoot, 'claude'),
    } as NodeJS.ProcessEnv;
    fs.mkdirSync(path.join(tempRoot, 'claude'), { recursive: true });
});

afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function writeSnapshot(overrides: Record<string, unknown> = {}): void {
    const paths = resolveInstallPaths(env);
    // A real snapshot can only be produced by an installed wrapper. Keeping
    // the fixture realistic also lets the fetcher audit wrapper health before
    // trusting an old file.
    installClaudeStatusline(env);
    fs.mkdirSync(path.dirname(paths.snapshotFile), { recursive: true });
    fs.writeFileSync(
        paths.snapshotFile,
        JSON.stringify({
            version: SNAPSHOT_VERSION,
            capturedAt: NOW,
            fiveHour: { usedPercent: 23.5, resetsAt: 1786337423000 },
            sevenDay: { usedPercent: 41.2, resetsAt: 1786857600000 },
            cliVersion: '2.1.220',
            ...overrides,
        }),
        'utf-8',
    );
}

function fetch(nowMs = NOW) {
    return fetchClaudeQuota({ env, now: () => nowMs });
}

describe('fetchClaudeQuota', () => {
    it('maps the 5h window to session and the 7d window to weekly', async () => {
        writeSnapshot();

        const quota = await fetch();

        expect(quota.status).toBe('ok');
        expect(quota.error).toBeNull();
        expect(quota.provider).toBe('claude-cli');
        expect(quota.session).toEqual({ usedPercent: 23.5, windowMinutes: 300, resetsAt: 1786337423000 });
        expect(quota.weekly).toEqual({ usedPercent: 41.2, windowMinutes: 10080, resetsAt: 1786857600000 });
        expect(quota.metadata).toMatchObject({ source: 'statusline' });
    });

    it('reports the capture time, not the read time, as updatedAt', async () => {
        // A consumer must be able to tell how old the numbers are; stamping
        // "now" would make every stale reading look freshly measured.
        writeSnapshot({ capturedAt: NOW - 60_000 });

        const quota = await fetch();

        expect(quota.updatedAt).toBe(NOW - 60_000);
    });

    it('handles a snapshot with only one window', async () => {
        writeSnapshot({ sevenDay: null });

        const quota = await fetch();

        expect(quota.status).toBe('ok');
        expect(quota.session?.usedPercent).toBe(23.5);
        expect(quota.weekly).toBeNull();
    });

    it('clamps an over-100 percentage rather than reporting it raw', async () => {
        writeSnapshot({ fiveHour: { usedPercent: 140, resetsAt: null } });

        expect((await fetch()).session?.usedPercent).toBe(100);
    });

    it('says the wrapper is not set up when nothing is installed', async () => {
        const quota = await fetch();

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('setup-required');
        expect(quota.error).toContain('not set up');
    });

    it('distinguishes "installed but nothing captured yet" from "not set up"', async () => {
        // These need different actions from the user, so they must not collapse
        // into one message.
        fs.writeFileSync(resolveInstallPaths(env).settingsFile, '{}', 'utf-8');
        installClaudeStatusline(env);

        const quota = await fetch();

        expect(quota.status).toBe('unavailable');
        expect(quota.error).toContain('No Claude quota captured yet');
        expect(quota.error).not.toContain('not set up');
        expect(quota.metadata?.failureKind).toBe('no-data');
    });

    it('reports a stale reading as an error while still surfacing the numbers', async () => {
        writeSnapshot({ capturedAt: NOW - STALE_AFTER_MS - 60_000 });

        const quota = await fetch();

        expect(quota.status).toBe('error');
        expect(quota.error).toContain('stale');
        expect(quota.metadata?.failureKind).toBe('no-data');
        // The last known values stay visible — they are better than nothing,
        // as long as they are not labelled current.
        expect(quota.session?.usedPercent).toBe(23.5);
        // …and they carry retained-last-good provenance, so mesh routing keeps
        // gating/bonusing on them until each window's own resetsAt (owner
        // decision 2026-08-24). Without this mark the routing layer discarded
        // the retained measurement wholesale.
        expect(quota.metadata?.lastGoodWindows).toBe(true);
    });

    it('reports a dangling wrapper as setup-required even when an old snapshot exists', async () => {
        writeSnapshot({ capturedAt: NOW - STALE_AFTER_MS - 60_000 });
        const paths = resolveInstallPaths(env);
        fs.rmSync(paths.wrapperFile);

        const quota = await fetch();

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('setup-required');
        expect(quota.error).toContain('wrapper is missing');
        expect(quota.error).toContain('claude:install');
        expect(quota.session).toBeNull();
    });

    it('treats a reading just inside the stale threshold as current', async () => {
        writeSnapshot({ capturedAt: NOW - STALE_AFTER_MS + 1_000 });

        expect((await fetch()).status).toBe('ok');
    });

    it('reports a parse failure for a corrupted snapshot', async () => {
        const paths = resolveInstallPaths(env);
        installClaudeStatusline(env);
        fs.mkdirSync(path.dirname(paths.snapshotFile), { recursive: true });
        fs.writeFileSync(paths.snapshotFile, 'not json at all', 'utf-8');

        const quota = await fetch();

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
    });

    it('rejects a snapshot written by a future wrapper version', async () => {
        writeSnapshot({ version: SNAPSHOT_VERSION + 1 });

        const quota = await fetch();

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
    });

    it('never throws, whatever is on disk', async () => {
        const paths = resolveInstallPaths(env);
        fs.mkdirSync(paths.snapshotFile, { recursive: true }); // a directory, not a file

        await expect(fetch()).resolves.toMatchObject({ provider: 'claude-cli' });
    });
});
