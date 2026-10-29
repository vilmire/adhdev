/**
 * cursor-cli settled-screen final-answer scrape.
 *
 * cursor-agent's chat history is the on-disk agent-transcripts JSONL
 * (`chatMessagesOwnedExternally`), but that binding can be absent (a transcript
 * idle past the recency window, a sibling session holding it) and then the
 * completion gate used to force a weak `missing_final_assistant` emit with no
 * summary while the terminal plainly showed the finished answer
 * (2026-10 fleet member: worker stuck "generating…"). When the PTY screen is
 * demonstrably SETTLED — idle composer + context footer, no spinner / "ctrl+c
 * to stop" hint — the trailing answer block is trustworthy enough to finalize
 * from, so it is offered as the PTY-parsed assistant message.
 *
 * Trade-off (owner principle: convenience first, never silent): the screen only
 * holds one viewport, so a very long answer is clipped to its visible tail; the
 * provenance diagnostic already flags a PTY-scraped summary as possibly
 * truncated. Pure function of the screen text; mutates nothing.
 */
import type { ChatMessage } from '../../types.js';
import { stripAnsi } from './provider-failure-classifier.js';
import { sentPromptSnippets } from '../native-history/sent-prompt-registry.js';

// Same shapes the cursor-cli specs/1.0.json settled footer / spinner use. The
// footer is `<model> · N% [· M files edited]` then the workspace path, either
// on the next line or (wide terminals) after another ` · `.
const SETTLED_FOOTER = /^[ \t]*\S[^\n]*·\s*\d+(?:\.\d+)?%[^\n]*(?:\n[ \t]*(?:~|\/)|·[ \t]*(?:~|\/))/m;
const BUSY = /(?:^|\n)[ \t]*(?:[⠀-⣿]{1,4}[ \t]+[A-Z]|Working(?:[.…]+)?[ \t]*(?=\n|$))|(?:ctrl\+c|esc) to (?:cancel|interrupt|stop|skip)/i;
const COMPOSER = /^\s*→\s+(?:Add a follow-up|Plan, search, build anything)/i;
const CHROME = /^\s*(?:Cursor Agent|v\d+\.\d|Tip:|Run Everything|Auto|Plan|Ask)\b/i;
const TOOL_OR_DIFF = /^\s*(?:▎|(?:Edited|Editing|Created|Creating|Deleted|Deleting|Read|Reading|Ran|Running|Searched|Searching|Listed|Listing|Grepped|Globbed|Fetched|Fetching)\s+\S+(?:\s+[+-]\d+)*\s*$)/;
const MAX_CHARS = 4000;

/** The trailing answer block of a settled cursor screen, or [] when the screen
 *  is not settled idle / carries no answer after the last prompt or tool line. */
export function extractCursorScreenAssistantMessages(screenText: string, promptSnippets: string[] = []): ChatMessage[] {
    const text = stripAnsi(screenText || '').replace(/\r/g, '').replace(/\s+$/, '');
    const tail = text.split('\n').slice(-18).join('\n');
    if (!SETTLED_FOOTER.test(tail) || BUSY.test(tail)) return [];
    const lines = text.split('\n');
    let end = lines.findIndex(l => COMPOSER.test(l));
    if (end < 0) end = lines.length;
    const flat = promptSnippets.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const isPromptEcho = (l: string): boolean => {
        const t = l.replace(/^\s*→?\s*/, '').replace(/\s+/g, ' ').trim();
        return t.length >= 4 && flat.some(s => s.includes(t));
    };
    const block: string[] = [];
    for (let i = end - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (TOOL_OR_DIFF.test(line) || CHROME.test(line) || isPromptEcho(line)) break;
        block.unshift(line);
    }
    const content = block.map(l => l.replace(/\s+$/, '')).join('\n').replace(/^\s*\n+|\n+\s*$/g, '').trim();
    if (!content) return [];
    return [{
        role: 'assistant',
        kind: 'standard',
        content: content.length > MAX_CHARS ? content.slice(-MAX_CHARS) : content,
        source: 'assistant_text',
        userFacing: true,
        bubbleState: 'final',
    } as ChatMessage];
}

/** Adapter-facing wrapper: snapshot + this session's sent prompts, never throws. */
export function readSettledCursorScreen(snapshot: () => string, sessionId: string | undefined): ChatMessage[] {
    try {
        return extractCursorScreenAssistantMessages(snapshot(), sentPromptSnippets(sessionId || undefined));
    } catch {
        return [];
    }
}
