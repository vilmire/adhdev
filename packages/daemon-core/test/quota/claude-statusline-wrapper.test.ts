/**
 * Executes the generated wrapper as a real child process.
 *
 * The wrapper's whole job is what happens at runtime in the user's terminal —
 * whether stdout survives, whether the exit code stays 0, whether the original
 * command still receives stdin. None of that is observable by inspecting the
 * source string, so these tests spawn it for real and assert on what came back.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SNAPSHOT_VERSION } from '../../src/quota/statusline/snapshot';
import { renderWrapperScript } from '../../src/quota/statusline/wrapper-source';

const STATUSLINE_INPUT = {
    session_id: 'sess-123',
    cwd: '/Users/someone/project',
    workspace: { current_dir: '/Users/someone/project' },
    version: '2.1.220',
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1786337423 },
        seven_day: { used_percentage: 41.2, resets_at: 1786857600 },
    },
};

let tempRoot: string;
let wrapperFile: string;
let snapshotFile: string;

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-wrapper-'));
    wrapperFile = path.join(tempRoot, 'adhdev-statusline.mjs');
    snapshotFile = path.join(tempRoot, 'quota.json');
});

afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Write the wrapper with a given original command, then run it. */
function runWrapper(
    originalCommand: string | null,
    input: unknown = STATUSLINE_INPUT,
    options: {
        minWriteIntervalMs?: number;
        maxWriteIntervalMs?: number;
        additionalSnapshotPaths?: string[];
    } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
    fs.writeFileSync(
        wrapperFile,
        renderWrapperScript({
            snapshotPath: snapshotFile,
            additionalSnapshotPaths: options.additionalSnapshotPaths,
            originalCommand,
            snapshotVersion: SNAPSHOT_VERSION,
            minWriteIntervalMs: options.minWriteIntervalMs ?? 15_000,
            maxWriteIntervalMs: options.maxWriteIntervalMs ?? 30_000,
        }),
        'utf-8',
    );

    return new Promise((resolve) => {
        const child = spawn(process.execPath, [wrapperFile], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf-8')));
        child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf-8')));
        child.on('exit', (code) => resolve({ stdout, stderr, code }));
        child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    });
}

function readSnapshot(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(snapshotFile, 'utf-8')) as Record<string, unknown>;
}

describe('statusline wrapper passthrough', () => {
    it('reproduces the original command stdout byte-for-byte', async () => {
        const result = await runWrapper('printf "hello-prompt"');

        expect(result.stdout).toBe('hello-prompt');
        expect(result.code).toBe(0);
    });

    it('preserves ANSI escapes and the absence of a trailing newline', async () => {
        // Real statuslines end with a colour reset and no newline; adding one
        // would visibly change the user's prompt.
        const result = await runWrapper(`printf "$(printf '\\033[32m')ok$(printf '\\033[0m')"`);

        expect(result.stdout).toBe('[32mok[0m');
        expect(result.stdout.endsWith('\n')).toBe(false);
    });

    it('feeds the original command the statusline JSON on stdin', async () => {
        // The owner's real statusline does `input=$(cat)`. If the wrapper
        // consumed stdin without re-feeding it, this reads empty.
        const result = await runWrapper(`input=$(cat); printf "got:%s" "$(echo "$input" | head -c 20)"`);

        expect(result.stdout).toContain('got:');
        expect(result.stdout).toContain('session_id');
    });

    it('passes stdin through unmodified', async () => {
        const result = await runWrapper('cat');

        expect(JSON.parse(result.stdout)).toEqual(STATUSLINE_INPUT);
    });

    it('supports a shell one-liner with pipes and quoting', async () => {
        const result = await runWrapper(
            `input=$(cat); printf "dir=%s" "$(echo "$input" | sed -n 's/.*"current_dir":"\\([^"]*\\)".*/\\1/p')"`,
        );

        expect(result.stdout).toBe('dir=/Users/someone/project');
    });
});

describe('statusline wrapper resilience', () => {
    it('still prints the original output when the original command exits non-zero', async () => {
        // Claude Code blanks the status line on a non-zero exit. The user's
        // command failing is their business; our wrapper must not convert a
        // partial prompt into an empty one.
        const result = await runWrapper('printf "partial"; exit 3');

        expect(result.stdout).toBe('partial');
        expect(result.code).toBe(0);
    });

    it('exits 0 when the original command does not exist', async () => {
        const result = await runWrapper('this-command-does-not-exist-adhdev');

        expect(result.code).toBe(0);
    });

    it('exits 0 and prints nothing when no original command was configured', async () => {
        const result = await runWrapper(null);

        expect(result.stdout).toBe('');
        expect(result.code).toBe(0);
    });

    it('still runs the original command when the payload is not JSON', async () => {
        const result = await runWrapper('printf "prompt-ok"', 'not json at all');

        expect(result.stdout).toBe('prompt-ok');
        expect(result.code).toBe(0);
    });

    it('still runs the original command when the snapshot cannot be written', async () => {
        // Simulate an unwritable location: a path whose parent is a file.
        const blocker = path.join(tempRoot, 'blocker');
        fs.writeFileSync(blocker, 'x', 'utf-8');
        snapshotFile = path.join(blocker, 'quota.json');

        const result = await runWrapper('printf "prompt-still-here"');

        expect(result.stdout).toBe('prompt-still-here');
        expect(result.code).toBe(0);
    });

    it('forwards the original command stderr without polluting stdout', async () => {
        const result = await runWrapper('printf "out"; printf "warn" >&2');

        expect(result.stdout).toBe('out');
        expect(result.stderr).toContain('warn');
    });
});

