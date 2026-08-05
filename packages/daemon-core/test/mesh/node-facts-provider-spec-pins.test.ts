import { describe, expect, it, vi, afterEach } from 'vitest';

// providerSpecPins — the field that makes a REMOTE node's provider pin knowable.
//
// Provider fixes do not propagate on their own: the verified-channel pin
// advances only on an explicit activation (deliberate — reproducibility,
// last-known-good, rollback; boot stays network-free). Before this field there
// was no way to ask a remote node which spec it loads, so a node that never
// adopted a published fix looked identical to one that had — which is how a
// shipped kimi resume fix stayed unadopted while nobody could tell.
//
// It is deliberately SEPARATE from providerVersions (the CLI BINARY version).
// A node can run kimi-code 1.2.3 while pinned to kimi spec 1.0.0. Folding them
// into one field is the multi-identifier confusion behind the canon-identity
// defect class.

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

async function factsWith(pins: Map<string, any> | null) {
    vi.resetModules();
    vi.doMock('../../src/detection/cli-detector.js', () => ({
        getProviderSpecPins: () => {
            if (!pins) throw new Error('store unreadable');
            const out: Record<string, string> = {};
            for (const [k, v] of pins) out[k] = v;
            return out;
        },
    }));
    const { buildLocalNodeFacts } = await import('../../src/mesh/node-facts.js');
    return buildLocalNodeFacts({ providerVersions: { kimi: '1.2.3-binary' } });
}

describe('providerSpecPins in the node facts bundle', () => {
    it('carries the pin, separate from the CLI binary version', async () => {
        const facts: any = await factsWith(new Map([['kimi', '1.0.3']]));
        expect(facts.providerSpecPins).toEqual({ kimi: '1.0.3' });
        // The two must not be conflated — this is the whole point.
        expect(facts.providerVersions).toEqual({ kimi: '1.2.3-binary' });
        expect(facts.providerSpecPins.kimi).not.toBe(facts.providerVersions.kimi);
    });

    it('omits the field entirely when there are no pins', async () => {
        // Absent means "this node reported no pin" — an empty object would read
        // as "it looked and found none", which is a different claim.
        const facts: any = await factsWith(new Map());
        expect(facts.providerSpecPins).toBeUndefined();
    });

    it('never fails the whole bundle when the store is unreadable', async () => {
        // The facts stamp is best-effort observability; a corrupt store must
        // not take out quota/build/platform reporting with it.
        const facts: any = await factsWith(null);
        expect(facts.providerSpecPins).toBeUndefined();
        expect(facts.schemaVersion).toBe(1);
        expect(facts.platform).toBeTruthy();
    });
});
