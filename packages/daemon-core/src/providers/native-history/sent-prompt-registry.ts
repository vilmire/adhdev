'use strict';

/**
 * Prompts each live session has sent to its CLI, keyed by the same instance id
 * the native-history read path carries. Content evidence for transcript
 * attribution: when two sessions share a workspace and the provider exposes no
 * session id up front (cursor, opencode), the transcript that contains a prompt
 * THIS session sent is its own — newest-mtime alone cross-binds both sessions
 * to one conversation (2026-10-05 provider matrix).
 */

const MAX_PROMPTS_PER_SESSION = 20;
const MIN_SNIPPET_CHARS = 8;
/**
 * Inputs shorter than MIN_SNIPPET_CHARS ("ok", "dd?", "응") are kept apart and
 * only ever matched EXACTLY against a whole user message, never as a substring
 * (2026-10-18: an antigravity session whose only prompts were "dd" and "dd?"
 * could never be bound to its conversation, so no reply ever showed).
 */
const MIN_SHORT_INPUT_CHARS = 2;
const MAX_SNIPPET_CHARS = 80;

const promptsByInstance = new Map<string, string[]>();
// Keep complete input separately: the first line is often a shared worker wrapper.
const inputsByInstance = new Map<string, string[]>();
const shortInputsByInstance = new Map<string, string[]>();

function normalizeInput(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** Ownership evidence must include the whole sent input, in one user record.
 * Shared inputs cannot distinguish their senders; only session-specific input
 * can establish ownership. The legacy snippet API remains unchanged.
 */
export function hasExclusiveSentInput(instanceId: string, userMessages: string[]): boolean {
    const id = instanceId.trim();
    if (!inputsByInstance.has(id) && !shortInputsByInstance.has(id)) return false;
    const users = userMessages.map(normalizeInput);
    let matchedOwner = '';
    for (const [sender, inputs] of inputsByInstance) {
        for (const input of inputs) {
            if (!users.some(user => user.includes(input))) continue;
            const shared = [...inputsByInstance].some(([otherId, otherInputs]) =>
                otherId !== sender && otherInputs.some(other => other.includes(input)));
            if (shared) continue;
            // One store containing distinct input from multiple owners is also
            // ambiguous, even if only one conversation UUID matches this reader.
            if (matchedOwner && matchedOwner !== sender) return false;
            matchedOwner = sender;
        }
    }
    // Short inputs: a whole user message equal to it, sent by no other session.
    const exact = new Set(users);
    for (const [sender, inputs] of shortInputsByInstance) {
        for (const input of inputs) {
            if (!exact.has(input)) continue;
            const shared = [...shortInputsByInstance].some(([otherId, otherInputs]) => otherId !== sender && otherInputs.includes(input));
            if (shared) continue;
            if (matchedOwner && matchedOwner !== sender) return false;
            matchedOwner = sender;
        }
    }
    return matchedOwner === id;
}

/** First non-empty line, whitespace-collapsed and capped — robust to the
 *  wrappers CLIs add around a prompt (timestamps, tags, trailing context). */
export function promptSnippet(text: string): string {
    const line = String(text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    return line.length >= MIN_SNIPPET_CHARS ? line.slice(0, MAX_SNIPPET_CHARS) : '';
}

export function recordSentPrompt(instanceId: string | undefined, text: string): void {
    const id = typeof instanceId === 'string' ? instanceId.trim() : '';
    const input = normalizeInput(String(text || ''));
    if (id && input.length >= MIN_SNIPPET_CHARS) {
        const inputs = inputsByInstance.get(id) ?? [];
        if (inputs[inputs.length - 1] !== input) inputs.push(input);
        if (inputs.length > MAX_PROMPTS_PER_SESSION) inputs.splice(0, inputs.length - MAX_PROMPTS_PER_SESSION);
        inputsByInstance.set(id, inputs);
    } else if (id && input.length >= MIN_SHORT_INPUT_CHARS) {
        const shorts = shortInputsByInstance.get(id) ?? [];
        if (!shorts.includes(input)) shorts.push(input);
        if (shorts.length > MAX_PROMPTS_PER_SESSION) shorts.splice(0, shorts.length - MAX_PROMPTS_PER_SESSION);
        shortInputsByInstance.set(id, shorts);
    }
    const snippet = promptSnippet(text);
    if (!id || !snippet) return;
    const list = promptsByInstance.get(id) ?? [];
    if (list[list.length - 1] !== snippet) list.push(snippet);
    if (list.length > MAX_PROMPTS_PER_SESSION) list.splice(0, list.length - MAX_PROMPTS_PER_SESSION);
    promptsByInstance.set(id, list);
}

export function sentPromptSnippets(instanceId: string | undefined): string[] {
    const id = typeof instanceId === 'string' ? instanceId.trim() : '';
    return id ? (promptsByInstance.get(id) ?? []).slice() : [];
}

export function hasRecordedSentInput(instanceId: string | undefined): boolean {
    const id = typeof instanceId === 'string' ? instanceId.trim() : '';
    if (!id) return false;
    return (inputsByInstance.get(id)?.length ?? 0) > 0
        || (shortInputsByInstance.get(id)?.length ?? 0) > 0
        || (promptsByInstance.get(id)?.length ?? 0) > 0;
}

/** True when `haystack` (raw transcript text or projected user messages)
 *  contains any of the snippets, as written or JSON-escaped. */
export function containsSentPrompt(haystack: string, snippets: string[]): boolean {
    if (!haystack || snippets.length === 0) return false;
    const flat = haystack.replace(/\s+/g, ' ');
    return snippets.some(s => flat.includes(s) || haystack.includes(JSON.stringify(s).slice(1, -1)));
}

export function releaseSentPrompts(instanceId: string | undefined): void {
    const id = typeof instanceId === 'string' ? instanceId.trim() : '';
    if (id) {
        promptsByInstance.delete(id);
        inputsByInstance.delete(id);
        shortInputsByInstance.delete(id);
    }
}

export function __resetSentPromptRegistry(): void {
    promptsByInstance.clear();
    inputsByInstance.clear();
    shortInputsByInstance.clear();
}
