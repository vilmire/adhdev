import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodePtyTransportFactory, __setNodePtyLoaderForTests } from '../../src/cli-adapters/pty-transport.js';

/**
 * loadNodePty() memoizes a successful `require('node-pty')` (spawning the
 * native addon is expensive, so caching a HIT is correct), but it must NOT
 * memoize a failed one that isn't "package not installed" — a transient
 * native-load error must be retried on the next call, otherwise the daemon
 * wedges PTY spawning for its entire remaining lifetime after one bad load.
 *
 * node-pty is a native module; rather than trying to break the real addon we
 * inject a stub loader via the test-only __setNodePtyLoaderForTests seam.
 */
describe('pty-transport loadNodePty retry semantics', () => {
    afterEach(() => {
        __setNodePtyLoaderForTests(null);
    });

    it('retries on the next spawn after a non-module-not-found load failure', () => {
        const loader = vi.fn();
        loader.mockImplementationOnce(() => {
            // A transient/native-ABI failure — NOT "package not installed".
            const err: NodeJS.ErrnoException = new Error('bad_binding: incompatible ABI');
            err.code = 'ERR_DLOPEN_FAILED';
            throw err;
        });
        __setNodePtyLoaderForTests(loader);

        const factory = new NodePtyTransportFactory();

        expect(() => factory.spawn('echo', [], { cwd: '.', env: {}, cols: 80, rows: 24 })).toThrow(
            'node-pty is not installed',
        );

        // Second call: the loader now "succeeds". Because the first failure was
        // not memoized, this must actually retry the loader.
        loader.mockImplementationOnce(() => ({
            spawn: () => ({
                pid: 1234,
                onData: () => {},
                onExit: () => {},
                write: () => {},
                resize: () => {},
                kill: () => {},
            }),
        }));

        const transport = factory.spawn('echo', [], { cwd: '.', env: {}, cols: 80, rows: 24 });
        expect(transport.pid).toBe(1234);
        expect(loader).toHaveBeenCalledTimes(2);
    });

    it('permanently caches a genuine MODULE_NOT_FOUND (package not installed)', () => {
        const loader = vi.fn().mockImplementation(() => {
            const err: NodeJS.ErrnoException = new Error("Cannot find module 'node-pty'");
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        });
        __setNodePtyLoaderForTests(loader);

        const factory = new NodePtyTransportFactory();

        expect(() => factory.spawn('echo', [], { cwd: '.', env: {}, cols: 80, rows: 24 })).toThrow(
            'node-pty is not installed',
        );
        expect(() => factory.spawn('echo', [], { cwd: '.', env: {}, cols: 80, rows: 24 })).toThrow(
            'node-pty is not installed',
        );

        // The loader is not invoked again once MODULE_NOT_FOUND has been seen.
        expect(loader).toHaveBeenCalledTimes(1);
    });
});
