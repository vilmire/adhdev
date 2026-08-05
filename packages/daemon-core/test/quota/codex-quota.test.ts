import { describe, expect, it } from 'vitest';

import { fetchCodexQuota } from '../../src/quota/fetchers/codex';
import type { QuotaChildProcess, QuotaSpawn } from '../../src/quota/fetchers/deps';

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);

/** Live-observed shape from codex-cli 0.146.0 on a Plus account. */
const PLUS_ACCOUNT_RESULT = {
    rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1786337423 },
        secondary: null,
        planType: 'plus',
    },
};

interface FakeChild extends QuotaChildProcess {
    /** Lines the fetcher wrote to the child's stdin. */
    written: string[];
    signals: string[];
    emitStdout(text: string): void;
    emitStderr(text: string): void;
    emitExit(code: number | null): void;
    emitError(err: Error): void;
}

function createFakeChild(): FakeChild {
    const stdoutListeners: ((chunk: Buffer | string) => void)[] = [];
    const stderrListeners: ((chunk: Buffer | string) => void)[] = [];
    const exitListeners: ((code: number | null) => void)[] = [];
    const errorListeners: ((err: Error) => void)[] = [];
    const written: string[] = [];
    const signals: string[] = [];

    return {
        written,
        signals,
        stdin: {
            write: (chunk: string) => {
                written.push(chunk);
            },
            end: () => {},
        },
        stdout: { on: (_event: 'data', listener: (chunk: Buffer | string) => void) => void stdoutListeners.push(listener) },
        stderr: { on: (_event: 'data', listener: (chunk: Buffer | string) => void) => void stderrListeners.push(listener) },
        on: (event: 'error' | 'exit', listener: never) => {
            if (event === 'exit') exitListeners.push(listener as (code: number | null) => void);
            else errorListeners.push(listener as (err: Error) => void);
        },
        kill: (signal?: NodeJS.Signals) => {
            signals.push(signal ?? 'SIGTERM');
        },
        emitStdout: (text) => stdoutListeners.forEach((l) => l(text)),
        emitStderr: (text) => stderrListeners.forEach((l) => l(text)),
        emitExit: (code) => exitListeners.forEach((l) => l(code)),
        emitError: (err) => errorListeners.forEach((l) => l(err)),
    } as FakeChild;
}

/** Captures scheduled timers so a test can fire them on demand. */
function createClock() {
    const pending: { handler: () => void; ms: number; cancelled: boolean }[] = [];
    return {
        pending,
        setTimeout: (handler: () => void, ms: number) => {
            const entry = { handler, ms, cancelled: false };
            pending.push(entry);
            return { unref: () => {} , entry } as { unref: () => void };
        },
        clearTimeout: (handle: unknown) => {
            void handle;
        },
        /** Fire the longest pending timer — the operation budget. */
        fireTimeout: () => {
            const longest = pending.reduce((a, b) => (b.ms > a.ms ? b : a));
            longest.handler();
        },
        fireAll: () => {
            for (const entry of [...pending]) entry.handler();
        },
    };
}

/**
 * Drive a full fetch: a fake child replies to whatever the fetcher sends,
 * according to `respond`.
 */
function runFetch(options: {
    respond?: (child: FakeChild, request: { id: number; method: string }) => void;
    env?: NodeJS.ProcessEnv;
    /**
     * The account label is opt-in (config `quotaShowAccountEmail`, off by
     * default), so a case that expects an email must ask for it explicitly —
     * exactly as a user who enabled the option would.
     */
    showAccountEmail?: boolean;
}) {
    const child = createFakeChild();
    const clock = createClock();
    const spawnCalls: { command: string; args: string[] }[] = [];

    const spawn: QuotaSpawn = (command, args) => {
        spawnCalls.push({ command, args });
        return child;
    };

    // Reply asynchronously so the fetcher has attached its listeners first.
    const originalWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: string) => {
        originalWrite(chunk);
        const request = JSON.parse(chunk) as { id: number; method: string };
        queueMicrotask(() => options.respond?.(child, request));
    };

    const promise = fetchCodexQuota({
        showAccountEmail: () => options.showAccountEmail === true,
        spawn,
        now: () => NOW,
        env: options.env ?? ({} as NodeJS.ProcessEnv),
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
    });

    return { promise, child, clock, spawnCalls };
}

/**
 * Standard happy-path responder.
 *
 * `account/read` is answered too: after the rate limits land, the fetcher asks
 * the SAME app-server session who is signed in, so the reader can tell whose
 * quota it is. `account` defaults to undefined — i.e. the account is unknown —
 * which is the shape every pre-existing case expects (no email on the snapshot).
 */
