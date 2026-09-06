import {
    readFocusedClaudeTuiPickerRegion,
    readFocusedClaudeTuiQuestion,
    type ClaudeInteractiveTuiPage,
    type InteractivePrompt,
} from '../types/interactive-prompt.js';

export function normalizeClaudeTuiIdentity(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export function claudeTuiQuestionMatches(
    expected: InteractivePrompt['questions'][number],
    focused: { question: string; header?: string },
): boolean {
    const expectedQuestion = normalizeClaudeTuiIdentity(expected.question);
    const focusedQuestion = normalizeClaudeTuiIdentity(focused.question);
    // The question line is always present when the focused-page parser
    // succeeds. Do not accept a header-only match: headers such as Model or
    // Approach are reusable across unrelated pickers, while a false match
    // here would authorize keystrokes against the wrong widget.
    return !!expectedQuestion && expectedQuestion === focusedQuestion;
}

export function claudeTuiQuestionTextAppears(
    expected: InteractivePrompt['questions'][number],
    screenText: string,
): boolean {
    const expectedQuestion = normalizeClaudeTuiIdentity(expected.question);
    const focusedPickerRegion = readFocusedClaudeTuiPickerRegion(screenText);
    return !!expectedQuestion
        && focusedPickerRegion !== null
        && normalizeClaudeTuiIdentity(focusedPickerRegion).includes(expectedQuestion);
}

/**
 * Is `reread` a re-render of the SAME picker page as `landed`?
 *
 * Guards the return-pass screenText swap in captureClaudeTuiPrompt, which
 * replaces a page's entire raw screen and therefore must never be handed a
 * frame belonging to a different question.
 *
 * WHAT WE COMPARE — the question line, via the same parser the capture
 * itself uses (readFocusedClaudeTuiQuestion). Rationale:
 *  - The question text is the one field that is per-page, always rendered
 *    (it is the parse anchor — a page without it yields no question at all),
 *    and stable across the redraw we are waiting on. The redraw races the
 *    option-row GLYPH COLUMN, not the question line.
 *  - The header is NOT usable on its own: on the headered variant every page
 *    renders the identical nav line, and `page.header` is assigned by index
 *    from that shared line rather than read from the page body — so it is
 *    equal across pages by construction and would accept any frame.
 *  - The option-label set is rejected as the primary key: it is drawn in the
 *    very region that is mid-redraw, and rows can be clipped or scrolled out
 *    of the captured frame (the same truncation that forced the headerless
 *    parser to stop requiring the freeform escape hatch). Comparing it would
 *    reject legitimate repairs — exactly the frames this pass exists to fix.
 *
 * STRICTNESS — deliberately asymmetric, because the two error directions are
 * not equally costly. Wrongly ALLOWING a swap corrupts a question into a
 * duplicate of another (the reported user-visible defect). Wrongly BLOCKING
 * one merely leaves the forward-pass capture in place — at worst a
 * multi-select page stays flagged single-select, which the live status-tick
 * upgrade (maybeUpgradeClaudeTuiMultiSelect) then repairs anyway. So this
 * blocks only on POSITIVE EVIDENCE of a different page: if either side fails
 * to parse we return true and defer to the pre-existing glyph gate, keeping
 * behaviour identical to before for every frame whose identity we cannot
 * read. Comparison is whitespace-normalised so a reflow or trailing-pad
 * difference does not read as a different question.
 */
export function claudeTuiPagesLookLikeSameQuestion(landed: ClaudeInteractiveTuiPage, reread: string): boolean {
    const landedQuestion = readFocusedClaudeTuiQuestion(landed.screenText);
    const rereadQuestion = readFocusedClaudeTuiQuestion(reread);
    // Unparseable on either side → no evidence of a mismatch; fail open.
    if (!landedQuestion || !rereadQuestion) return true;
    return normalizeClaudeTuiIdentity(landedQuestion.question) === normalizeClaudeTuiIdentity(rereadQuestion.question);
}

export function readClaudeTuiHeaders(screenText: string): string[] {
    const lines = screenText.split(/\r?\n/);
    let navLine: string | undefined;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index].includes('✔ Submit') && /[☐☒]/.test(lines[index])) {
            navLine = lines[index];
            break;
        }
    }
    if (!navLine) return [];
    const headers: string[] = [];
    for (const match of navLine.matchAll(/[☐☒]\s+(.+?)(?=\s+[☐☒]|\s+✔\s+Submit)/g)) {
        const header = match[1]?.trim();
        if (header) headers.push(header);
    }
    return headers;
}

export function claudeAskUserQuestionPromptsMatch(expected: InteractivePrompt, observed: InteractivePrompt): boolean {
    if (expected.questions.length !== observed.questions.length) return false;
    return expected.questions.every((expectedQuestion, index) => {
        const observedQuestion = observed.questions[index];
        if (!observedQuestion
            || normalizeClaudeTuiIdentity(expectedQuestion.question)
                !== normalizeClaudeTuiIdentity(observedQuestion.question)) return false;

        const observedHeader = normalizeClaudeTuiIdentity(observedQuestion.header || '');
        if (observedHeader
            && normalizeClaudeTuiIdentity(expectedQuestion.header || '') !== observedHeader) return false;

        // Claude's native tool input omits the synthetic TUI escape rows.
        // Compare its complete option list against the captured picker
        // after removing only those known synthetic labels.
        const expectedLabels = expectedQuestion.options
            .map(option => normalizeClaudeTuiIdentity(option.label))
            .filter(label => !/^(?:Type something\.?|Chat about this)$/i.test(label));
        const observedLabels = observedQuestion.options
            .map(option => normalizeClaudeTuiIdentity(option.label));
        return expectedLabels.length === observedLabels.length
            && expectedLabels.every((label, optionIndex) => label === observedLabels[optionIndex]);
    });
}

export function readClaudeToolResultIds(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const blocks: unknown[] = [];
    if (Array.isArray(record.content)) blocks.push(...record.content);
    const message = record.message;
    if (message && typeof message === 'object' && Array.isArray((message as Record<string, unknown>).content)) {
        blocks.push(...((message as Record<string, unknown>).content as unknown[]));
    }
    if (record.type === 'tool_result') blocks.push(record);

    const ids: string[] = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const candidate = block as Record<string, unknown>;
        if (candidate.type !== 'tool_result') continue;
        const id = typeof candidate.tool_use_id === 'string' ? candidate.tool_use_id.trim() : '';
        if (id) ids.push(id);
    }
    return ids;
}
