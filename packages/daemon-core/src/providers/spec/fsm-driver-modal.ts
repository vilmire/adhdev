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

export function deriveModal(
    state: FsmState,
    sections: ResolvedSection[],
    fullScreen: string,
    warnParseMiss: (stateId: string, reason: string) => void,
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
    const hay = sectionText(sections, rule.section, fullScreen);
    const minCount = rule.min_count ?? 2;
    let buttons = extractButtonsFromRule(rule, hay);
    if (buttons.length < minCount && rule.section) {
        // Whole-screen fallback: the modal `section` can resolve too short
        // when a spec's `until` anchor clips the section BEFORE the choices
        // (e.g. a claude-cli approval whose command preview carries a leading
        // shell-redirect line — `>/dev/null 2>&1` — that an over-broad
        // `[…>…]` modal-terminator anchor mistakes for the input prompt,
        // stranding the `❯ 1. Yes / 2. No` buttons below the cut and wedging
        // auto-approve forever). The buttons are still present in the full
        // buffer, so re-extract from it. `lastContiguousNumberedBlock`
        // (inside extractButtonsFromRule) already isolates the real
        // bottom-most choice block from any stray body-numbered lines the
        // wider scope pulls in, so this cannot bind the wrong rows. Guards
        // it to the buttons-under-count case only, so a correctly-scoped
        // spec pays nothing.
        const whole = extractButtonsFromRule(rule, fullScreen);
        if (whole.length >= minCount) buttons = whole;
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
    const title = deriveTitle(state, sections, fullScreen);
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
        // MESHAPPROVE-STALE-MODAL (live 2026-09-18, MoltBook claude-cli):
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
