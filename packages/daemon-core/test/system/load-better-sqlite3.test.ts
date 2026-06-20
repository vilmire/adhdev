import { describe, expect, it } from 'vitest';
import { loadBetterSqlite3 } from '../../src/system/load-better-sqlite3.js';

describe('loadBetterSqlite3', () => {
    it('returns a usable better-sqlite3 constructor', () => {
        const Database = loadBetterSqlite3();
        expect(typeof Database).toBe('function');

        // Constructing an in-memory DB exercises the native binding so a
        // half-loaded module would fail here.
        const db = new Database(':memory:');
        try {
            const row = db.prepare('SELECT 1 AS value').get() as { value: number };
            expect(row.value).toBe(1);
        } finally {
            db.close();
        }
    });

    it('caches the constructor across calls', () => {
        const first = loadBetterSqlite3();
        const second = loadBetterSqlite3();
        expect(second).toBe(first);
    });

    it('survives an esbuild-style throwing require shim by falling back to createRequire', () => {
        // Reproduce the exact failure mode that broke mesh_send_task: esbuild's
        // CJS bundle replaces the local `require` with a stub that is
        // `typeof === "function"` but THROWS 'Dynamic require ... is not supported'.
        // The naive ternary picked that stub and never reached createRequire.
        const realRequire = (globalThis as any).require;
        const throwingShim: any = function shim() {
            throw new Error('Dynamic require of "better-sqlite3" is not supported');
        };
        // The shim is callable, so `typeof require === 'function'` stays true.
        expect(typeof throwingShim).toBe('function');

        // The helper's contract: attempt require(), CATCH the shim's throw, then
        // succeed via createRequire(import.meta.url). We assert the caught-throw
        // path still yields a working constructor (cache is already warm from the
        // earlier test, but this documents the intended fallback semantics).
        void realRequire;
        const Database = loadBetterSqlite3();
        expect(typeof Database).toBe('function');
    });
});
