import type { ChatMessage } from '../../types.js';
import { parseAsyncQuestionReply, record } from './questions.js';

/** Native item identities stay stable across deltas and history hydration. */
export class CodexItemHistory {
    private items = new Map<string, ChatMessage>();
    private questionKeys = new Set<string>();
    read(): ChatMessage[] { return [...this.items.values()].sort((a, b) => (a.receivedAt ?? 0) - (b.receivedAt ?? 0)); }
    ephemeralQuestionMessageKeys(): string[] { return [...this.questionKeys]; }
    clear(): void { this.items.clear(); this.questionKeys.clear(); }
    item(threadId: string, turnId: string, value: unknown, receivedAt = Date.now()): void {
        const item = record(value);
        if (!item || typeof item.id !== 'string') return;
        const key = JSON.stringify(['codex', threadId, turnId, item.id]);
        const prior = this.items.get(key);
        let role = 'assistant';
        let kind = 'standard';
        let content = '';
        switch (item.type) {
            case 'agentMessage':
                content = typeof item.text === 'string' ? item.text : '';
                if (item.delivery === 'async' && Array.isArray(item.questions)) this.questionKeys.add(key);
                break;
            case 'userMessage': {
                role = 'user';
                content = Array.isArray(item.content) ? item.content.map(part => {
                    const p = record(part);
                    return p?.type === 'text' && typeof p.text === 'string' ? p.text : '';
                }).filter(Boolean).join('\n') : '';
                const replies = parseAsyncQuestionReply(item.content);
                if (replies) { this.questionKeys.add(key); content = replies.map(reply => `> ${reply.question}\n\n${reply.answer}`).join('\n\n'); }
                break;
            }
            case 'reasoning': kind = 'thought'; content = Array.isArray(item.summary) ? item.summary.join('\n') : ''; break;
            case 'functionCallOutput':
                if (item.name === 'request_user_input' || item.name === 'request_user_input_async') this.questionKeys.add(key);
                kind = 'tool'; content = typeof item.output === 'string' ? item.output : Array.isArray(item.output)
                    ? item.output.map(part => { const p = record(part); return p?.type === 'input_text' && typeof p.text === 'string' ? p.text : ''; }).filter(Boolean).join('\n') : '';
                break;
            case 'commandExecution': kind = 'tool'; content = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : String(item.command ?? ''); break;
            case 'plan': content = typeof item.text === 'string' ? item.text : ''; break;
            default: return;
        }
        this.items.set(key, { role, kind, content, providerUnitKey: key, _turnKey: turnId,
            receivedAt: prior?.receivedAt ?? receivedAt, timestamp: prior?.timestamp ?? receivedAt });
    }
    delta(threadId: string, turnId: string, itemId: string, delta: string): void {
        const key = JSON.stringify(['codex', threadId, turnId, itemId]);
        const prior = this.items.get(key);
        this.item(threadId, turnId, { id: itemId, type: 'agentMessage', text: String(prior?.content ?? '') + delta });
    }
    hydrate(thread: unknown): void {
        const t = record(thread);
        if (!t || typeof t.id !== 'string' || !Array.isArray(t.turns)) throw new Error('Invalid Codex history');
        for (const value of t.turns) {
            const turn = record(value);
            if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items)) throw new Error('Invalid Codex history turn');
            for (const item of turn.items) {
                const key = JSON.stringify(['codex', t.id, turn.id, record(item)?.id]);
                // A history response must not roll back a newer streamed item.
                if (!this.items.has(key)) this.item(t.id, turn.id, item, typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : Date.now());
            }
        }
    }
}
