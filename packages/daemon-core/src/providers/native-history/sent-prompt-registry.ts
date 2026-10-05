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
const MAX_SNIPPET_CHARS = 80;

const promptsByInstance = new Map<string, string[]>();

/** First non-empty line, whitespace-collapsed and capped — robust to the
 *  wrappers CLIs add around a prompt (timestamps, tags, trailing context). */
export function promptSnippet(text: string): string {
    const line = String(text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    return line.length >= MIN_SNIPPET_CHARS ? line.slice(0, MAX_SNIPPET_CHARS) : '';
}

export function recordSentPrompt(instanceId: string | undefined, text: string): void {
    const id = typeof instanceId === 'string' ? instanceId.trim() : '';
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

/** True when `haystack` (raw transcript text or projected user messages)
 *  contains any of the snippets, as written or JSON-escaped. */
export function containsSentPrompt(haystack: string, snippets: string[]): boolean {
    if (!haystack || snippets.length === 0) return false;
    const flat = haystack.replace(/\s+/g, ' ');
    return snippets.some(s => flat.includes(s) || haystack.includes(JSON.stringify(s).slice(1, -1)));
}

export function releaseSentPrompts(instanceId: string | undefined): void {
    const id = typeof instanceId === 'string' ? instanceId.trim() : '';
    if (id) promptsByInstance.delete(id);
}

export function __resetSentPromptRegistry(): void {
    promptsByInstance.clear();
}
