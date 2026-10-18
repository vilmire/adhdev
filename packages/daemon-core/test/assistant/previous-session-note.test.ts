import { describe, expect, it } from 'vitest';
import { buildPreviousSessionNote, buildStallSignal, buildMissedReportsLine } from '../../src/assistant/assistant-relay-format.js';

/**
 * 2026-10-18: a relaunched assistant said "the history is empty, I can't tell
 * what you asked". The new session now gets the last owner requests + replies.
 */
describe('buildPreviousSessionNote', () => {
    it('keeps the owner and assistant turns, drops daemon-typed inputs, labels it context', () => {
        const note = buildPreviousSessionNote([
            { role: 'user', text: 'Deploy rc.20 after the tests pass' },
            { role: 'assistant', text: 'Queued the deploy for adhdev-cloud.' },
            { role: 'user', text: buildStallSignal('adhdev-cloud', { pending: 1, activeMissions: 16 }) },
            { role: 'user', text: `<pasted_content id="1">\n${buildMissedReportsLine([{ slug: 'x', count: 3 }])}` },
            { role: 'assistant', text: 'adhdev-cloud is still waiting on one task.' },
        ])!;
        expect(note.startsWith('[ADHDev previous session]')).toBe(true);
        expect(note).toContain('not new requests');
        expect(note).toContain('User: Deploy rc.20 after the tests pass');
        expect(note).toContain('You: adhdev-cloud is still waiting on one task.');
        expect(note).not.toContain('no progress for 30 min');
        expect(note).not.toContain('did not reach you');
    });

    it('is null when the owner said nothing, and clips long turns', () => {
        expect(buildPreviousSessionNote([{ role: 'assistant', text: 'hello' }])).toBeNull();
        const note = buildPreviousSessionNote([{ role: 'user', text: 'x'.repeat(1000) }])!;
        expect(note.length).toBeLessThan(600);
    });
});

describe('saved previous-session context in the registry', () => {
    it('keeps a valid snapshot and drops a malformed or oversized one', async () => {
        const { normalizeAssistantRegistryEntry } = await import('../../src/assistant/assistant-registry.js');
        const base = { cliType: 'claude-cli', workspace: '/w', createdAt: 1 };
        expect(normalizeAssistantRegistryEntry({ ...base, lastContext: { sessionId: 's1', text: 'note', at: 5 } })).toMatchObject({ lastContext: { sessionId: 's1', text: 'note', at: 5 } });
        expect(normalizeAssistantRegistryEntry({ ...base, lastContext: { sessionId: 's1', text: 'x'.repeat(9_000), at: 5 } })).not.toHaveProperty('lastContext');
        expect(normalizeAssistantRegistryEntry({ ...base, lastContext: { text: 'note' } })).not.toHaveProperty('lastContext');
    });
});
