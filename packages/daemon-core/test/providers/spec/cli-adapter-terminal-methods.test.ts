/**
 * SpecCliAdapter — MESH-READ-TERMINAL (getTerminalScreenSnapshot) and
 * MESH-SEND-KEYS (injectKeys) on the native-source spec path.
 *
 * Regression (SPECADAPTER-TERMINAL-METHODS, observed 2026-07-17): the stall
 * intervention trio (watchdog / read_terminal / send_keys) had only landed on
 * ProviderCliAdapter. On the spec-driven path (SpecCliAdapter — claude-cli /
 * antigravity / codex-cli) mesh_read_terminal threw
 * `this.adapter.getTerminalScreenSnapshot is not a function` and mesh_send_keys
 * threw `this.adapter.injectKeys is not a function`, so a coordinator could NOT
 * read a wedged worker's screen or inject keys — the stall detect→intervene
 * pipeline was half-working for spec providers. These tests assert the two
 * methods now take the real snapshot / injection path (viewport bytes flow, keys
 * write to the PTY, modal fail-closed holds), not a no-op stub.
 */
import { describe, expect, it } from 'vitest';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';

type Dispatch = { kind: string; data?: string };

function makeAdapter(opts: {
    screen: string;
    cursor?: { row: number; col: number };
    size?: { cols: number; rows: number };
    state?: 'idle' | 'generating' | 'approval';
    spawned?: boolean;
    exited?: boolean;
    /**
     * Parsed modal buttons, as the driver's `state_changed` would have supplied
     * them. APPROVAL-DEADLOCK: the send_keys modal guard arms on an ACTIONABLE
     * modal — a modal state whose buttons actually parsed — because that is
     * exactly when mesh_approve has something to press. An `approval` state
     * therefore defaults to a parsed 2-button modal here (the normal case);
     * pass `modalButtons: []` to model the unparseable modal that used to wedge
     * a session with no way to answer it.
     */
    modalButtons?: { index: number; label: string }[];
}): { adapter: any; dispatches: Dispatch[] } {
    const dispatches: Dispatch[] = [];
    const adapter = Object.create(SpecCliAdapter.prototype);
    const buttons = opts.modalButtons
        ?? (opts.state === 'approval' ? [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }] : []);
    Object.assign(adapter, {
        cliType: 'claude-cli',
        cliName: 'Claude Code',
        spawned: opts.spawned ?? true,
        exited: opts.exited ?? false,
        latestState: opts.state
            ? { id: opts.state, label: opts.state, title: null, status: opts.state }
            : null,
        latestModal: buttons.length > 0 ? { title: null, buttons, kind: 'approval' } : null,
        driver: {
            snapshot: () => opts.screen,
            getCursorPosition: () => opts.cursor ?? { row: 0, col: 0 },
            getScreenSize: () => opts.size ?? { cols: 80, rows: 24 },
            dispatch: (event: Dispatch) => dispatches.push(event),
        },
    });
    return { adapter, dispatches };
}

const pty = (d: Dispatch[]) => d.filter(e => e.kind === 'pty_write').map(e => e.data);

describe('SpecCliAdapter — getTerminalScreenSnapshot (MESH-READ-TERMINAL)', () => {
    it('returns the live viewport, cursor, geometry and a stable hash', () => {
        const screen = '⏺ line one\n✳ Tinkering… (1m · ↓ 4.0k tokens)\n❯';
        const { adapter } = makeAdapter({ screen, cursor: { row: 2, col: 3 }, size: { cols: 100, rows: 30 } });

        const snap = adapter.getTerminalScreenSnapshot();

        expect(snap.text).toBe(screen);
        expect(snap.cursor).toEqual({ col: 3, row: 2 });
        expect(snap.cols).toBe(100);
        expect(snap.rows).toBe(30);
        expect(snap.truncated).toBe(false);
        expect(snap.returnedBytes).toBe(Buffer.byteLength(screen, 'utf8'));
        expect(snap.hash).toMatch(/^[0-9a-f]{16}$/);
        // The hash tracks the FULL viewport so a caller can detect a screen change.
        const again = adapter.getTerminalScreenSnapshot();
        expect(again.hash).toBe(snap.hash);
    });

    it('byte-bounds the payload with bottom-tail preservation when over the cap', () => {
        const big = Array.from({ length: 400 }, (_, i) => `row ${i} ${'x'.repeat(40)}`).join('\n');
        const { adapter } = makeAdapter({ screen: big });

        const snap = adapter.getTerminalScreenSnapshot(2048);

        expect(snap.truncated).toBe(true);
        expect(snap.returnedBytes).toBeLessThanOrEqual(2048);
        expect(snap.originalBytes).toBe(Buffer.byteLength(big, 'utf8'));
        // Bottom-tail preserved: the LAST rows survive truncation (the live tail).
        expect(snap.text).toContain('row 399');
        expect(snap.text).not.toContain('row 0 ');
    });

    it('degrades cleanly to 0×0 geometry when the driver has no getScreenSize', () => {
        const { adapter } = makeAdapter({ screen: 'hello' });
        delete adapter.driver.getScreenSize;

        const snap = adapter.getTerminalScreenSnapshot();

        expect(snap.text).toBe('hello');
        expect(snap.cols).toBe(0);
        expect(snap.rows).toBe(0);
    });
});

