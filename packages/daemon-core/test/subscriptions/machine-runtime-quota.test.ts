/**
 * machine.runtime carries the plan-quota cache (2026-10-18): the machine list
 * and machine detail subscribe to it, and without quota in the push they kept
 * the first quota reading forever (an expired-token reading the session popup
 * had long replaced). A quota change is a change, so it is pushed.
 */
import { describe, expect, it, vi } from 'vitest';
import { DASHBOARD_WIRE_VERSION } from '@adhdev/mesh-shared';

let quota: Record<string, unknown> | undefined;
vi.mock('../../src/quota/index.js', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    readQuotaCacheWithRevalidate: () => quota,
}));

const { TopicSubscriptionRegistry } = await import('../../src/subscriptions/topic-registry.js');

describe('machine.runtime push includes quota', () => {
    it('sends the quota cache and pushes again when only quota changes', async () => {
        const sent: any[] = [];
        let clock = 1_000;
        const registry = new TopicSubscriptionRegistry(
            { send: (_c: string, _t: string, payload: unknown) => { sent.push(payload); return true; }, isDeliverable: () => true, isAlive: () => true },
            { now: () => clock },
        );
        registry.subscribe('conn-1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'machine.runtime', key: 'm', params: { intervalMs: 1_000 } } as any);

        quota = { 'antigravity-cli': { status: 'error', failureKind: 'auth_expired' } };
        await registry.flushNow('machine.runtime');
        expect(sent.at(-1)?.machine?.quota).toEqual(quota);

        quota = { 'antigravity-cli': { status: 'ok', windows: [] } };
        clock += 60_000;
        await registry.flushNow('machine.runtime');
        expect(sent).toHaveLength(2);
        expect(sent.at(-1)?.machine?.quota).toEqual(quota);
    });
});
