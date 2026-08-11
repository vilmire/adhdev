import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'path';

/**
 * loadGhosttyVtBinding() memoizes a successful native-addon require() (loading
 * is expensive and the addon is N-API/ABI-stable once resolved), but it must
 * NOT memoize a failure unless every candidate failed with MODULE_NOT_FOUND
 * (the binding is genuinely not installed). Any other failure — a transient
 * native-load error, a permission error — must be retried on the next call,
 * otherwise the daemon wedges this terminal backend unavailable for its
 * entire remaining lifetime after one bad load.
 *
 * We point ADHDEV_GHOSTTY_VT_BINDING at a local fixture module (rather than
 * trying to break the real addon) and drive its behavior via an env var the
 * fixture reads on each (re-)evaluation.
 */
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'ghostty-vt-binding-fixture.cjs');

describe('ghostty-vt-backend loadGhosttyVtBinding retry semantics', () => {
    let savedBindingEnv: string | undefined;
    let savedModeEnv: string | undefined;

    beforeEach(() => {
        savedBindingEnv = process.env.ADHDEV_GHOSTTY_VT_BINDING;
        savedModeEnv = process.env.ADHDEV_GHOSTTY_VT_TEST_FIXTURE_MODE;
        process.env.ADHDEV_GHOSTTY_VT_BINDING = FIXTURE_PATH;
        delete require.cache[require.resolve(FIXTURE_PATH)];
    });

    afterEach(() => {
        if (savedBindingEnv === undefined) delete process.env.ADHDEV_GHOSTTY_VT_BINDING;
        else process.env.ADHDEV_GHOSTTY_VT_BINDING = savedBindingEnv;
        if (savedModeEnv === undefined) delete process.env.ADHDEV_GHOSTTY_VT_TEST_FIXTURE_MODE;
        else process.env.ADHDEV_GHOSTTY_VT_TEST_FIXTURE_MODE = savedModeEnv;
        delete require.cache[require.resolve(FIXTURE_PATH)];
    });

    it('retries on the next construction after a non-module-not-found load failure', async () => {
        const { GhosttyVtTerminalBackend, __resetGhosttyVtBindingCacheForTests } = await import(
            '../../src/cli-adapters/terminal-backends/ghostty-vt-backend.js'
        );
        __resetGhosttyVtBindingCacheForTests();

        process.env.ADHDEV_GHOSTTY_VT_TEST_FIXTURE_MODE = 'transient_failure';
        expect(() => new GhosttyVtTerminalBackend({ cols: 80, rows: 24, scrollback: 0 })).toThrow(
            /ghostty-vt binding unavailable/,
        );

        // Second attempt: fixture now "succeeds". Because the first failure was
        // not memoized, this must actually re-require the module.
        delete require.cache[require.resolve(FIXTURE_PATH)];
        delete process.env.ADHDEV_GHOSTTY_VT_TEST_FIXTURE_MODE;

        const backend = new GhosttyVtTerminalBackend({ cols: 80, rows: 24, scrollback: 0 });
        expect(backend.getText()).toBe('');
    });

    it('permanently caches a genuine MODULE_NOT_FOUND (binding not installed)', async () => {
        const { GhosttyVtTerminalBackend, __resetGhosttyVtBindingCacheForTests } = await import(
            '../../src/cli-adapters/terminal-backends/ghostty-vt-backend.js'
        );
        __resetGhosttyVtBindingCacheForTests();

        process.env.ADHDEV_GHOSTTY_VT_TEST_FIXTURE_MODE = 'module_not_found';
        expect(() => new GhosttyVtTerminalBackend({ cols: 80, rows: 24, scrollback: 0 })).toThrow(
            /ghostty-vt binding unavailable/,
        );

        // Flip the fixture to "would succeed now" WITHOUT resetting the cache —
        // the memoized MODULE_NOT_FOUND failure must still be thrown, proving
        // it was cached rather than retried.
        delete require.cache[require.resolve(FIXTURE_PATH)];
        delete process.env.ADHDEV_GHOSTTY_VT_TEST_FIXTURE_MODE;

        expect(() => new GhosttyVtTerminalBackend({ cols: 80, rows: 24, scrollback: 0 })).toThrow(
            /ghostty-vt binding unavailable/,
        );
    });
});
