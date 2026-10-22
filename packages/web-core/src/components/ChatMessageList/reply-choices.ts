/**
 * reply-choices — the answer buttons under an assistant question.
 *
 * The assistant prompt (daemon-core assistant-prompt.ts, Style) asks it to end
 * a question that has a few fixed answers with ONE last line:
 *   [[choices: Bring DesktopA online | Stop the migration]]
 * The line is never shown; the chat offers the options as buttons under the
 * latest assistant message, and a tap sends that option as the owner's reply.
 *
 * Pure: no React, no i18n.
 */

const CHOICES_LINE = /^\s*\[\[\s*choices\s*:\s*(.+?)\s*\]\]\s*$/i;
const MAX_CHOICES = 5;
const MAX_CHOICE_CHARS = 80;

export interface ReplyChoices {
    /** The message text without the choices line. */
    text: string;
    choices: string[];
}

export function extractReplyChoices(text: string): ReplyChoices {
    if (!text || !text.includes('[[')) return { text, choices: [] };
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let last = lines.length - 1;
    while (last >= 0 && !lines[last]!.trim()) last--;
    const match = last >= 0 ? CHOICES_LINE.exec(lines[last]!) : null;
    if (!match) return { text, choices: [] };
    const choices = match[1]!.split('|')
        .map((c) => c.trim())
        .filter((c) => c.length > 0 && c.length <= MAX_CHOICE_CHARS)
        .slice(0, MAX_CHOICES);
    const kept = lines.slice(0, last).join('\n').replace(/\s+$/, '');
    return { text: kept, choices };
}
