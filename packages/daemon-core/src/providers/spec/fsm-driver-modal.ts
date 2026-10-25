/**
 * Modal extraction and modal-button presses for the FSM driver.
 *
 * Split out of fsm-driver.ts (file-size gate). Pure functions over the
 * current FSM state + screen; the driver supplies the keystroke sinks.
 */
import { sectionText, extractTitle, extractButtonsFromRule, type ResolvedSection } from './evaluator.js';
import { modalKindForState, type FsmState } from './fsm-types.js';
import type { ModalSnapshot } from './fsm-driver-types.js';
// MULTISELECT-REMOTE-DEADLOCK: the checkbox-marker detector the interactive-prompt
// CAPTURE path uses to set `multiSelect`. Reused (not reimplemented) so the raw
// modal-press refusal below can never disagree with the structured answer path
// about whether a picker is multi-select.
import { detectClaudeTuiMultiSelect } from '../types/interactive-prompt.js';
import { LOG } from '../../logging/logger.js';

export interface LiveModalSlice {
    /** True when the bottom-most interactive block in `lines` is a live modal
     *  within the active viewport and bound to (containing or directly adjacent
     *  to) the active cursor row. */
    hasLiveModal: boolean;
    startRow: number;
    endRow: number;
    lines: string[];
    screen: string;
}

const NUMBERED_CHOICE_LINE_RE = /^\s*(?:[┃│|]\s*)?(?:[❯›➜>→●○◉◯▶]\s*)?(?:\(\s*[●○xX ]\s*\)\s*)?(?:\[[ xX]\]|[☐☒◻◼])?\s*(\d+)(?:\.\s*(?:\[[ xX]\]|[☐☒◻◼])?\s*\S|\s*\([●○xX ]\)\s*\S)/;

const UNNUMBERED_CHOICE_LINE_RE = /^\s*(?:[┃│|]\s*)?(?:[❯›➜>→]\s*)?(?:Yes,\s*I trust this folder|No,\s*exit)\s*$|Allow once\s+Allow always\s+Reject|\bConfirm\s+Cancel\b|^\s*Yes,\s*proceed\s+y\s*$|^\s*No,\s*quit\s+n\s*$/i;

const MODAL_FOOTER_LINE_RE = /enter to submit|press\s+enter\s+to\s+(?:continue|confirm|submit|select)\b|Press enter to confirm or esc to cancel|Enter to confirm\s*[·•|]\s*Esc to cancel|Esc to cancel\b|escape to cancel\b|press\s+esc(?:ape)?\b|Enter to select\b|(?:↑|↓|up|down)[\s/]+(?:↑|↓)?\s*to navigate\b|↑\/↓\s*(?:Navigate|select)\b|\d+\/\d+:select\b|Space to select\b|Tab to amend\b|ctrl\+e to explain\b/i;

function matchNumberedChoiceIndex(line: string): number | null {
    const m = NUMBERED_CHOICE_LINE_RE.exec(line);
    if (!m) return null;
    const idx = Number(m[1]);
    return Number.isFinite(idx) && idx > 0 ? idx : null;
}

function isBackgroundTaskDrawerLine(line: string): boolean {
    return /^\s*●\s+\[\d{2}:\d{2}:\d{2}\]\s+.*\brunning\s*$/.test(line);
}