describe('SpecCliAdapter — injectKeys (MESH-SEND-KEYS)', () => {
    it('writes a structured text+ENTER sequence to the PTY in one atomic dispatch', async () => {
        const { adapter, dispatches } = makeAdapter({ screen: '❯', state: 'idle' });

        const res = await adapter.injectKeys([{ text: 'hello world' }, { key: 'ENTER' }]);

        expect(res.ok).toBe(true);
        expect(res.submits).toBe(true);
        expect(res.bytes).toBeGreaterThan(0);
        // One contiguous write — text and its submitting CR are never separated.
        expect(pty(dispatches)).toHaveLength(1);
        expect(pty(dispatches)[0]).toContain('hello world');
        expect(pty(dispatches)[0]!.endsWith('\r')).toBe(true);
    });

    it('encodes named keys (arrows / TAB) to their control sequences', async () => {
        const { adapter, dispatches } = makeAdapter({ screen: '❯', state: 'idle' });

        const res = await adapter.injectKeys([{ key: 'DOWN' }, { key: 'ENTER' }]);

        expect(res.ok).toBe(true);
        expect(res.keys).toEqual(['DOWN', 'ENTER']);
        expect(pty(dispatches)[0]).toBe('\x1b[B\r');
    });

    it('is refused while generating so an active turn cannot consume buffered input', async () => {
        const { adapter, dispatches } = makeAdapter({ screen: '✳ Tinkering…', state: 'generating' });

        const res = await adapter.injectKeys([{ text: 'please stop' }, { key: 'ENTER' }]);

        expect(res.ok).toBe(false);
        expect(res.refused).toBe('generating');
        expect(res.message).toContain("mesh_send_task with delivery_mode: 'interrupt'");
        expect(pty(dispatches)).toEqual([]);
    });

    it('★allows a DESTRUCTIVE key (ESC) past the generating gate — the manual escape hatch', async () => {
        // A session wedged on an unanswerable first-run screen (antigravity's
        // colour-scheme / Terms-of-Service TUI) reports `generating` while
        // making zero model calls. mesh_send_task's interrupt path needs a real
        // turn to interrupt, so ESC/CTRL_C through send_keys is the ONLY way a
        // coordinator can free it. The method's doc comment always claimed
        // destructive keys pass this gate; for a while the code did not.
        const { adapter, dispatches } = makeAdapter({ screen: 'Choose your color scheme:', state: 'generating' });

        const res = await adapter.injectKeys([{ key: 'ESC' }]);

        expect(res.ok).toBe(true);
        expect(res.hasDestructive).toBe(true);
        expect(pty(dispatches)[0]).toBe('\x1b');
    });

    it('★still refuses a NON-destructive key while generating (the exemption is destructive-only)', async () => {
        // Guards the exemption above from widening into "send_keys works during
        // a turn", which would let text sit buffered until the turn ends.
        const { adapter, dispatches } = makeAdapter({ screen: '✳ Tinkering…', state: 'generating' });

        const res = await adapter.injectKeys([{ key: 'DOWN' }, { key: 'ENTER' }]);

        expect(res.ok).toBe(false);
        expect(res.refused).toBe('generating');
        expect(pty(dispatches)).toEqual([]);
    });

    it('is refused (fail-closed) for a non-destructive injection while an approval modal is open', async () => {
        const { adapter, dispatches } = makeAdapter({ screen: '❯ 1. Yes', state: 'approval' });

        const res = await adapter.injectKeys([{ key: 'ENTER' }]);

        expect(res.ok).toBe(false);
        expect(res.refused).toBe('actionable_modal');
        // Nothing was written — the modal choice must go through mesh_approve.
        expect(pty(dispatches)).toEqual([]);
    });

    it('APPROVAL-DEADLOCK: allows a non-destructive key when the modal parsed NO buttons', async () => {
        // Live defect (2026-09-20, grok-cli trust + antigravity-cli permission
        // prompt): the guard armed on `status === 'approval'` alone, which
        // statusForState() reports for ANY modal state regardless of whether
        // buttons parsed — while mesh_approve can only press a button that DID
        // parse. An unparseable modal therefore armed the guard and disarmed
        // approve simultaneously, leaving the session with zero ways to answer
        // the prompt on screen:
        //     mesh_approve   → "the modal could not be actioned"
        //     mesh_send_keys → "refused: actionable_modal"
        // The guard now arms only on an ACTIONABLE modal, so send_keys stays
        // available as the escape hatch precisely when approve cannot act.
        const { adapter, dispatches } = makeAdapter({
            screen: 'Do you trust the contents of this directory?\n  Yes, proceed   y',
            state: 'approval',
            modalButtons: [],
        });

        const res = await adapter.injectKeys([{ text: 'y' }]);

        expect(res.ok).toBe(true);
        // The keystroke must actually reach the PTY — an "allowed" result that
        // wrote nothing would leave the same deadlock in place.
        expect(pty(dispatches).join('')).toBe('y');
    });

    it('allows a DESTRUCTIVE key (CTRL_C) past the modal gate — it dismisses, not confirms', async () => {
        const { adapter, dispatches } = makeAdapter({ screen: '❯ 1. Yes', state: 'approval' });

        const res = await adapter.injectKeys([{ key: 'CTRL_C' }]);

        expect(res.ok).toBe(true);
        expect(res.hasDestructive).toBe(true);
        expect(pty(dispatches)[0]).toBe('\x03');
    });

    it('allows a non-destructive injection on an open modal when allowModalOverride is set', async () => {
        const { adapter, dispatches } = makeAdapter({ screen: '❯ 1. Yes', state: 'approval' });

        const res = await adapter.injectKeys([{ key: 'ENTER' }], { allowModalOverride: true });

        expect(res.ok).toBe(true);
        expect(pty(dispatches)[0]).toBe('\r');
    });

    it('throws a clean error when the session is not running', async () => {
        const { adapter } = makeAdapter({ screen: '', spawned: false });

        await expect(adapter.injectKeys([{ text: 'x' }])).rejects.toThrow(/not running/);
    });
});
