export const CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX = 'Claude TUI review page is not focused';

/**
 * The answer keystrokes reached the terminal, but the daemon could not CONFIRM
 * the review page before its settle budget expired — the picker was still
 * showing our own bound question, not a foreign widget.
 *
 * This is deliberately a separate class from
 * CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX, which means "the screen is
 * something we do not own, so we refuse to press Enter into it". Here the
 * screen IS ours and the input WAS delivered; only the confirmation is
 * missing. Resending would replay the whole keystroke sequence into a picker
 * that may have advanced in the meantime, so the UI for this class must NOT
 * invite a retry. See the daemon-side gate in
 * `providers/spec/cli-adapter.ts` (assertFocusedClaudeTuiReview) and the web
 * mapping in `web-core/src/hooks/useInteractivePrompt.ts`.
 */
export const CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX = 'Claude TUI answer delivered but not confirmed';
