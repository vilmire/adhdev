// A method taken off a terminal handle must stay safe after the handle itself
// is garbage-collected: `const get = t.getViewport; t = null; gc(); get()` used
// to dereference the freed native state and kill the process (SIGSEGV). Every
// method (legacy and viewport) owns a share of the native state, so a detached
// method keeps working until it is collected too. Each scenario runs in a child
// `node --expose-gc` so a crash is observed as a signal, not a test-runner death.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const indexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

function runChild(body) {
    const script = `
        const binding = require(${JSON.stringify(indexPath)});
        const turn = () => new Promise((resolve) => setImmediate(resolve));
        async function collect(isCollected) {
            for (let i = 0; i < 50 && !isCollected(); i++) { global.gc(); await turn(); }
            return isCollected();
        }
        (async () => { ${body} })().then(
            (result) => { console.log(JSON.stringify(result)); },
            (error) => { console.log(JSON.stringify({ thrown: error.message, code: error.code ?? null })); },
        );
    `;
    const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(result.signal, null, `child crashed with ${result.signal}\n${result.stderr}`);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').pop());
}

const ALL_METHODS = ['write', 'resize', 'formatPlainText', 'formatVT', 'getCursorPosition', 'getViewport', 'readRow', 'scrollViewport', 'dispose'];

it('every method survives collection of its owning handle', () => {
    const result = runChild(`
        let t = binding.createTerminal({ cols: 12, rows: 4, scrollback: 100 });
        const m = {};
        for (const name of ${JSON.stringify(ALL_METHODS)}) m[name] = t[name];
        // The native state used to be freed by the _native External's
        // finalizer, so wait until that object (and the handle) are collected.
        const gone = new Set();
        const registry = new FinalizationRegistry((name) => { gone.add(name); });
        registry.register(t, 'handle');
        registry.register(t._native, 'native');
        t = null;
        const collected = await collect(() => gone.size === 2);
        m.write('hello\\r\\n> FINAL');
        m.resize(14, 4);
        const out = {
            collected,
            plain: m.formatPlainText({ trim: true }),
            vt: typeof m.formatVT(),
            cursor: m.getCursorPosition(),
            viewportCursorRow: m.getViewport({ includeRows: 'cursor' }).lines[0].text,
            row: m.readRow(1).text,
        };
        m.scrollViewport('top');
        m.dispose();
        try { m.getViewport(); } catch (error) { out.afterDispose = error.code ?? error.message; }
        return out;
    `);
    assert.equal(result.collected, true, 'the owning handle was never collected; the scenario proves nothing');
    assert.equal(result.plain, 'hello\n> FINAL');
    assert.equal(result.vt, 'string');
    assert.deepEqual(result.cursor, { row: 1, col: 7 });
    assert.equal(result.viewportCursorRow, '> FINAL');
    assert.equal(result.row, '> FINAL');
    assert.equal(result.afterDispose, 'ERR_GHOSTTY_DISPOSED');
});

it('collecting every method and the handle releases the terminal without crashing', () => {
    const result = runChild(`
        let collectedCount = 0;
        const registry = new FinalizationRegistry(() => { collectedCount++; });
        for (let i = 0; i < 200; i++) {
            let t = binding.createTerminal({ cols: 8, rows: 2, scrollback: 10 });
            let get = t.getViewport;
            registry.register(get, i);
            if (i % 2) t.dispose();
            t = null;
            if (i % 3) {
                try { get(); } catch (error) { if (error.code !== 'ERR_GHOSTTY_DISPOSED') throw error; }
            }
            get = null;
        }
        await collect(() => collectedCount === 200);
        return { collectedCount };
    `);
    assert.equal(result.collectedCount, 200);
});