function respondOk(result: unknown, account?: unknown) {
    return (child: FakeChild, request: { id: number; method: string }) => {
        if (request.method === 'initialize') {
            child.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`);
        } else if (request.method === 'account/rateLimits/read') {
            child.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
        } else if (request.method === 'account/read') {
            child.emitStdout(`${JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                ...(account === undefined ? { error: { code: -32000, message: 'no account' } } : { result: account }),
            })}\n`);
        }
    };
}

describe('fetchCodexQuota', () => {
    it('maps a weekly-only Plus snapshot to the weekly window, not the session window', async () => {
        // Regression guard: `primary` on a Plus account is the 7-day window.
        // Mapping by position rather than by windowDurationMins would report
        // weekly consumption as the 5h session window.
        const { promise } = runFetch({ respond: respondOk(PLUS_ACCOUNT_RESULT) });
        const quota = await promise;

        expect(quota.status).toBe('ok');
        expect(quota.error).toBeNull();
        expect(quota.provider).toBe('codex-cli');
        expect(quota.weekly).toEqual({
            usedPercent: 12,
            windowMinutes: 10080,
            resetsAt: 1786337423 * 1000,
        });
        expect(quota.session).toBeNull();
        expect(quota.metadata).toMatchObject({ source: 'app-server', planType: 'plus' });
    });

    it('assigns a 5h primary to the session window and a 7d secondary to weekly', async () => {
        const { promise } = runFetch({
            respond: respondOk({
                rateLimits: {
                    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1786337423 },
                    secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: null },
                    planType: 'pro',
                },
            }),
        });
        const quota = await promise;

        expect(quota.session).toEqual({ usedPercent: 40, windowMinutes: 300, resetsAt: 1786337423 * 1000 });
        expect(quota.weekly).toEqual({ usedPercent: 8, windowMinutes: 10080, resetsAt: null });
    });

    it('spawns codex with the read-only, untrusted sandbox flags', async () => {
        const { promise, spawnCalls } = runFetch({ respond: respondOk(PLUS_ACCOUNT_RESULT) });
        await promise;

        expect(spawnCalls).toHaveLength(1);
        expect(spawnCalls[0]?.command).toBe('codex');
        expect(spawnCalls[0]?.args).toEqual(['-s', 'read-only', '-a', 'untrusted', 'app-server']);
    });

    it('initializes before requesting rate limits, and sends no params for the read', async () => {
        const { promise, child } = runFetch({ respond: respondOk(PLUS_ACCOUNT_RESULT) });
        await promise;

        const sent = child.written.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(sent[0]?.method).toBe('initialize');
        expect(sent[1]?.method).toBe('account/rateLimits/read');
        expect(sent[1]).not.toHaveProperty('params');
    });

    it('reports unavailable (not error) when codex has no account session', async () => {
        const { promise } = runFetch({
            respond: (child, request) => {
                if (request.method === 'initialize') {
                    child.emitStdout(`${JSON.stringify({ id: request.id, result: {} })}\n`);
                } else {
                    // Live-observed reply from a CODEX_HOME with no auth.json.
                    child.emitStdout(
                        `${JSON.stringify({
                            id: request.id,
                            error: { code: -32600, message: 'codex account authentication required to read rate limits' },
                        })}\n`,
                    );
                }
            },
        });
        const quota = await promise;

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('missing-credentials');
        expect(quota.error).toContain('Not signed in to Codex');
    });

    it('reports cli-unavailable when the binary is missing (ENOENT)', async () => {
        const { promise, child } = runFetch({
            respond: (c) => c.emitError(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })),
        });
        const quota = await promise;
        void child;

        expect(quota.status).toBe('unavailable');
        expect(quota.metadata?.failureKind).toBe('cli-unavailable');
    });

    it('kills the child and reports a timeout when the app-server never answers', async () => {
        const { promise, child, clock } = runFetch({
            // Handshake succeeds, then silence.
            respond: (c, request) => {
                if (request.method === 'initialize') {
                    c.emitStdout(`${JSON.stringify({ id: request.id, result: {} })}\n`);
                }
            },
        });

        await Promise.resolve();
        clock.fireTimeout();
        const quota = await promise;

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('network');
        // The wedged child must not be left running.
        expect(child.signals).toContain('SIGTERM');
    });

    it('escalates to SIGKILL when the child survives SIGTERM', async () => {
        const { promise, child, clock } = runFetch({ respond: respondOk(PLUS_ACCOUNT_RESULT) });
        await promise;

        expect(child.signals).toEqual(['SIGTERM']);
        clock.fireAll(); // fire the escalation timer
        expect(child.signals).toContain('SIGKILL');
    });

    it('terminates the child on the success path too', async () => {
        const { promise, child } = runFetch({ respond: respondOk(PLUS_ACCOUNT_RESULT) });
        await promise;

        expect(child.signals).toContain('SIGTERM');
    });

    it('surfaces an early child exit with its stderr tail', async () => {
        const { promise } = runFetch({
            respond: (child) => {
                child.emitStderr('failed to open config.toml\n');
                child.emitExit(1);
            },
        });
        const quota = await promise;

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('cli-unavailable');
        expect(quota.error).toContain('failed to open config.toml');
    });

    it('reports a parse failure when the snapshot carries no usable window', async () => {
        const { promise } = runFetch({
            respond: respondOk({ rateLimits: { primary: null, secondary: null, planType: 'plus' } }),
        });
        const quota = await promise;

        expect(quota.status).toBe('error');
        expect(quota.metadata?.failureKind).toBe('parse');
    });

    it('tolerates banner noise and JSON split across stdout chunks', async () => {
        const { promise } = runFetch({
            respond: (child, request) => {
                if (request.method === 'initialize') {
                    child.emitStdout('starting app-server...\n');
                    child.emitStdout(`${JSON.stringify({ id: request.id, result: {} })}\n`);
                } else {
                    const payload = JSON.stringify({ id: request.id, result: PLUS_ACCOUNT_RESULT });
                    child.emitStdout(payload.slice(0, 20));
                    child.emitStdout(`${payload.slice(20)}\n`);
                }
            },
        });
        const quota = await promise;

        expect(quota.status).toBe('ok');
        expect(quota.weekly?.usedPercent).toBe(12);
    });

    it('passes through a reset timestamp already expressed in milliseconds', async () => {
        const ms = 1786337423000;
        const { promise } = runFetch({
            respond: respondOk({
                rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: ms } },
            }),
        });
        const quota = await promise;

        expect(quota.session?.resetsAt).toBe(ms);
    });

    it('honours the codex binary override', async () => {
        const { promise, spawnCalls } = runFetch({
            respond: respondOk(PLUS_ACCOUNT_RESULT),
            env: { ADHDEV_CODEX_BIN: '/opt/codex/bin/codex' } as NodeJS.ProcessEnv,
        });
        await promise;

        expect(spawnCalls[0]?.command).toBe('/opt/codex/bin/codex');
    });

    it('settles once when an exit races the successful reply, without re-killing', async () => {
        // The Promise itself would swallow a second resolve(), so the
        // observable signal for the settle-once guard is the teardown running
        // exactly once: a late `exit` must not schedule another SIGTERM.
        const { promise, child } = runFetch({
            respond: (c, request) => {
                if (request.method === 'initialize') {
                    c.emitStdout(`${JSON.stringify({ id: request.id, result: {} })}\n`);
                } else {
                    c.emitStdout(`${JSON.stringify({ id: request.id, result: PLUS_ACCOUNT_RESULT })}\n`);
                    c.emitExit(0);
                }
            },
        });
        const quota = await promise;

        expect(quota.status).toBe('ok');
        expect(child.signals).toEqual(['SIGTERM']);
    });

    // ── Account label (whose quota is this?) ────────────────────────────────
    it('labels the snapshot with the signed-in account from account/read', () => {
        // The email comes from the CLI's own session, NOT from reading
        // $CODEX_HOME/auth.json — see the fetcher header for why that matters.
        return (async () => {
            const { promise } = runFetch({
                showAccountEmail: true,
                respond: respondOk(PLUS_ACCOUNT_RESULT, {
                    account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
                    requiresOpenaiAuth: true,
                }),
            });
            const quota = await promise;
            expect(quota.status).toBe('ok');
            expect(quota.metadata?.accountEmail).toBe('user@example.com');
            // planType still comes from the rate-limits payload, unchanged.
            expect(quota.metadata?.planType).toBe('plus');
        })();
    });

    it('still reports quota when the account lookup fails', () => {
        // An unreadable account is a missing LABEL, never a failed reading.
        return (async () => {
            const { promise } = runFetch({ showAccountEmail: true, respond: respondOk(PLUS_ACCOUNT_RESULT) });
            const quota = await promise;
            expect(quota.status).toBe('ok');
            expect(quota.weekly).not.toBeNull();
            expect(quota.metadata?.accountEmail).toBeUndefined();
        })();
    });
});
