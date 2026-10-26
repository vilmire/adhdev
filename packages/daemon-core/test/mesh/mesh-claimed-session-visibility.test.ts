import { describe, expect, it } from 'vitest';
import { stampLocalClaimedSession } from '../../src/mesh/mesh-queue-assignment.js';

// rc34 d49f221d C8: claiming a queued task with an EXISTING session hard-coded
// spawnedSessionVisibility 'hidden', ignoring the mesh policy that a fresh
// auto-launch honours — a mesh set to show worker sessions hid them anyway.
function stamp(policy: Record<string, unknown> | undefined) {
    let settings: Record<string, unknown> | undefined;
    const components = { instanceManager: { getInstance: () => ({ updateSettings: (s: Record<string, unknown>) => { settings = s; } }) } } as any;
    stampLocalClaimedSession(components, {
        meshId: 'mesh', nodeId: 'node', sessionId: 'session', providerType: 'codex-cli',
        task: { id: 'task' } as any, mesh: { id: 'mesh', policy }, node: { id: 'node' },
    });
    return settings;
}

describe('stampLocalClaimedSession visibility', () => {
    it('follows a mesh policy that shows coordinator-spawned sessions', () => {
        expect(stamp({ spawnedSessionVisibility: 'visible' })?.spawnedSessionVisibility).toBe('visible');
    });

    it('keeps the hidden default when the policy does not say otherwise', () => {
        expect(stamp(undefined)?.spawnedSessionVisibility).toBe('hidden');
        expect(stamp({})?.spawnedSessionVisibility).toBe('hidden');
    });
});
