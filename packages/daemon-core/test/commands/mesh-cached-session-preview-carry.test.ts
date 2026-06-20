import { describe, expect, it } from 'vitest';

import { readCachedInlineMeshActiveSessionDetails } from '../../src/commands/router';

// [T2] The coordinator's inbox-preview path reads the cached inline-mesh active-session
// entry. The remote worker's get_status_metadata snapshot already computes
// lastMessagePreview/lastMessageRole/lastMessageAt from its real transcript and now ships
// them through the mesh-tools session slim. readCachedInlineMeshActiveSessionDetails must
// carry these through so the coordinator no longer has to re-derive them from a live
// in-process instance it doesn't host for a remote worker — which always failed, leaving
// the mobile inbox stuck on the first dispatched USER task.

describe('readCachedInlineMeshActiveSessionDetails — preview carry-through ([T2])', () => {
    it('carries lastMessagePreview/lastMessageRole/lastMessageAt from the cached active session', () => {
        const node = {
            cachedStatus: {
                activeSession: {
                    id: 'sess_worker_1',
                    providerType: 'claude-cli',
                    status: 'idle',
                    lastMessagePreview: 'Done — refactored the auth module and added tests.',
                    lastMessageRole: 'assistant',
                    lastMessageAt: 1_700_000_000_000,
                },
            },
        };

        const [entry] = readCachedInlineMeshActiveSessionDetails(node);
        expect(entry.sessionId).toBe('sess_worker_1');
        expect(entry.lastMessagePreview).toBe('Done — refactored the auth module and added tests.');
        expect(entry.lastMessageRole).toBe('assistant');
        expect(entry.lastMessageAt).toBe(1_700_000_000_000);
    });

    it('accepts snake_case field names from alternate serialization paths', () => {
        const node = {
            activeSession: {
                sessionId: 'sess_worker_2',
                provider_type: 'codex-cli',
                state: 'idle',
                last_message_preview: 'Patched the bug.',
                last_message_role: 'assistant',
                last_message_at: 1_700_000_500_000,
            },
        };

        const [entry] = readCachedInlineMeshActiveSessionDetails(node);
        expect(entry.lastMessagePreview).toBe('Patched the bug.');
        expect(entry.lastMessageRole).toBe('assistant');
        expect(entry.lastMessageAt).toBe(1_700_000_500_000);
    });

    it('omits the preview fields entirely when the worker reported none (no empty stamps)', () => {
        const node = {
            cachedStatus: {
                activeSession: { id: 'sess_worker_3', providerType: 'claude-cli', status: 'generating' },
            },
        };

        const [entry] = readCachedInlineMeshActiveSessionDetails(node);
        expect(entry.sessionId).toBe('sess_worker_3');
        expect('lastMessagePreview' in entry).toBe(false);
        expect('lastMessageRole' in entry).toBe(false);
        expect('lastMessageAt' in entry).toBe(false);
    });
});
