import { describe, expect, it } from 'vitest';
import { IpcConnectionLoadGuard } from '../../src/ipc/ipc-load-guards.js';
import {
    IPC_BUSY_ERROR_CODE,
    IPC_MAX_INFLIGHT_PER_CONNECTION,
    IPC_PROBE_RATE_LIMIT_MAX_CALLS,
    IPC_PROBE_RATE_LIMIT_WINDOW_MS,
    IPC_RATE_LIMITED_ERROR_CODE,
} from '../../src/ipc-protocol.js';

// Audit #12 (IPC load audit, 2026-09-23): the local IPC transport had no
// per-connection concurrency cap and no rate limit at all — a runaway or
// misbehaving local process (loopback-only, no auth) could pipeline unlimited
// commands. These are pure unit tests of the guard's acquire/release/token-
// bucket logic in isolation from any real WebSocket server.

describe('IpcConnectionLoadGuard — in-flight cap', () => {
    it('allows up to IPC_MAX_INFLIGHT_PER_CONNECTION concurrent commands, rejects the next with ipc_busy', () => {
        const guard = new IpcConnectionLoadGuard();
        for (let i = 0; i < IPC_MAX_INFLIGHT_PER_CONNECTION; i++) {
            const rejection = guard.tryAcquire(`cmd_${i}`);
            expect(rejection).toBeNull();
        }
        expect(guard.inFlightCount).toBe(IPC_MAX_INFLIGHT_PER_CONNECTION);

        const rejection = guard.tryAcquire('one_too_many');
        expect(rejection).not.toBeNull();
        expect(rejection!.code).toBe(IPC_BUSY_ERROR_CODE);
    });

    it('release() frees a slot for a subsequent acquire', () => {
        const guard = new IpcConnectionLoadGuard();
        for (let i = 0; i < IPC_MAX_INFLIGHT_PER_CONNECTION; i++) {
            guard.tryAcquire(`cmd_${i}`);
        }
        expect(guard.tryAcquire('blocked')).not.toBeNull();

        guard.release();
        expect(guard.tryAcquire('now_fits')).toBeNull();
    });

    it('release() is safe to call when nothing is in flight (never goes negative)', () => {
        const guard = new IpcConnectionLoadGuard();
        guard.release();
        guard.release();
        expect(guard.inFlightCount).toBe(0);
        // Still able to acquire the full budget afterwards.
        for (let i = 0; i < IPC_MAX_INFLIGHT_PER_CONNECTION; i++) {
            expect(guard.tryAcquire(`cmd_${i}`)).toBeNull();
        }
    });
});

describe('IpcConnectionLoadGuard — probe-verb token bucket', () => {
    it('a non-probe command is never rate-limited, however many times it is called', () => {
        const guard = new IpcConnectionLoadGuard();
        for (let i = 0; i < IPC_PROBE_RATE_LIMIT_MAX_CALLS * 3; i++) {
            const rejection = guard.tryAcquire('launch_cli', 1_000);
            expect(rejection).toBeNull();
            guard.release();
        }
    });

    it('allows up to IPC_PROBE_RATE_LIMIT_MAX_CALLS within the window, then rejects with rate_limited + retryAfterMs', () => {
        const guard = new IpcConnectionLoadGuard();
        const now = 10_000;
        for (let i = 0; i < IPC_PROBE_RATE_LIMIT_MAX_CALLS; i++) {
            const rejection = guard.tryAcquire('get_status_metadata', now + i);
            expect(rejection).toBeNull();
            guard.release();
        }

        const rejection = guard.tryAcquire('get_status_metadata', now + IPC_PROBE_RATE_LIMIT_MAX_CALLS);
        expect(rejection).not.toBeNull();
        expect(rejection!.code).toBe(IPC_RATE_LIMITED_ERROR_CODE);
        expect(rejection!.retryAfterMs).toBeGreaterThan(0);
        expect(rejection!.retryAfterMs).toBeLessThanOrEqual(IPC_PROBE_RATE_LIMIT_WINDOW_MS);
    });

    it('the bucket recovers once the window slides past the oldest call', () => {
        const guard = new IpcConnectionLoadGuard();
        const start = 0;
        for (let i = 0; i < IPC_PROBE_RATE_LIMIT_MAX_CALLS; i++) {
            guard.tryAcquire('mesh_status', start + i);
            guard.release();
        }
        // Still within the window relative to the FIRST call → rejected.
        expect(guard.tryAcquire('mesh_status', start + IPC_PROBE_RATE_LIMIT_WINDOW_MS - 1)).not.toBeNull();

        // Past the window relative to the first call → that slot has aged out.
        const afterWindow = start + IPC_PROBE_RATE_LIMIT_WINDOW_MS + 1;
        const rejection = guard.tryAcquire('mesh_status', afterWindow);
        expect(rejection).toBeNull();
    });

    it('each probe-verb command has an independent bucket (get_status_metadata vs mesh_status vs get_mesh_queue)', () => {
        const guard = new IpcConnectionLoadGuard();
        const now = 5_000;
        for (let i = 0; i < IPC_PROBE_RATE_LIMIT_MAX_CALLS; i++) {
            expect(guard.tryAcquire('get_status_metadata', now)).toBeNull();
            guard.release();
        }
        // get_status_metadata's bucket is now exhausted, but mesh_status and
        // get_mesh_queue have their own independent buckets.
        expect(guard.tryAcquire('get_status_metadata', now)).not.toBeNull();
        expect(guard.tryAcquire('mesh_status', now)).toBeNull();
        expect(guard.tryAcquire('get_mesh_queue', now)).toBeNull();
    });

    it('the in-flight cap and the token bucket are independent — hitting one does not consume the other', () => {
        const guard = new IpcConnectionLoadGuard();
        const now = 1_000;
        // Exhaust the in-flight cap with a non-probe command.
        for (let i = 0; i < IPC_MAX_INFLIGHT_PER_CONNECTION; i++) {
            expect(guard.tryAcquire(`filler_${i}`, now)).toBeNull();
        }
        const busy = guard.tryAcquire('get_status_metadata', now);
        expect(busy!.code).toBe(IPC_BUSY_ERROR_CODE);

        // Freeing in-flight slots lets the SAME probe command straight through —
        // the busy rejection above must not have consumed a token-bucket slot.
        for (let i = 0; i < IPC_MAX_INFLIGHT_PER_CONNECTION; i++) guard.release();
        expect(guard.tryAcquire('get_status_metadata', now)).toBeNull();
    });
});