describe('statusline wrapper capture', () => {
    it('records both windows with resets_at converted to milliseconds', async () => {
        await runWrapper('printf ok');
        const snapshot = readSnapshot();

        expect(snapshot.version).toBe(SNAPSHOT_VERSION);
        expect(snapshot.fiveHour).toEqual({ usedPercent: 23.5, resetsAt: 1786337423 * 1000 });
        expect(snapshot.sevenDay).toEqual({ usedPercent: 41.2, resetsAt: 1786857600 * 1000 });
        expect(snapshot.cliVersion).toBe('2.1.220');
    });

    it('writes no snapshot when the payload carries no rate_limits', async () => {
        const { rate_limits, ...withoutLimits } = STATUSLINE_INPUT;
        void rate_limits;

        const result = await runWrapper('printf ok', withoutLimits);

        expect(result.stdout).toBe('ok');
        expect(fs.existsSync(snapshotFile)).toBe(false);
    });

    it('persists no session or path content from the payload', async () => {
        await runWrapper('printf ok');
        const raw = fs.readFileSync(snapshotFile, 'utf-8');

        expect(raw).not.toContain('sess-123');
        expect(raw).not.toContain('/Users/someone/project');
    });

    it('throttles a rapid second invocation to a single write', async () => {
        await runWrapper('printf ok');
        const first = readSnapshot();

        // Claude Code re-runs the statusline on every assistant message; an
        // immediate second run must not touch disk again.
        await runWrapper('printf ok', {
            ...STATUSLINE_INPUT,
            rate_limits: {
                five_hour: { used_percentage: 99, resets_at: 1786337423 },
                seven_day: { used_percentage: 99, resets_at: 1786857600 },
            },
        });

        expect(readSnapshot()).toEqual(first);
    });

    it('writes again once the throttle interval has elapsed', async () => {
        // Same scenario as above with the interval collapsed to zero, which is
        // the discriminator proving the skip was the throttle and not an
        // inability to write a second time.
        await runWrapper('printf ok', STATUSLINE_INPUT, { minWriteIntervalMs: 0, maxWriteIntervalMs: 0 });
        const first = readSnapshot();

        await runWrapper(
            'printf ok',
            {
                ...STATUSLINE_INPUT,
                rate_limits: {
                    five_hour: { used_percentage: 99, resets_at: 1786337423 },
                    seven_day: { used_percentage: 41.2, resets_at: 1786857600 },
                },
            },
            { minWriteIntervalMs: 0, maxWriteIntervalMs: 0 },
        );

        const second = readSnapshot();
        expect(second).not.toEqual(first);
        expect(second.fiveHour).toEqual({ usedPercent: 99, resetsAt: 1786337423 * 1000 });
    });

    it('leaves a valid snapshot in place when a later payload is unusable', async () => {
        await runWrapper('printf ok');
        const good = readSnapshot();

        await runWrapper('printf ok', 'garbage');

        expect(readSnapshot()).toEqual(good);
    });
});

describe('statusline wrapper multi-track fan-out', () => {
    it('writes the same snapshot to every additional track path', async () => {
        const siblingA = path.join(tempRoot, 'track-a', 'quota.json');
        const siblingB = path.join(tempRoot, 'track-b', 'nested', 'quota.json');

        const result = await runWrapper('printf ok', STATUSLINE_INPUT, {
            additionalSnapshotPaths: [siblingA, siblingB],
        });

        expect(result.code).toBe(0);
        const primary = readSnapshot();
        for (const sibling of [siblingA, siblingB]) {
            expect(JSON.parse(fs.readFileSync(sibling, 'utf-8'))).toEqual(primary);
        }
    });

    it('an unwritable sibling blocks neither the primary nor the prompt', async () => {
        // A sibling path whose parent is a FILE can never be created.
        const blocker = path.join(tempRoot, 'blocker');
        fs.writeFileSync(blocker, 'x', 'utf-8');

        const result = await runWrapper('printf prompt-here', STATUSLINE_INPUT, {
            additionalSnapshotPaths: [path.join(blocker, 'quota.json')],
        });

        expect(result.stdout).toBe('prompt-here');
        expect(result.code).toBe(0);
        expect(readSnapshot().fiveHour).toEqual({ usedPercent: 23.5, resetsAt: 1786337423 * 1000 });
    });

    it('throttle still keys on the primary snapshot only', async () => {
        const sibling = path.join(tempRoot, 'sibling', 'quota.json');
        const options = { additionalSnapshotPaths: [sibling] };

        await runWrapper('printf ok', STATUSLINE_INPUT, options);
        const firstSibling = JSON.parse(fs.readFileSync(sibling, 'utf-8'));

        // An immediate second run is throttled everywhere, siblings included.
        await runWrapper(
            'printf ok',
            {
                ...STATUSLINE_INPUT,
                rate_limits: { five_hour: { used_percentage: 99, resets_at: 1786337423 } },
            },
            options,
        );

        expect(JSON.parse(fs.readFileSync(sibling, 'utf-8'))).toEqual(firstSibling);
    });
});
