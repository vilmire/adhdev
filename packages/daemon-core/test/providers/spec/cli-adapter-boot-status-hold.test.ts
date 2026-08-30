/**
 * AGY-STATE-EMISSION (M-MESH-INFRA-0829): SpecCliAdapter must not project
 * boot-phase FSM states onto the daemon status machine until maybeMarkReady.
 *
 * Live: antigravity-cli starting.status='idle' + signing_in.status='generating'.
 * Projecting those before the prompt is drawn consumed agent:ready too early
 * and armed a false generating_started that never completed.
 */
import { describe, expect, it } from 'vitest';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';

function makeAdapter(opts: {
    ready: boolean | undefined;
    stateId: string;
    stateStatus: 'idle' | 'generating' | 'approval';
}): any {
    const adapter = Object.create(SpecCliAdapter.prototype);
    Object.assign(adapter, {
        cliType: 'antigravity-cli',
        cliName: 'Antigravity CLI',
        spawned: true,
        exited: false,
        kimiAuthBillingFailure: null,
        activeInteractivePrompt: null,
        latestState: { id: opts.stateId, label: opts.stateId, title: null, status: opts.stateStatus },
        latestModal: null,
        spec: { id: 'antigravity-cli', name: 'Antigravity CLI' },
        driver: {
            hasSeenReady: opts.ready === undefined ? undefined : () => opts.ready,
        },
        providerSessionId: undefined,
    });
    return adapter;
}

describe('SpecCliAdapter — boot-status hold until fsmReadySeen', () => {
    it('holds starting while the initial FSM state declares status idle (prompt not drawn)', () => {
        const adapter = makeAdapter({ ready: false, stateId: 'starting', stateStatus: 'idle' });
        const status = adapter.getStatus();
        expect(status.status).toBe('starting');
        expect(status.fsmReadySeen).toBe(false);
    });

    it('holds starting through antigravity signing_in (status generating) so it cannot arm generating_started', () => {
        const adapter = makeAdapter({ ready: false, stateId: 'signing_in', stateStatus: 'generating' });
        const status = adapter.getStatus();
        expect(status.status).toBe('starting');
        expect(status.fsmReadySeen).toBe(false);
    });

    it('still surfaces a boot-time trust/approval modal (must not hide consent as starting)', () => {
        const adapter = makeAdapter({ ready: false, stateId: 'trust', stateStatus: 'approval' });
        adapter.latestModal = {
            title: 'Do you trust the files in this folder?',
            buttons: [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }],
            kind: 'approval',
        };
        const status = adapter.getStatus();
        expect(status.status).toBe('waiting_approval');
        expect(status.activeModal?.buttons).toEqual(['Yes', 'No']);
    });

    it('reports idle + fsmReadySeen once the prompt is drawn', () => {
        const adapter = makeAdapter({ ready: true, stateId: 'idle', stateStatus: 'idle' });
        const status = adapter.getStatus();
        expect(status.status).toBe('idle');
        expect(status.fsmReadySeen).toBe(true);
    });

    it('reports generating for a real busy state after ready', () => {
        const adapter = makeAdapter({ ready: true, stateId: 'busy', stateStatus: 'generating' });
        expect(adapter.getStatus().status).toBe('generating');
    });

    it('does not gate stub/legacy drivers that omit hasSeenReady (previous projection)', () => {
        const idle = makeAdapter({ ready: undefined, stateId: 'starting', stateStatus: 'idle' });
        expect(idle.getStatus().status).toBe('idle');
        const busy = makeAdapter({ ready: undefined, stateId: 'signing_in', stateStatus: 'generating' });
        expect(busy.getStatus().status).toBe('generating');
    });
});
