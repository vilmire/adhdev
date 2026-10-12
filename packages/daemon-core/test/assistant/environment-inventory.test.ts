import { expect, it } from 'vitest';
import { environmentInventory, INVENTORY_STALE_MS } from '../../src/assistant/environment-inventory.js';
const now = 1000000;
const node = (id: string, facts?: any) => ({ id: 'n-' + id, daemonId: 'daemon_mach_' + id, nodeFacts: facts, policy: { slots: [{ provider: 'claude-cli', model: 'sonnet', maxParallel: 2, secret: 'slot-content' }] } });
it('projects every authorized daemon with stale/unknown/error/disabled installation and quota states without content', () => {
    const facts = { reportedAt: now - INVENTORY_STALE_MS - 1, providerVersions: { 'claude-cli': '1.2.3' },
        providerInventory: { observedAt: now, providers: { 'claude-cli': { installed: true }, 'missing-cli': { installed: false } } },
        providerEnablement: { 'claude-cli': { enabled: false, quotaEnabled: false } },
        quota: { 'claude-cli': { status: 'ok', updatedAt: 1, session: { usedPercent: 1, resetsAt: 4 }, metadata: { accountEmail: 'secret@example.test' }, error: 'secret-error' },
            'error-cli': { status: 'error', updatedAt: now, error: 'credentials body' } }, prompt: 'do not leak' };
    const view = environmentInventory([{ id: 'a', nodes: [node('one', facts), node('two')] } as any], now);
    expect(view.machines).toHaveLength(2); const one = view.machines[0];
    expect(one.freshness).toBe('stale'); expect(one.providers.find(p => p.provider === 'claude-cli')).toMatchObject({ installed: true, enabled: false, quota: { state: 'stale' } });
    expect(one.providers.find(p => p.provider === 'missing-cli')?.installed).toBe(false);
    expect(one.providers.find(p => p.provider === 'error-cli')?.quota.state).toBe('error');
    expect(view.machines[1].freshness).toBe('unknown');
    expect(one.nodes[0].slots).toEqual([{ providerType: 'claude-cli', model: 'sonnet', maxParallel: 2 }]);
    expect(JSON.stringify(view)).not.toMatch(/secret|credentials|do not leak|accountEmail|prompt/);
});
it('cross-mesh filters before projection; fresh local observation cannot make old quota current', () => {
    const authorized: any = { id: 'allowed', nodes: [node('a')] }; const foreign: any = { id: 'foreign', nodes: [node('b')] };
    const view = environmentInventory([authorized], now, { daemonId: authorized.nodes[0].daemonId, facts: { schemaVersion: 1, reportedAt: now, quota: { 'codex-cli': { status: 'ok', updatedAt: 1 } as any } } });
    expect(JSON.stringify(view)).not.toContain(foreign.nodes[0].daemonId);
    expect(view.machines[0].freshness).toBe('current'); expect(view.machines[0].providers.find(p => p.provider === 'codex-cli')?.quota.state).toBe('stale');
    expect(view.machines[0].providers[0].installed).toBe(null);
});
it('bounds all-daemon/provider projection and reports omitted facts', () => {
    const view = environmentInventory([{ id: 'a', nodes: Array.from({ length: 90 }, (_, i) => node(String(i))) } as any], now);
    expect(view.machines).toHaveLength(64); expect(view.omittedNodes).toBe(26);
});

it('reprojects remote inventory without nested content/error/account fields', async () => {
    const { observedInventoryMachine } = await import('../../src/assistant/environment-inventory.js');
    const machine = observedInventoryMachine({ daemonId: 'daemon_mach_a', reportedAt: now, text: 'secret', providers: [{ provider: 'cli', installed: true, prompt: 'secret', quota: { status: 'error', state: 'error', error: 'secret', accountEmail: 'secret' } }] });
    expect(JSON.stringify(machine)).not.toContain('secret'); expect(machine?.providers[0].quota.state).toBe('error');
});
