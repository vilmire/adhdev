import { describe, expect, it, vi } from 'vitest';
import { normalizeInteractivePromptResponse, resolveInteractivePromptResponse, type InteractivePrompt } from '../../src/providers/types/interactive-prompt.js';
import { applyInteractivePromptAnswer, applyInteractivePromptAnswerFireAndForget } from '../../src/providers/interactive-prompt-apply.js';

const response = { promptId: 'synthetic-prompt', binding: { transport: 'codex_rpc' as const,
    sessionId: 'synthetic-session', generation: 'synthetic-generation', threadId: 'synthetic-thread',
    turnId: 'synthetic-turn', itemId: 'synthetic-item', requestId: 'synthetic-request' },
    answers: { q: { selectedLabels: ['One'] } } };
const prompt: InteractivePrompt = { promptId: response.promptId, binding: response.binding, origin: 'cli',
    providerType: 'codex-cli', createdAt: 1, questions: [{ questionId: 'q', question: 'Synthetic question',
        multiSelect: false, options: [{ label: 'One' }] }] };

describe('native question validation before common normalization', () => {
    it('rejects unsupported fields/actions and malformed shapes before adapter dispatch', async () => {
        const adapter = { setInteractivePromptResponse: vi.fn(async () => {}) };
        for (const raw of [{ ...response, action: 'cancel' }, { ...response, action: 'arbitrary' },
            { ...response, action: null }, { ...response, unexpected: true },
            { ...response, binding: { ...response.binding, unexpected: true } },
            { ...response, binding: null }, { ...response, binding: [] },
            { ...response, answers: { q: { selectedLabels: ['One'], unexpected: true } } },
            { ...response, answers: { q: null } }, { ...response, answers: { q: [] } },
            { ...response, answers: { q: { selectedLabels: [1] } } },
            { ...response, answers: { q: { selectedLabels: ['One', 'One'] } } },
            { ...response, answers: { q: { selectedLabels: [], freeformText: 1 } } },
            { ...response, answers: [] }, null, []]) {
            expect(() => normalizeInteractivePromptResponse(raw)).toThrow();
            expect(() => resolveInteractivePromptResponse(prompt, raw)).toThrow();
            await expect(applyInteractivePromptAnswer({ held: prompt, data: raw, adapter, providerType: 'codex-cli' })).rejects.toThrow();
            expect(applyInteractivePromptAnswerFireAndForget({ held: prompt, data: raw, adapter, providerType: 'codex-cli' })).toBe(prompt);
        }
        expect(adapter.setInteractivePromptResponse).not.toHaveBeenCalled();
        expect(normalizeInteractivePromptResponse(response)).toEqual(response);
        await applyInteractivePromptAnswer({ held: prompt, data: response, adapter, providerType: 'codex-cli' });
        expect(adapter.setInteractivePromptResponse).toHaveBeenCalledExactlyOnceWith(response);
    });

    it('keeps legacy Claude normalization separate and supports only async local dismissal', () => {
        const { binding: _binding, ...legacy } = response;
        expect(normalizeInteractivePromptResponse({ ...legacy, action: 'cancel', unexpected: true,
            answers: { q: { selectedLabels: [' One '], unexpected: true } } })).toEqual(legacy);
        expect(() => normalizeInteractivePromptResponse({ ...response, action: 'dismiss' })).toThrow();
        const { requestId: _requestId, ...tuple } = response.binding;
        const dismiss = { ...response, binding: { ...tuple, transport: 'codex_async' }, answers: {}, action: 'dismiss' };
        expect(normalizeInteractivePromptResponse(dismiss)).toEqual(dismiss);
    });
});
