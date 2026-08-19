/**
 * SpecCliAdapter.interruptTurn() — delivery mode 'interrupt' (axis A of
 * M-INPUT-DELIVERY-MODE-AND-QUEUE).
 *
 * These lock the property that makes the feature honest: an interrupt either
 * writes the provider's real stop key to the PTY, or it reports ok:false. It
 * must never take the invokeScript('stop') shape of returning success while
 * writing nothing — which is what would happen for hermes-cli specs/4.0.json
 * (empty stop key) or outside the control's visible_when_state.
 */
import { describe, expect, it } from 'vitest';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { CTRL_C, ESC } from '../../../src/providers/spec/interrupt-capability.js';

type Dispatch = { kind: string; data?: string };

function makeAdapter(opts: {
    cliType?: string;
    stopKeys?: string | null;
    state?: 'idle' | 'generating' | 'approval';
    spawned?: boolean;
    exited?: boolean;
}): { adapter: any; dispatches: Dispatch[] } {
    const dispatches: Dispatch[] = [];
    const adapter = Object.create(SpecCliAdapter.prototype);
    const control_bar = opts.stopKeys === null
        ? []
        : [{ id: 'stop', label: 'Stop', visible_when_state: ['busy'], action: { type: 'send_keys', keys: opts.stopKeys ?? CTRL_C } }];
    Object.assign(adapter, {
        cliType: opts.cliType ?? 'claude-cli',
        cliName: opts.cliType ?? 'Claude Code',
        spawned: opts.spawned ?? true,
        exited: opts.exited ?? false,
        spec: { id: opts.cliType ?? 'claude-cli', name: 'x', control_bar },
        latestState: opts.state
            ? { id: opts.state, label: opts.state, title: null, status: opts.state }
            : null,
        driver: { dispatch: (event: Dispatch) => dispatches.push(event) },
    });
    return { adapter, dispatches };
}

const ptyWrites = (d: Dispatch[]) => d.filter(e => e.kind === 'pty_write').map(e => e.data);

describe('SpecCliAdapter.interruptTurn', () => {
    it('writes Ctrl-C to the PTY for a generating session', async () => {
        const { adapter, dispatches } = makeAdapter({ state: 'generating' });
        const r = await adapter.interruptTurn();
        expect(r.ok).toBe(true);
        expect(r.keyName).toBe('Ctrl-C');
        expect(ptyWrites(dispatches)).toEqual([CTRL_C]);
    });

    it('writes ESC for antigravity-cli', async () => {
        const { adapter, dispatches } = makeAdapter({
            cliType: 'antigravity-cli', stopKeys: ESC, state: 'generating',
        });
        const r = await adapter.interruptTurn();
        expect(r.ok).toBe(true);
        expect(r.keyName).toBe('ESC');
        expect(ptyWrites(dispatches)).toEqual([ESC]);
    });

    // ★ the core no-silent-success property
    it('★ refuses and writes NOTHING when the stop key is empty (hermes-cli 4.0)', async () => {
        const { adapter, dispatches } = makeAdapter({
            cliType: 'hermes-cli', stopKeys: '', state: 'generating',
        });
        const r = await adapter.interruptTurn();
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('stop_keys_empty');
        expect(ptyWrites(dispatches)).toEqual([]);
    });

    it('★ refuses and writes NOTHING when no stop control is declared', async () => {
        const { adapter, dispatches } = makeAdapter({ stopKeys: null, state: 'generating' });
        const r = await adapter.interruptTurn();
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('no_stop_control');
        expect(ptyWrites(dispatches)).toEqual([]);
    });

    it('refuses to write a stray stop key at an idle prompt', async () => {
        const { adapter, dispatches } = makeAdapter({ state: 'idle' });
        const r = await adapter.interruptTurn();
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('not_busy');
        expect(ptyWrites(dispatches)).toEqual([]);
    });

    it('refuses when the session is not running', async () => {
        const { adapter, dispatches } = makeAdapter({ state: 'generating', exited: true });
        const r = await adapter.interruptTurn();
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('not_running');
        expect(ptyWrites(dispatches)).toEqual([]);
    });

    it('every refusal carries an operator-facing message', async () => {
        for (const opts of [
            { stopKeys: '', state: 'generating' as const },
            { stopKeys: null, state: 'generating' as const },
            { state: 'idle' as const },
            { state: 'generating' as const, exited: true },
        ]) {
            const { adapter } = makeAdapter(opts);
            const r = await adapter.interruptTurn();
            expect(r.ok).toBe(false);
            expect(typeof r.message).toBe('string');
            expect(r.message.length).toBeGreaterThan(0);
        }
    });

    it('reports declared-vs-proven confidence honestly', async () => {
        const proven = makeAdapter({ cliType: 'claude-cli', state: 'generating' });
        const declared = makeAdapter({ cliType: 'kimi', state: 'generating' });
        expect((await proven.adapter.interruptTurn()).confidence).toBe('proven');
        expect((await declared.adapter.interruptTurn()).confidence).toBe('declared');
    });

    it('getInterruptCapability is read-only — it never writes to the PTY', () => {
        const { adapter, dispatches } = makeAdapter({ state: 'generating' });
        const cap = adapter.getInterruptCapability();
        expect(cap.supported).toBe(true);
        expect(dispatches).toEqual([]);
    });
});
