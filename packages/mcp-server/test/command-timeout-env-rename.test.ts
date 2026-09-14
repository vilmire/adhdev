import assert from 'node:assert/strict';
import test from 'node:test';

import { getTimeoutMs } from '../src/transports/ipc.js';

/**
 * D2 follow-up — ADHDEV_IPC_COMMAND_TIMEOUT_MS env rename.
 *
 * getTimeoutMs()'s default-timeout env override is reused by LocalTransport
 * (HTTP to the standalone daemon, local.ts) as well as IpcTransport's own
 * WS path, so the old name — scoped to "IPC" — no longer describes what it
 * controls. ADHDEV_COMMAND_TIMEOUT_MS is the new neutral name; the old name
 * is kept as a fallback so an operator who already set it keeps working
 * unchanged. These tests only exercise a command with NO per-verb table
 * entry, since a registered verb's tier always wins over either env var.
 */

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(overrides)) {
        saved[key] = process.env[key];
        if (overrides[key] === undefined) delete process.env[key];
        else process.env[key] = overrides[key];
    }
    try {
        return fn();
    } finally {
        for (const key of Object.keys(overrides)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

const UNCLASSIFIED_VERB = 'some_unregistered_command_for_env_rename_test';

test('with neither env var set, an unregistered verb falls back to the 15s default', () => {
    withEnv({ ADHDEV_COMMAND_TIMEOUT_MS: undefined, ADHDEV_IPC_COMMAND_TIMEOUT_MS: undefined }, () => {
        assert.equal(getTimeoutMs(UNCLASSIFIED_VERB, ''), 15_000);
    });
});

test('the new ADHDEV_COMMAND_TIMEOUT_MS name is honored', () => {
    withEnv({ ADHDEV_COMMAND_TIMEOUT_MS: '5000', ADHDEV_IPC_COMMAND_TIMEOUT_MS: undefined }, () => {
        assert.equal(getTimeoutMs(UNCLASSIFIED_VERB, ''), 5_000);
    });
});

test('the legacy ADHDEV_IPC_COMMAND_TIMEOUT_MS name still works (backward compat)', () => {
    withEnv({ ADHDEV_COMMAND_TIMEOUT_MS: undefined, ADHDEV_IPC_COMMAND_TIMEOUT_MS: '7000' }, () => {
        assert.equal(getTimeoutMs(UNCLASSIFIED_VERB, ''), 7_000);
    });
});

test('when both are set, the new name takes precedence over the legacy one', () => {
    withEnv({ ADHDEV_COMMAND_TIMEOUT_MS: '3000', ADHDEV_IPC_COMMAND_TIMEOUT_MS: '9000' }, () => {
        assert.equal(getTimeoutMs(UNCLASSIFIED_VERB, ''), 3_000);
    });
});

test('a registered per-verb tier still wins over either env override', () => {
    withEnv({ ADHDEV_COMMAND_TIMEOUT_MS: '1', ADHDEV_IPC_COMMAND_TIMEOUT_MS: '1' }, () => {
        assert.equal(getTimeoutMs('clone_mesh_node', ''), 120_000);
    });
});