function isComposerOrSpinnerOrBulletLine(line: string, nextLine = ''): boolean {
    if (/(?:^|\s)(?:Working|Thinking)\s*\((?:[⠀-⣿]|\d+(?:h|m|s|ms)\b|\d+:\d)/.test(line)) return true;
    if (/^\s*[✢✳✶✽✷✸✹✻\u2800-\u28ff]\s+\w/.test(line) && /(?:…|\.\.\.|esc to (?:interrupt|stop)|tokens?\b|\[stop\])/i.test(line)) return true;
    if (/\besc to (?:interrupt|stop)\b/i.test(line)) return true;
    if (/^›(?:\s*$|(?:\s+(?!\d+\.\s)))/.test(line)) return true;
    if (/^\s*›(?:\s*$|(?:\s+(?!\d+\.\s)))/.test(line) && /tab to queue message|⏎\s*send/i.test(nextLine)) return true;
    if (/^\s*(?:[│|]\s*)?❯(?:\s*$|(?:\s+(?!(?:\[[ xX]\]|[☐☒◻◼])?\s*\d+\.\s)(?!No,\s*exit\b|Yes,\s*I trust this folder\b)))/.test(line)) return true;
    if (/Shift\+Tab:mode\b/i.test(line)) return true;
    if (/^\s*[•●⏺]\s+\S/.test(line) && !isBackgroundTaskDrawerLine(line)) return true;
    return false;
}

function isComposerPromptBoundary(line: string, nextLine = ''): boolean {
    if (/^›(?:\s*$|(?:\s+(?!\d+\.\s)))/.test(line)) return true;
    if (/^\s*›(?:\s*$|(?:\s+(?!\d+\.\s)))/.test(line) && /tab to queue message|⏎\s*send/i.test(nextLine)) return true;
    if (/^\s*(?:[│|]\s*)?❯(?:\s*$|(?:\s+(?!(?:\[[ xX]\]|[☐☒◻◼])?\s*\d+\.\s)(?!No,\s*exit\b|Yes,\s*I trust this folder\b)))/.test(line)) return true;
    return false;
}

/**
 * Resolve the bottom-most live modal slice in `lines`, bound to the active
 * cursor row (`cursor`).
 *
 * A modal block is LIVE only when:
 *   1. its bottom (`endRow`) is inside the active viewport (`endRow >= viewportStartRow`),
 *   2. it is the bottom-most interactive block on screen (`endRow === lastNonBlankRow`,
 *      with no composer prompt, active spinner, or assistant prose below it), and
 *   3. it contains, or sits directly adjacent to, the active cursor row.
 *
 * Fallback when no cursor is available (`cursor === undefined`): live-modal
 * detection falls back to conditions (1) and (2) so a modal above an active
 * composer/spinner/prose is still rejected even without a cursor. A real
 * `{ row: 0, col: 0 }` cursor is NEVER treated as unavailable.
 */
export function resolveLiveModalSlice(
    lines: string[],
    cursor?: { row: number; col: number },
    viewportStartRow = 0,
): LiveModalSlice {
    const empty: LiveModalSlice = { hasLiveModal: false, startRow: 0, endRow: 0, lines: [], screen: '' };
    let lastNonBlankRow = lines.length - 1;
    while (lastNonBlankRow >= 0 && !lines[lastNonBlankRow].trim()) lastNonBlankRow -= 1;
    if (lastNonBlankRow < 0) return empty;
    let firstNonBlankRow = 0;
    while (firstNonBlankRow <= lastNonBlankRow && !lines[firstNonBlankRow].trim()) firstNonBlankRow += 1;

    interface ChoiceBlock {
        startRow: number;
        endRow: number;
        lastIdx: number;
        count: number;
    }
    const choiceBlocks: ChoiceBlock[] = [];
    const unnumberedRows: number[] = [];
    const footerRows: number[] = [];

    for (let i = 0; i <= lastNonBlankRow; i += 1) {
        const line = lines[i];
        const idx = matchNumberedChoiceIndex(line);
        if (idx !== null) {
            let optEnd = i;
            for (let j = i + 1; j <= lastNonBlankRow && j <= i + 3; j += 1) {
                const next = lines[j];
                if (!next.trim()) break;
                if (matchNumberedChoiceIndex(next) !== null) break;
                if (UNNUMBERED_CHOICE_LINE_RE.test(next)) break;
                if (MODAL_FOOTER_LINE_RE.test(next) || isComposerOrSpinnerOrBulletLine(next, lines[j + 1] ?? '')) break;
                if (/^\s*[─╌═━]{8,}\s*$/.test(next)) break;
                if (/^\s*(?:\? for shortcuts|⏵⏵\s+|tab to queue message|⏎\s*send|>\s*$)/i.test(next)) break;
                optEnd = j;
            }
            const prevBlock = choiceBlocks[choiceBlocks.length - 1];
            let canContinuePrev = false;
            if (prevBlock && idx === prevBlock.lastIdx + 1 && i <= prevBlock.endRow + 4) {
                canContinuePrev = true;
                for (let r = prevBlock.endRow + 1; r < i; r += 1) {
                    if (isComposerOrSpinnerOrBulletLine(lines[r], lines[r + 1] ?? '') || MODAL_FOOTER_LINE_RE.test(lines[r])) {
                        canContinuePrev = false;
                        break;
                    }
                }
            }
            if (canContinuePrev && prevBlock) {
                prevBlock.endRow = optEnd;
                prevBlock.lastIdx = idx;
                prevBlock.count += 1;
            } else if (idx === 1) {
                choiceBlocks.push({ startRow: i, endRow: optEnd, lastIdx: 1, count: 1 });
            }
            i = optEnd;
            continue;
        }
        if (UNNUMBERED_CHOICE_LINE_RE.test(line)) {
            unnumberedRows.push(i);
        }
        if (MODAL_FOOTER_LINE_RE.test(line) && !isComposerOrSpinnerOrBulletLine(line, lines[i + 1] ?? '')) {
            footerRows.push(i);
        }
    }

    const validChoiceBlocks = choiceBlocks.filter(b =>
        b.count >= 2 || footerRows.some(f => f >= b.endRow && f <= b.endRow + 3),
    );
    const lastChoiceBlock = validChoiceBlocks[validChoiceBlocks.length - 1];
    const lastUnnumberedRow = unnumberedRows[unnumberedRows.length - 1] ?? -1;
    const lastFooterRow = footerRows[footerRows.length - 1] ?? -1;

    let choiceStartRow = -1;
    let choiceEndRow = -1;
    if (lastChoiceBlock && lastChoiceBlock.endRow >= lastUnnumberedRow) {
        choiceStartRow = lastChoiceBlock.startRow;
        choiceEndRow = lastChoiceBlock.endRow;
    } else if (lastUnnumberedRow !== -1) {
        choiceStartRow = unnumberedRows.find(r => r >= lastUnnumberedRow - 8) ?? lastUnnumberedRow;
        choiceEndRow = lastUnnumberedRow;
    } else if (lastFooterRow !== -1) {
        choiceStartRow = lastFooterRow;
        choiceEndRow = lastFooterRow;
    }

    let modalEndRow: number;
    if (choiceEndRow !== -1) {
        modalEndRow = choiceEndRow;
        let sawModalFooter = MODAL_FOOTER_LINE_RE.test(lines[choiceEndRow]);
        for (let r = choiceEndRow + 1; r <= lastNonBlankRow; r += 1) {
            const line = lines[r];
            if (!line.trim()) continue;
            if (isComposerOrSpinnerOrBulletLine(line, lines[r + 1] ?? '')) break;
            if (MODAL_FOOTER_LINE_RE.test(line)) {
                sawModalFooter = true;
                modalEndRow = r;
                continue;
            }
            if (/^\s*[─╌═━┃│╭╮╰╯┌┐└┘├┤┬┴┼]+\s*$/.test(line)) {
                modalEndRow = r;
                continue;
            }
            if (
                (sawModalFooter && r === lastNonBlankRow)
                || isBackgroundTaskDrawerLine(line)
                || /^\s*⏵⏵\s+/.test(line)
                || /tab to queue message|⏎\s*send/i.test(line)
                || /^\s*>\s*$/.test(line)
                || (
                    r >= lastNonBlankRow - 2
                    && /^\s*(?:\? for shortcuts|›|ctrl\+f\s+Fullscreen|Grok Build\b|K\d+(?:\.\d+)?\s+Preview\b|context:\s*\d+%|- Terms of Service:|https?:\/\/|Links:)/i.test(line)
                )
            ) {
                modalEndRow = r;
                continue;
            }
            break;
        }
    } else {
        // No choice block or modal footer on screen (e.g. header-only / side-panel onboarding modal):
        // reject if any composer, spinner, or assistant bullet sits at the bottom of the viewport.
        const checkFrom = Math.max(0, viewportStartRow);
        for (let r = lastNonBlankRow; r >= checkFrom && r >= lastNonBlankRow - 6; r -= 1) {
            if (isComposerOrSpinnerOrBulletLine(lines[r], lines[r + 1] ?? '')) {
                return empty;
            }
        }
        choiceStartRow = checkFrom;
        modalEndRow = lastNonBlankRow;
    }

    if (modalEndRow < viewportStartRow) return empty;
    if (modalEndRow < lastNonBlankRow) return empty;

    let minStartRow = firstNonBlankRow;
    for (const b of choiceBlocks) {
        if (b !== lastChoiceBlock && b.endRow < choiceStartRow) {
            minStartRow = Math.max(minStartRow, b.endRow + 1);
        }
    }
    for (const f of footerRows) {
        if (f < choiceStartRow) {
            minStartRow = Math.max(minStartRow, f + 1);
        }
    }
    for (let r = firstNonBlankRow; r < choiceStartRow; r += 1) {
        const line = lines[r];
        if (
            isComposerPromptBoundary(line, lines[r + 1] ?? '')
            || /^\s*•\s+\S/.test(line)
            || /(?:^|\s)(?:Working|Thinking)\s*\((?:[⠀-⣿]|\d+(?:h|m|s|ms)\b|\d+:\d)/.test(line)
            || (/^\s*[✢✳✶✽✷✸✹✻\u2800-\u28ff]\s+\w/.test(line) && /(?:…|\.\.\.|esc to (?:interrupt|stop)|tokens?\b|\[stop\])/i.test(line))
        ) {
            minStartRow = Math.max(minStartRow, r + 1);
        }
    }

    const interactiveStartRow = choiceEndRow !== -1
        ? Math.max(minStartRow, choiceStartRow > 0 ? Math.max(1, choiceStartRow - 1) : 0)
        : Math.max(minStartRow, firstNonBlankRow);

    if (cursor !== undefined) {
        if (cursor.row < 0) return empty;
        const effectiveCursorRow = cursor.row;
        if (
            effectiveCursorRow <= lastNonBlankRow
            && isComposerOrSpinnerOrBulletLine(lines[effectiveCursorRow], lines[effectiveCursorRow + 1] ?? '')
        ) {
            return empty;
        }
        if (effectiveCursorRow < interactiveStartRow || effectiveCursorRow > modalEndRow + 1) {
            return empty;
        }
    }

    const sliceLines = lines.slice(minStartRow, modalEndRow + 1);
    return {
        hasLiveModal: true,
        startRow: minStartRow,
        endRow: modalEndRow,
        lines: sliceLines,
        screen: sliceLines.join('\n'),
    };
}

export function deriveModal(
    state: FsmState,
    sections: ResolvedSection[],
    fullScreen: string,
    warnParseMiss: (stateId: string, reason: string) => void,
    cursor?: { row: number; col: number },
    /** First viewport row in `fullScreen` when it is a scrollback-extended guard frame. */
    viewportStartRow = 0,
    /**
     * Resolve spec sections on the live region's own lines (as fsm-evaluator does).
     * Clipping frame-wide sections is wrong for first-match anchors: a quoted modal
     * earlier in the frame starts the section there, and the clip then begins it at
     * whatever output precedes the live modal — a title made of agent output.
     */
    resolveLiveSections?: (lines: string[]) => ResolvedSection[],
): ModalSnapshot | null {
    const rule = state.extract?.buttons;
    if (!rule) {
        // APPROVAL-DEADLOCK diagnosability: a modal state with no button rule
        // can never be approved (mesh_approve has nothing to press), so this
        // silent null used to surface only as a bare `parsedModal=no` with no
        // way to tell "spec has no rule" from "rule matched nothing". Name the
        // cause once per state entry. Measured case: grok-cli spec 1.0 `trust`
        // declared extract.title but no extract.buttons.
        if (state.modal) {
            warnParseMiss(state.id, `state '${state.id}' is modal but its spec declares NO extract.buttons rule, so no button can ever be parsed or pressed`);
        }
        return null;
    }
    const screenLines = fullScreen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
    const liveModal = resolveLiveModalSlice(screenLines, cursor, viewportStartRow);
    if (!liveModal.hasLiveModal) {
        return null;
    }
    const scopedScreen = liveModal.screen;
    const scopedSections: ResolvedSection[] = resolveLiveSections ? resolveLiveSections(liveModal.lines) : sections.map(s => {
        const fromLine = Math.max(s.fromLine, liveModal.startRow);
        const toLine = Math.max(fromLine, Math.min(s.toLine, liveModal.endRow + 1));
        return {
            id: s.id,
            fromLine: fromLine - liveModal.startRow,
            toLine: toLine - liveModal.startRow,
            text: screenLines.slice(fromLine, toLine).join('\n'),
        };
    });
    const hay = sectionText(scopedSections, rule.section, scopedScreen);
    const minCount = rule.min_count ?? 2;
    let buttons = extractButtonsFromRule(rule, hay);
    if (buttons.length < minCount && rule.section) {
        // Whole-screen fallback (scoped to the cursor-bound live modal region):
        // the modal `section` can resolve too short
        // when a spec's `until` anchor clips the section BEFORE the choices
        // (e.g. a claude-cli approval whose command preview carries a leading
        // shell-redirect line — `>/dev/null 2>&1` — that an over-broad
        // `[…>…]` modal-terminator anchor mistakes for the input prompt,
        // stranding the `❯ 1. Yes / 2. No` buttons below the cut and wedging
        // auto-approve forever). The buttons are still present in the live modal
        // buffer, so re-extract from it. `lastContiguousNumberedBlock`
        // (inside extractButtonsFromRule) already isolates the real
        // bottom-most choice block from any stray body-numbered lines the
        // wider scope pulls in, so this cannot bind the wrong rows. Guards
        // it to the buttons-under-count case only, so a correctly-scoped
        // spec pays nothing.
        //
        // The wider scope must still show a real choice block, i.e. a row with
        // the cursor marker. A list the assistant WROTE has none, yet it was
        // bound here (2026-10-01, claude-cli): in the ~1s between answering an
        // approval and approval→vanished, the modal is re-derived from a screen
        // whose dialog is gone, and the answer's "1. … 2. … 3." block became the
        // buttons (title: the footer status line) — pressing one typed a digit
        // into the prompt.
        const whole = extractButtonsFromRule(rule, scopedScreen);
        if (whole.length >= minCount && whole.some(b => b.current)) buttons = whole;
    } else if (buttons.length >= minCount && rule.section && !buttons.some(b => b.current)) {
        // Same rule from the other side: the section resolved to a numbered list
        // with no cursor row while a real choice block is on screen. The modal
        // anchor's "line followed by `1.`" candidate also matches an assistant's
        // own numbered list in scrollback, and a `❯` prompt line between that
        // list and a later picker ends the section early (2026-10-01, claude-cli
        // AskUserQuestion): the picker reported the old list as its buttons for
        // the rest of the session.
        const whole = extractButtonsFromRule(rule, scopedScreen);
        if (whole.length >= minCount && whole.some(b => b.current)) buttons = whole;
    }
    // APPROVAL-DEADLOCK cursor fallback. A spec narrows `cursor_marker` to
    // keep an assistant blockquote (`> 1. quoted item`) from stealing the
    // cursor flag from the real `❯` row — antigravity-cli 4.0 declares
    // `"❯›"` for exactly that reason, and that guard must hold.
    //
    // But antigravity ALSO paints its focus marker as a plain `>` when no
    // `❯` is on screen (measured live 2026-09-20:
    // `> 1. Yes, run command`). With the narrowed class, no row then reads
    // as current, `select_mode: 'arrow_keys'` concludes the list is stale
    // scrollback, and the press is refused — a modal the user is staring at
    // becomes unanswerable.
    //
    // Both requirements hold under PRECEDENCE rather than a wider class: the
    // narrowed marker WINS whenever it matches any row (blockquote case
    // unchanged, byte for byte), and the engine default is consulted only
    // when the strict pass found no cursor at all. A blockquote-polluted
    // screen always contains the real `❯`, so it never reaches the fallback;
    // a genuinely stale scrollback list has neither marker on a choice row,
    // so it still parses as cursor-less and stays refused.
    if (rule.cursor_marker && buttons.length > 0 && !buttons.some(b => b.current)) {
        const relaxed = extractButtonsFromRule({ ...rule, cursor_marker: undefined }, hay);
        const relaxedCurrent = relaxed.filter(b => b.current);
        // Exactly one fallback cursor, or the ambiguity this guard exists to
        // prevent comes back in through the fallback itself.
        if (relaxedCurrent.length === 1) {
            const cursorIndex = relaxedCurrent[0].index;
            if (buttons.some(b => b.index === cursorIndex)) {
                buttons = buttons.map(b => (b.index === cursorIndex ? { ...b, current: true } : b));
            }
        }
    }
    if (buttons.length < minCount) {
        // Same diagnosability contract as the no-rule branch above: report
        // WHAT failed (how many rows the pattern matched vs. the minimum)
        // without ever logging screen text. Measured case: grok-cli's
        // approval pattern expects `N (●) label` radio rows, but the live
        // trust screen paints `Yes, proceed   y` → 0 matches.
        if (state.modal) {
            warnParseMiss(state.id, `state '${state.id}' is modal but its extract.buttons pattern matched ${buttons.length} row(s), below min_count=${minCount} — the on-screen modal cannot be approved until the rule covers this screen`);
        }
        return null;
    }
    const title = deriveTitle(state, scopedSections, scopedScreen);
    return { title, buttons };
}

export function deriveTitle(state: FsmState, sections: ResolvedSection[], fullScreen: string): string | null {
    const rule = state.extract?.title;
    if (!rule) return null;
    return extractTitle(rule, sections, fullScreen);
}

/** What a modal-button press needs from the driver. */
export interface ModalPressContext {
    /** The modal latched by the last evaluation (buttons + cursor flags). */
    modal: ModalSnapshot | null | undefined;
    /** The FSM state the driver is currently in. */
    state: FsmState | undefined;
    specId: string;
    readScrollbackLines(): string[];
    sendKeys(keys: string): void;
    /** Write a confirm sequence (win32-aware — see FsmDriver.submitModalConfirm). */
    submitConfirm(keys: string): void;
}

/**
 * MULTISELECT-REMOTE-DEADLOCK: is the modal we're parked on a multi-select
 * (checkbox) picker — the one class a raw modal-button press must never
 * touch? See handleClickModalButton for why.
 *
 * Two independent conditions, BOTH required, so the refusal stays narrow:
 *   1. the FSM classifies this state as a `picker` (an approval/confirm
 *      consent modal is single-select by construction and keeps working);
 *   2. the live frame actually renders checkbox markers on its numbered
 *      option rows — detectClaudeTuiMultiSelect, the SAME detector the
 *      capture path uses to set `InteractiveQuestion.multiSelect`, so the
 *      refusal and the structured answer path can never disagree about
 *      whether a given picker is multi-select.
 *
 * Reads the scrollback-inclusive frame for the same reason deriveModal does:
 * a tall prompt body scrolls the option rows' glyph column out of the
 * viewport, and a viewport-only read would then miss the checkboxes and let
 * the corrupting press through.
 */
function isMultiSelectCheckboxPicker(state: FsmState | undefined, readScrollbackLines: () => string[]): boolean {
    if (!state || modalKindForState(state) !== 'picker') return false;
    try {
        return detectClaudeTuiMultiSelect(readScrollbackLines().join('\n'));
    } catch {
        // A snapshot failure must not turn into a silent corrupting press
        // either — but it is also not evidence of a checkbox picker, so keep
        // the existing single-select behaviour rather than refusing blind.
        return false;
    }
}

export function pressModalButton(ctx: ModalPressContext, index: number): boolean {
    const m = ctx.modal;
    if (!m) return false;
    const btn = m.buttons.find(b => b.index === index);
    if (!btn) return false;

    // MULTISELECT-REMOTE-DEADLOCK: a raw modal-button press CANNOT answer a
    // multi-select (checkbox) picker, and pressing one silently CORRUPTS it.
    //
    // The raw press paths below assume single-select semantics — one key (or
    // arrow-nav + one CR) both chooses and submits. A claude-cli checkbox
    // picker breaks BOTH halves of that assumption (protocol measured live,
    // see buildClaudeInteractiveTuiAnswerSteps):
    //   * a digit TOGGLES a box without moving the cursor or advancing;
    //   * CR/Enter toggles the CURSOR's row — it does NOT submit. Only Tab
    //     commits the question, and a final CR on the review page submits.
    // So each remote tap flipped a checkbox the user never chose and never
    // submitted anything, leaving the session parked and flapping
    // approval↔busy forever (the mobile "can't answer the question" wedge).
    //
    // There is no correct keystroke to emit from HERE: answering needs the
    // whole bound InteractivePrompt (every question's selected label set) to
    // build the digit+Tab+CR sequence, plus the live focus assertions that
    // keep a stale response from operating another picker. That state lives
    // one layer up on SpecCliAdapter (activeInteractivePrompt →
    // setInteractivePromptResponse → buildClaudeInteractiveTuiAnswerSteps),
    // not on this keystroke-only driver. So fail LOUDLY and write NOTHING:
    // the `false` return already flows out through
    // SpecCliAdapter.resolveModalMatched to mesh_approve and the dashboard,
    // which is exactly the "this surface cannot submit" signal the caller
    // needs in order to route the user to the structured picker instead.
    //
    // Scoped to picker-kind modals that actually render checkbox markers, so
    // single-select pickers and approval/confirm modals keep their existing
    // behaviour byte-for-byte.
    if (isMultiSelectCheckboxPicker(ctx.state, ctx.readScrollbackLines)) {
        LOG.warn('FsmDriver', `[${ctx.specId}] click_modal_button(${index}) refused — multi-select checkbox picker cannot be answered by a raw modal press (needs the structured interactive-prompt path: digit per selection + Tab + review Enter). No keys written.`);
        return false;
    }

    const rule = ctx.state?.extract?.buttons;
    if (rule?.select_mode === 'arrow_keys') {
        // MESHAPPROVE-STALE-MODAL (live 2026-09-18, DevLaptop claude-cli):
        // an `arrow_keys` modal is a LIVE cursor list, and claude-cli always
        // paints `❯` on the focused row while one is open. So "no row carries
        // the cursor marker" is not a formatting quirk — it means the choice
        // list on screen is SCROLLBACK: the picker is already gone and the
        // TUI is back at the `❯` composer (often with a spinner running).
        // deriveModal reads a scrollback-inclusive buffer on purpose (tall
        // prompts scroll the box out of the viewport), so those dead
        // `1. Yes / 2. No` lines still parse into a full modal and the state
        // stays `approval`.
        //
        // The old `?? 1` fabricated a cursor origin from that dead list:
        // delta became 0, no nav was emitted, and submitModalConfirm wrote a
        // BARE CR — straight into the composer, submitting an EMPTY message.
        // claude-cli spun on it briefly and repainted the same stale screen,
        // which is exactly the observed approval → approval_resolving → busy
        // → approval loop. resolveModalMatched still returned true, so
        // mesh_approve reported `{success:true, buttonIndex:0, button:"Yes"}`
        // on every one of six attempts across 56 minutes while nothing was
        // ever approved.
        //
        // There is no safe keystroke to emit here: we cannot know where a
        // cursor that is not on screen sits, and guessing writes into the
        // composer. Fail LOUDLY and write NOTHING — `false` flows out through
        // resolveModalMatched so mesh_approve surfaces the miss instead of a
        // false success. A real open picker always has its marker, so this
        // costs the healthy path nothing.
        if (!m.buttons.some(b => b.current)) {
            LOG.warn('FsmDriver', `[${ctx.specId}] click_modal_button(${index}) refused — no cursor marker on any row of an arrow_keys modal, so the choice list is stale scrollback and the live picker is gone. Writing a bare CR here would submit an empty message into the composer. No keys written.`);
            return false;
        }
        // Cursor-list approval modal (claude-cli new TUI): number keys are
        // IGNORED — sending `btn.key` ("1\r") types a literal "1" into the
        // composer and the trailing CR submits it as a chat message. Drive
        // the cursor from its current row to the target row with arrows,
        // then confirm.
        const from = m.buttons.find(b => b.current)!.index;
        const up = rule.cursor_keys?.up ?? '\x1b[A';
        const down = rule.cursor_keys?.down ?? '\x1b[B';
        const delta = btn.index - from;
        const step = delta >= 0 ? down : up;
        const nav = step.repeat(Math.abs(delta));
        // Confirm = key_for_index with the (now unused) {index} stripped:
        // `{index}\r` → `\r`.
        const confirm = (rule.key_for_index || '\r').replace(/\{index\}/g, '') || '\r';
        if (nav) ctx.sendKeys(nav);
        ctx.submitConfirm(confirm);
        return true;
    }
    ctx.submitConfirm(btn.key);
    return true;
}
