import { randomUUID } from 'node:crypto';
import { isProviderQuestionBinding, type ProviderQuestionBinding } from '@adhdev/mesh-shared';
import type { InteractivePrompt, InteractivePromptResponse, InteractiveQuestion } from '../types/interactive-prompt.js';
import { assertNativeInteractivePromptResponse } from '../types/interactive-prompt.js';
import type { RpcId } from './transport.js';

type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 64_000;
const rpcKey = (id: RpcId) => `${typeof id}:${id}`;

export function parseAsyncQuestionReply(input: unknown): Array<{ questionItemId: string; question: string; answer: string }> | null {
    if (!Array.isArray(input)) return null;
    const content = input.filter(value => !['skill', 'mention'].includes(String(record(value)?.type)));
    if (content.length !== 1) return null;
    const part = record(content[0]);
    if (part?.type !== 'text' || typeof part.text !== 'string') return null;
    let replyText = part.text.trim();
    if (replyText.startsWith('# Context from my IDE setup:\n')) {
        const delimiter = '\n## My request for Codex:\n';
        const index = replyText.lastIndexOf(delimiter);
        if (index < 0) return null;
        replyText = replyText.slice(index + delimiter.length).trim();
    }
    const match = /^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/.exec(replyText);
    if (!match) return null;
    let replies: unknown;
    try { replies = JSON.parse(match[1]); } catch { return null; }
    const values = Array.isArray(replies) ? replies : [replies];
    if (!values.length || values.some(value => {
        const r = record(value);
        return !r || !text(r.questionItemId) || typeof r.question !== 'string' || typeof r.answer !== 'string';
    })) return null;
    return values as Array<{ questionItemId: string; question: string; answer: string }>;
}

/** Pending authority is the live owning connection, never historical function calls. */
export class CodexQuestionLedger {
    private entries = new Map<string, InteractivePrompt>();
    private seen = new Set<string>();
    threadId = '';
    turnId = '';
    constructor(readonly sessionId: string, readonly generation: string) {}

    beginTurn(turnId: string): void {
        if (this.turnId !== turnId) this.invalidate();
        this.turnId = turnId;
    }
    invalidate(): void { this.entries.clear(); this.turnId = ''; }
    active(): InteractivePrompt | null {
        return [...this.entries.values()].find(prompt => prompt.binding?.transport === 'codex_rpc')
            ?? this.entries.values().next().value ?? null;
    }

    capture(requestId: RpcId, raw: unknown): boolean {
        if (this.entries.size >= 32 || this.seen.size >= 4096) return false;
        const p = record(raw);
        if (!p || p.threadId !== this.threadId || p.turnId !== this.turnId || !text(p.itemId)
            || typeof p.isBlocking !== 'boolean' || !Array.isArray(p.questions) || !p.questions.length || p.questions.length > 32) return false;
        const key = `rpc:${rpcKey(requestId)}`;
        if (this.seen.has(key)) return false;
        const questions: InteractiveQuestion[] = [];
        for (const value of p.questions) {
            const q = record(value);
            if (!q || !text(q.id) || !text(q.question) || typeof q.header !== 'string'
                || typeof q.isOther !== 'boolean' || typeof q.isSecret !== 'boolean'
                || !(q.options === null || Array.isArray(q.options))) return false;
            const options = [];
            for (const value of (q.options as unknown[] | null) ?? []) {
                const option = record(value);
                if (!option || !text(option.label) || typeof option.description !== 'string') return false;
                options.push({ label: option.label, description: option.description });
            }
            if (options.length > 32 || new Set(options.map(o => o.label)).size !== options.length) return false;
            questions.push({ questionId: q.id, question: q.question, header: q.header, multiSelect: false,
                options, allowFreeform: q.isOther || !options.length, isSecret: q.isSecret, required: p.isBlocking });
        }
        if (new Set(questions.map(q => q.questionId)).size !== questions.length) return false;
        const binding: ProviderQuestionBinding = { transport: 'codex_rpc', sessionId: this.sessionId,
            generation: this.generation, threadId: this.threadId, turnId: this.turnId, itemId: p.itemId, requestId };
        this.seen.add(key);
        this.entries.set(key, this.prompt(binding, questions, p.isBlocking));
        return true;
    }

