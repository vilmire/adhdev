import { describe, expect, it } from 'vitest';
import { isProviderQuestionBinding } from '../src/provider-question';

const binding = { transport: 'codex_rpc', sessionId: 'synthetic-session', generation: 'synthetic-generation',
    threadId: 'synthetic-thread', turnId: 'synthetic-turn', itemId: 'synthetic-item', requestId: 'synthetic-request' };

describe('native question binding shape', () => {
    it('accepts only exact RPC and async tuple fields', () => {
        expect(isProviderQuestionBinding(binding)).toBe(true);
        expect(isProviderQuestionBinding({ ...binding, requestId: 0 })).toBe(true);
        const { requestId: _requestId, ...tuple } = binding;
        expect(isProviderQuestionBinding({ ...tuple, transport: 'codex_async' })).toBe(true);
        for (const value of [null, [], {}, { ...binding, unexpected: true }, { ...binding, sessionId: '' },
            { ...binding, requestId: '' }, { ...binding, requestId: Infinity }, { ...binding, requestId: {} },
            { ...binding, transport: 'codex_async' }, { ...binding, transport: 'codex_async', requestId: undefined },
            { ...binding, transport: 'other' }, { ...binding, [Symbol('unknown')]: true }]) {
            expect(isProviderQuestionBinding(value)).toBe(false);
        }
    });
});
