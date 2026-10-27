import { describe, expect, it } from 'vitest';
import { GhosttyVtTerminalBackend } from '../../src/cli-adapters/terminal-backends/ghostty-vt-backend.js';

// rc34 d49f221d C10: getCursorPosition re-ran formatPlainText over the whole
// buffer (scrollback included) on every read, alongside getText and
// getTextWithScrollback in the same poll. The formatted rows are now reused
// until the terminal actually changes.
describe('GhosttyVtTerminalBackend formatted-row cache', () => {
    function backendWithCounter() {
        const backend = new GhosttyVtTerminalBackend({ rows: 5, cols: 40, scrollback: 1000 });
        const terminal = (backend as any).terminal;
        const original = terminal.formatPlainText.bind(terminal);
        let calls = 0;
        terminal.formatPlainText = (options?: { trim?: boolean }) => { calls++; return original(options); };
        return { backend, calls: () => calls };
    }

    it('formats once per write no matter how many reads follow, and re-formats after a write or resize', () => {
        const { backend, calls } = backendWithCounter();
        backend.write('line one\r\nline two\r\n');
        const text = backend.getText();
        backend.getCursorPosition();
        backend.getTextWithScrollback();
        backend.getText();
        expect(calls()).toBe(1);
        expect(text).toContain('line two');

        backend.write('line three\r\n');
        expect(backend.getText()).toContain('line three');
        backend.getCursorPosition();
        expect(calls()).toBe(2);

        backend.resize(6, 40);
        backend.getText();
        expect(calls()).toBe(3);
        backend.dispose();
    });
});