    captureAsync(itemId: string, turnId: string, raw: unknown): boolean {
        if (this.entries.size >= 32 || this.seen.size >= 4096) return false;
        const key = `async:${itemId}`;
        if (turnId !== this.turnId || this.seen.has(key) || !Array.isArray(raw) || !raw.length || raw.length > 32) return false;
        const questions: InteractiveQuestion[] = [];
        for (const [index, value] of raw.entries()) {
            const q = record(value);
            if (!q || !text(q.title) || !(q.options === null || Array.isArray(q.options))) return false;
            const labels = (q.options as unknown[] | null) ?? [];
            if (labels.length > 32 || labels.some(label => !text(label)) || new Set(labels).size !== labels.length) return false;
            const questionId = JSON.stringify(['request_user_input_async', itemId, index]);
            if (Buffer.byteLength(questionId) > 512) return false;
            questions.push({ questionId,
                question: q.title, options: (labels as string[]).map(label => ({ label })), multiSelect: false, allowFreeform: true, required: false });
        }
        this.seen.add(key);
        this.entries.set(key, this.prompt({ transport: 'codex_async', sessionId: this.sessionId, generation: this.generation,
            threadId: this.threadId, turnId, itemId }, questions));
        return true;
    }

    private prompt(binding: ProviderQuestionBinding, questions: InteractiveQuestion[], blocking = binding.transport === 'codex_rpc'): InteractivePrompt {
        return { promptId: randomUUID(), origin: 'cli', providerType: 'codex-cli', createdAt: Date.now(),
            binding, questions, blocking, lifecycle: 'pending', support: binding.transport === 'codex_rpc' ? 'request_bound' : 'product_local' };
    }

    resolve(threadId: unknown, requestId: unknown): void {
        if (threadId !== this.threadId || (typeof requestId !== 'string' && typeof requestId !== 'number')) return;
        this.entries.delete(`rpc:${rpcKey(requestId)}`);
    }

    /** Ordinary reply evidence retracts only identified async questions. */
    observeReply(input: unknown): void {
        const replies = parseAsyncQuestionReply(input);
        if (!replies) return;
        const ids = new Set(replies.map(value => value.questionItemId));
        for (const [key, prompt] of this.entries) {
            if (prompt.binding?.transport !== 'codex_async') continue;
            const remaining = prompt.questions.filter(q => !ids.has(q.questionId));
            if (!remaining.length) this.entries.delete(key);
            else if (remaining.length !== prompt.questions.length) this.entries.set(key, this.prompt(prompt.binding, remaining));
        }
    }

    prepare(response: InteractivePromptResponse): { key: string; prompt: InteractivePrompt; answers: Record<string, { answers: string[] }> } {
        assertNativeInteractivePromptResponse(response);
        const pair = [...this.entries].find(([, prompt]) => prompt.promptId === response.promptId);
        if (!pair) throw new Error('No current Codex question request');
        const [key, prompt] = pair;
        if (prompt.promptId !== this.active()?.promptId) throw new Error('Codex response is not for the current presented request');
        const binding = prompt.binding!;
        if (prompt.lifecycle !== 'pending' || binding.turnId !== this.turnId || binding.threadId !== this.threadId
            || !isProviderQuestionBinding(response.binding) || (Object.keys(binding) as Array<keyof ProviderQuestionBinding>).some(k => binding[k] !== response.binding![k])) {
            throw new Error('Stale or foreign Codex question episode');
        }
        if (response.action === 'dismiss' && binding.transport !== 'codex_async') throw new Error('Native RPC dismissal is unsupported');
        if (Object.keys(response.answers).some(id => !prompt.questions.some(q => q.questionId === id))) throw new Error('Unknown question id');
        const answers: Record<string, { answers: string[] }> = Object.create(null);
        for (const q of prompt.questions) {
            const answer = response.answers[q.questionId];
            const labels = answer?.selectedLabels ?? [];
            const free = answer?.freeformText?.trim();
            if (free && free.length > 64_000) throw new Error('Codex answer exceeds the supported input limit');
            if (labels.length > 1 || new Set(labels).size !== labels.length || labels.some(label => !q.options.some(o => o.label === label))
                || (free && !q.allowFreeform) || (free && labels.length)) throw new Error('Invalid Codex answer');
            if (!labels.length && !free && q.required && response.action !== 'dismiss') throw new Error('Required Codex answer missing');
            if (labels.length || free) answers[q.questionId] = { answers: free ? [free] : labels };
        }
        if (!Object.keys(answers).length && response.action !== 'dismiss') throw new Error('At least one answer required');
        return { key, prompt, answers };
    }

    reserve(key: string): void {
        const prompt = this.entries.get(key);
        if (!prompt || prompt.lifecycle !== 'pending') throw new Error('Question already submitted');
        this.entries.set(key, { ...prompt, lifecycle: 'submitted' });
    }
    dismiss(key: string): void { this.entries.delete(key); }
    uncertain(key: string): void {
        const prompt = this.entries.get(key);
        if (prompt) this.entries.set(key, { ...prompt, lifecycle: 'unknown', support: 'uncertain' });
    }
    asyncKeys(): string[] { return [...this.entries.keys()].filter(key => key.startsWith('async:')); }
    clearAsync(keys: string[]): void {
        for (const key of keys) this.entries.delete(key);
    }
}
