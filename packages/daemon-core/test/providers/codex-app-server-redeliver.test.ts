import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodexAppServerAdapter } from '../../src/providers/codex-app-server/adapter.js';
import { createSessionInputService } from '../../src/sessions/session-input-service.js';
import { buildSessionInputTarget } from '../../src/sessions/session-input-target.js';

// Review 2d2823f3 P1-a (reviewer NATIVE_REPLAY), with the REAL native adapter:
// the codex app-server turn finishes back at idle, and a second submit of the
// same dispatch messageId — what any redelivery would be — must not start a
// second native turn. (The ledger's redeliver port no longer re-sends at all;
// this pins the input path beneath it.)
const producer = fileURLToPath(new URL('../fixtures/codex-question-producer.mjs', import.meta.url));
const message = {
    messageId: 'task:native:n0', sessionId: 'native-s1',
    input: { parts: [{ type: 'text' as const, text: 'complete-immediately' }], textFallback: 'complete-immediately' },
    origin: 'mesh' as const, policy: { mode: 'queue' as const }, createdAt: 1,
};

async function waitIdle(adapter: CodexAppServerAdapter): Promise<void> {
    for (let i = 0; i < 100 && adapter.getStatus().status !== 'idle'; i++) await new Promise((r) => setTimeout(r, 10));
}

describe('same-dispatch resubmit against the native codex app-server adapter', () => {
    it('does not start a second native turn for a message that already ran', async () => {
        const adapter = new CodexAppServerAdapter(process.cwd(), 'native-s1', process.execPath, [], {}, [producer]);
        try {
            await adapter.spawn();
            const target = buildSessionInputTarget({ adapter } as any)!;
            const svc = createSessionInputService({ resolveSession: () => target });
            expect(await svc.submit(message)).toMatchObject({ kind: 'delivered' });
            await waitIdle(adapter);
            expect(adapter.getStatus().status).toBe('idle');
            expect(await svc.submit({ ...message, redeliver: true } as any)).toEqual({ kind: 'duplicate', of: 'task:native:n0' });
            await waitIdle(adapter);
            const users = adapter.getScriptParsedStatus().messages.filter((m: any) => m.role === 'user');
            expect(users).toHaveLength(1);
        } finally {
            adapter.shutdown();
        }
    });
});
