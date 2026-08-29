/**
 * §8 unit 3 dirty trigger — design §5.2's "post-chat hook". `DaemonCommandRouter`
 * already has a "Post-chat command callback" for CHAT_COMMANDS
 * (send_chat/new_chat/switch_chat/set_mode/change_model), firing from a
 * single, transport-agnostic place regardless of which branch (ACP/PTY/
 * extension) `handleSendChat` took. This pins that the SAME site now also
 * calls `markTranscriptSessionDirty(targetSessionId)`.
 */
import { describe, expect, it, vi } from 'vitest';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import {
    __resetTranscriptProjectionForTests,
    configureTranscriptProjection,
} from '../../src/seqscribe/transcript-publisher.js';

function createRouter(handlerResult: any) {
    return new DaemonCommandRouter({
        commandHandler: { handle: vi.fn(async () => handlerResult) } as any,
        cliManager: {} as any,
        cdpManagers: new Map(),
        providerLoader: {} as any,
        instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
        detectedIdes: { value: [] },
        sessionRegistry: {} as any,
    });
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('post-chat command callback — marks the target session dirty for transcript projection', () => {
    it('send_chat with a targetSessionId triggers markDirty after the handler completes', async () => {
        __resetTranscriptProjectionForTests();
        const collectObservation = vi.fn().mockResolvedValue(null);
        configureTranscriptProjection({
            daemonId: () => 'daemon-1',
            writerId: () => 'writer-1',
            publishRevision: async () => {},
            collectObservation,
        });

        const router = createRouter({ success: true, sent: true });
        await router.execute('send_chat', { targetSessionId: 'sess-1', text: 'hi' });
        await flush();

        expect(collectObservation).toHaveBeenCalledWith('sess-1');
    });

    it('a non-chat command (e.g. list_chats) does not trigger markDirty', async () => {
        __resetTranscriptProjectionForTests();
        const collectObservation = vi.fn().mockResolvedValue(null);
        configureTranscriptProjection({
            daemonId: () => 'daemon-1',
            writerId: () => 'writer-1',
            publishRevision: async () => {},
            collectObservation,
        });

        const router = createRouter({ success: true, chats: [] });
        await router.execute('list_chats', { targetSessionId: 'sess-1' });
        await flush();

        expect(collectObservation).not.toHaveBeenCalled();
    });

    it('a chat command with no targetSessionId does not call markDirty for anything', async () => {
        __resetTranscriptProjectionForTests();
        const collectObservation = vi.fn().mockResolvedValue(null);
        configureTranscriptProjection({
            daemonId: () => 'daemon-1',
            writerId: () => 'writer-1',
            publishRevision: async () => {},
            collectObservation,
        });

        const router = createRouter({ success: true });
        await router.execute('send_chat', { text: 'hi' });
        await flush();

        expect(collectObservation).not.toHaveBeenCalled();
    });

    it('is a safe no-op when the projection service is unconfigured', async () => {
        __resetTranscriptProjectionForTests();
        const router = createRouter({ success: true, sent: true });
        await expect(router.execute('send_chat', { targetSessionId: 'sess-1', text: 'hi' })).resolves.toMatchObject({ success: true });
    });
});
