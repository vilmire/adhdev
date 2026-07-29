export interface InteractivePrompt {
  promptId: string;
  origin: 'cli' | 'mcp' | 'agent';
  providerType: string;
  createdAt: number;
  questions: InteractiveQuestion[];
}

export interface InteractiveQuestion {
  questionId: string;
  question: string;
  header?: string;
  multiSelect: boolean;
  options: InteractiveOption[];
  allowFreeform?: boolean;
}

export interface InteractiveOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface InteractivePromptResponse {
  promptId: string;
  answers: Record<string, InteractiveAnswer>;
}

export interface InteractiveAnswer {
  selectedLabels: string[];
  freeformText?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => readString(item)).filter((item): item is string => !!item)
    : [];
}

function normalizeOption(raw: unknown): InteractiveOption | null {
  if (typeof raw === 'string') {
    const label = raw.trim();
    return label ? { label } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const label = readString(record.label);
  if (!label) return null;
  const description = readString(record.description);
  const preview = readString(record.preview);
  return {
    label,
    ...(description ? { description } : {}),
    ...(preview ? { preview } : {}),
  };
}

function normalizeQuestion(raw: unknown, index: number): InteractiveQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const question = readString(record.question);
  if (!question) return null;
  const questionId = readString(record.questionId) || readString(record.id) || `q${index + 1}`;
  const options = Array.isArray(record.options)
    ? record.options.map(normalizeOption).filter((item): item is InteractiveOption => !!item)
    : [];
  const header = readString(record.header);
  return {
    questionId,
    question,
    ...(header ? { header } : {}),
    multiSelect: record.multiSelect === true,
    options,
    ...(record.allowFreeform === true ? { allowFreeform: true } : {}),
  };
}

export function normalizeInteractivePrompt(raw: unknown): InteractivePrompt | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const promptId = readString(record.promptId);
  const providerType = readString(record.providerType);
  const origin = record.origin === 'mcp' || record.origin === 'agent' ? record.origin : 'cli';
  const questions = Array.isArray(record.questions)
    ? record.questions.map(normalizeQuestion).filter((item): item is InteractiveQuestion => !!item)
    : [];
  if (!promptId || !providerType || questions.length === 0) return null;
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? record.createdAt
    : Date.now();
  return { promptId, origin, providerType, createdAt, questions };
}

export function normalizeInteractivePromptResponse(raw: unknown): InteractivePromptResponse {
  if (!raw || typeof raw !== 'object') throw new Error('Interactive prompt response must be an object');
  const record = raw as Record<string, unknown>;
  const promptId = readString(record.promptId);
  if (!promptId) throw new Error('promptId must be a non-empty string');
  if (!record.answers || typeof record.answers !== 'object' || Array.isArray(record.answers)) {
    throw new Error('answers must be an object');
  }
  const answers: Record<string, InteractiveAnswer> = {};
  for (const [questionId, answerRaw] of Object.entries(record.answers as Record<string, unknown>)) {
    if (!answerRaw || typeof answerRaw !== 'object' || Array.isArray(answerRaw)) continue;
    const answer = answerRaw as Record<string, unknown>;
    const selectedLabels = readStringArray(answer.selectedLabels);
    const freeformText = readString(answer.freeformText);
    answers[questionId] = {
      selectedLabels,
      ...(freeformText ? { freeformText } : {}),
    };
  }
  return { promptId, answers };
}

/**
 * Resolve a coordinator-friendly answer form into the strict, questionId-keyed
 * InteractivePromptResponse the TUI/answer machinery consumes (mission f1d25e11).
 *
 * mesh_answer_question lets the coordinator answer against the option LABELS or
 * 1-based INDEXES it saw in the agent:waiting_choice event, without having to
 * reconstruct the exact questionId → selectedLabels map. This resolves that
 * ergonomic form against the AUTHORITATIVE active prompt (the daemon holds it),
 * so index/label resolution and question ordering are correct by construction.
 *
 * Accepted `raw` shapes:
 *   - The strict form ({ promptId, answers: { [questionId]: { selectedLabels } } })
 *     — passed straight to normalizeInteractivePromptResponse (back-compat).
 *   - The friendly form ({ promptId, answers: [ { questionId?, select?, freeform? } ] })
 *     — entries map to questions by questionId, else by array position. `select`
 *     is a label (string) / 1-based index (number) / array of either.
 */
export function resolveInteractivePromptResponse(
  prompt: InteractivePrompt,
  raw: unknown,
): InteractivePromptResponse {
  if (!raw || typeof raw !== 'object') throw new Error('Interactive prompt response must be an object');
  const record = raw as Record<string, unknown>;
  const promptId = readString(record.promptId);
  if (!promptId) throw new Error('promptId must be a non-empty string');
  if (promptId !== prompt.promptId) throw new Error('Interactive prompt response does not match active prompt');
  // Strict (keyed-object) form → existing normalizer.
  if (record.answers && typeof record.answers === 'object' && !Array.isArray(record.answers)) {
    return normalizeInteractivePromptResponse(record);
  }
  if (!Array.isArray(record.answers)) throw new Error('answers must be an array or a questionId-keyed object');

  const resolveOneLabel = (question: InteractiveQuestion, sel: unknown): string => {
    if (typeof sel === 'number' && Number.isFinite(sel)) {
      const idx = Math.trunc(sel) - 1; // 1-based
      const option = question.options[idx];
      if (!option) throw new Error(`Option index ${sel} out of range for ${question.questionId}`);
      return option.label;
    }
    const label = readString(sel);
    if (!label) throw new Error(`Empty selection for ${question.questionId}`);
    // Exact label match first; fall back to a numeric string index.
    const exact = question.options.find((o) => o.label === label);
    if (exact) return exact.label;
    const asIndex = Number(label);
    if (Number.isInteger(asIndex)) {
      const option = question.options[asIndex - 1];
      if (option) return option.label;
    }
    throw new Error(`Unknown option for ${question.questionId}: ${label}`);
  };

  const answers: Record<string, InteractiveAnswer> = {};
  const entries = record.answers as unknown[];
  entries.forEach((entryRaw, index) => {
    if (!entryRaw || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) return;
    const entry = entryRaw as Record<string, unknown>;
    const questionId = readString(entry.questionId);
    const question = (questionId ? prompt.questions.find((q) => q.questionId === questionId) : undefined)
      ?? prompt.questions[index];
    if (!question) throw new Error(`No matching question for answer entry ${index}`);
    const freeformText = readString(entry.freeform) ?? readString(entry.freeformText);
    const selectedLabels: string[] = [];
    const select = entry.select;
    if (Array.isArray(select)) {
      for (const sel of select) selectedLabels.push(resolveOneLabel(question, sel));
    } else if (select !== undefined && select !== null) {
      selectedLabels.push(resolveOneLabel(question, select));
    }
    answers[question.questionId] = {
      selectedLabels,
      ...(freeformText ? { freeformText } : {}),
    };
  });
  return { promptId, answers };
}

/**
 * REBIND OPTION FIDELITY (rc.20): content-addressed identity for a claude TUI
 * picker prompt.
 *
 * The TUI capture path used to mint `ask-user-<providerSessionId>-<Date.now()>`
 * on EVERY capture. Across a daemon restart the still-parked picker is
 * re-captured from the rebound PTY screen, so the SAME question re-appeared
 * under a FRESH promptId while the coordinator/dashboard still held the
 * pre-restart one. The stale answer was then silently dropped (log-only), and
 * any index-based answer against the new promptId resolved against the
 * re-parsed option list — whose row order/content can drift from what the
 * answerer saw — so "select 2 (BETA)" could bind to a different row (ALPHA).
 *
 * Deriving the promptId from the prompt CONTENT makes identity survive rebind:
 * the same question re-captured after a restart yields the SAME promptId, so a
 * pre-restart answer (label- or index-based) resolves against exactly the
 * option list it was issued against. Genuine content drift (re-ordered /
 * re-parsed options) yields a DIFFERENT promptId, so the stale answer is
 * rejected outright instead of being silently mis-bound — no index/default
 * fallback is ever taken.
 *
 * The fingerprint covers question text + multi-select flag + the option LABELS
 * in order (descriptions/previews are display-only and can truncate in
 * scrollback, so they must not destabilize identity). FNV-1a 32-bit: this file
 * stays dependency-free; collisions are harmless beyond a same-session,
 * same-content re-ask (which answers identically by construction).
 */
export function interactivePromptContentFingerprint(questions: InteractiveQuestion[]): string {
    let hash = 0x811c9dc5;
    const mix = (text: string) => {
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
    };
    for (const question of questions) {
        mix(question.question);
        mix(question.multiSelect ? '\u0001multi' : '\u0001single');
        for (const option of question.options) { mix('\u0002'); mix(option.label); }
        mix('\u0003');
    }
    return hash.toString(16).padStart(8, '0');
}

export function stableClaudeTuiPromptId(questions: InteractiveQuestion[]): string {
    return `ask-user-tui-${interactivePromptContentFingerprint(questions)}`;
}

export function buildClaudeInteractiveToolResult(response: InteractivePromptResponse): string {
    return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: response.promptId,
        content: JSON.stringify({ answers: response.answers }),
        is_error: false,
      }],
    },
  });
}

export interface ClaudeInteractiveTuiPage {
  screenText: string;
  header?: string;
}

// Option rows look like "❯ 1. Label". The multi-select picker additionally
// draws a checkbox marker that can sit before or after the number
// ("❯ [ ] 1. Label" / "❯ 1. [x] Label" / "☐ 1. Label"); the optional,
// non-capturing checkbox groups absorb it so the captured label stays clean.
const CLAUDE_TUI_OPTION_CHECKBOX = '(?:\\[[ xX]\\]|[☐☒◻◼])';
const CLAUDE_TUI_OPTION_PATTERN = new RegExp(
  `^\\s*(?:[❯›>]\\s*)?(?:${CLAUDE_TUI_OPTION_CHECKBOX}\\s*)?(\\d+)\\.\\s+(?:${CLAUDE_TUI_OPTION_CHECKBOX}\\s*)?(.+?)\\s*$`,
);

function claudeTuiQuestionHeaders(screenText: string): string[] {
  const navLine = screenText.split(/\r?\n/).find(line => line.includes('✔ Submit') && /[☐☒]/.test(line));
  if (!navLine) return [];
  const headers: string[] = [];
  const pattern = /[☐☒]\s+(.+?)(?=\s+[☐☒]|\s+✔\s+Submit)/g;
  for (const match of navLine.matchAll(pattern)) {
    const header = readString(match[1]);
    if (header) headers.push(header);
  }
  return headers;
}

function isClaudeTuiSelectFooter(text: string): boolean {
  // The picker's defining footer hint is "Enter to select". Older claude-cli
  // builds paired it with "Esc to cancel" and this guard required BOTH — but
  // current builds render the footer as "Enter to select · ↑/↓ to navigate"
  // with NO Esc hint, so the pair requirement collapsed: the headerless picker
  // failed to parse, activeInteractivePrompt stayed null, and the screen fell
  // through to the approval matchers → waiting_approval (rc.19 live defect).
  // A genuine tool-consent modal NEVER renders "Enter to select" (its footer
  // is "Esc to cancel · Tab to amend · ctrl+e to explain"), so the single hint
  // is a safe discriminator. The option-block anchor below (numbered option
  // rows above the footer line) keeps a bare "Enter to select" mention in
  // prose from parsing as a picker.
  return /Enter to select/i.test(text);
}

/**
 * Decide whether a captured claude-cli AskUserQuestion TUI page is multi-select.
 *
 * The original heuristic only matched the footer hint `/Space to select|toggle
 * selections/i`. That string drifts between claude-cli versions, so when it
 * changed the dashboard silently fell back to multiSelect:false and rendered
 * single-select (radio) controls even though the on-screen picker showed
 * checkboxes — the user could not check more than one box. (The CLI's own
 * terminal still rendered `[ ]` correctly because it never depends on this
 * parse.)
 *
 * Make detection robust by ALSO recognising the actual checkbox markers the
 * multi-select picker draws on its option rows (`[ ]` / `[x]` / `☐` / `☒` /
 * `◻` / `◼`). Single-select rows are drawn with a `❯`/number cursor only and
 * carry none of these box glyphs, so their presence is a reliable signal. The
 * broadened footer patterns ("Space to", "toggle", "select multiple") are kept
 * as a secondary signal for layouts that render markers differently.
 */
export function detectClaudeTuiMultiSelect(screenText: string): boolean {
  if (/Space to (?:select|toggle)|toggle selection|select multiple|select all that apply/i.test(screenText)) {
    return true;
  }
  // A checkbox glyph on a NUMBERED option row only appears in the multi-select
  // picker. The glyph sits EITHER before the number ("❯ [ ] 1. TypeScript" /
  // "☐ 2. Python") OR after it ("❯ 1. [ ] 계란말이" — claude-cli >=2.1's layout).
  // We require the numbered "N." option marker either way so we don't
  // false-positive on the `✔ Submit` nav line (per-question answered-state
  // ☐/☒) or on the headerless variant where the QUESTION line itself begins
  // with `☐ ` (single-select).
  const optionCheckbox = `(?:\\[[ xX]\\]|[☐☒◻◼])`;
  const beforeNumber = new RegExp(`^\\s*(?:[❯›>]\\s*)?${optionCheckbox}\\s*\\d+\\.\\s+\\S`);
  const afterNumber = new RegExp(`^\\s*(?:[❯›>]\\s*)?\\d+\\.\\s*${optionCheckbox}\\s+\\S`);
  for (const line of screenText.split(/\r?\n/)) {
    if (line.includes('✔ Submit')) continue; // header/nav line
    if (beforeNumber.test(line) || afterNumber.test(line)) return true;
  }
  return false;
}

function readClaudeHeaderLine(lines: string[], beforeIndex: number): string | undefined {
  for (let i = beforeIndex; i >= 0; i -= 1) {
    const candidate = lines[i].trim();
    if (!candidate) continue;
    const match = candidate.match(/^[☐☒]\s+(.+?)\s*$/);
    if (match?.[1]) return readString(match[1]);
    if (/^─+$/.test(candidate)) break;
  }
  return undefined;
}

function readClaudeOptionDescription(lines: string[], optionLineIndex: number): string | undefined {
  const nextLine = lines[optionLineIndex + 1];
  const next = nextLine?.trim();
  if (!next
    || CLAUDE_TUI_OPTION_PATTERN.test(nextLine)
    || /^─+$/.test(next)
    || /^Enter to select\b/i.test(next)
    || /^[☐☒]\s+/.test(next)) {
    return undefined;
  }
  return next;
}

function parseClaudeHeaderlessInteractiveTuiQuestion(page: ClaudeInteractiveTuiPage, index: number): InteractiveQuestion | null {
  // The claude TUI select footer ("Enter to select" — older builds paired it
  // with "Esc to cancel"; current builds render "Enter to select · ↑/↓ to
  // navigate") is the picker's defining signature. The freeform escape hatch
  // ("Type something" / "Chat about this") used to be REQUIRED here, but those
  // option rows can be absent or scrolled out of the captured frame — in which
  // case the picker failed to parse, activeInteractivePrompt stayed null, and
  // detect-status then mis-classified the screen as waiting_approval (mission
  // fb2a7053). Requiring only the footer plus (below) a real option block is
  // sufficient; the escape hatch, when present, is still picked up as
  // allowFreeform.
  if (!isClaudeTuiSelectFooter(page.screenText)) return null;

  const lines = page.screenText.split(/\r?\n/);
  let footerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/Enter to select/i.test(lines[i])) {
      footerIndex = i;
      break;
    }
  }
  if (footerIndex < 0) return null;

  let optionBlockEnd = footerIndex - 1;
  for (let i = footerIndex - 1; i >= 0; i -= 1) {
    if (/^─+$/.test(lines[i].trim())) {
      optionBlockEnd = i - 1;
      break;
    }
  }

  const optionLineIndexes: number[] = [];
  for (let i = optionBlockEnd; i >= 0; i -= 1) {
    const line = lines[i];
    if (CLAUDE_TUI_OPTION_PATTERN.test(line)) {
      optionLineIndexes.push(i);
      continue;
    }
    if (optionLineIndexes.length > 0 && (!line.trim() || /^─+$/.test(line.trim()))) break;
  }
  optionLineIndexes.reverse();
  if (optionLineIndexes.length === 0) return null;

  const firstOptionIndex = optionLineIndexes[0];
  let question = '';
  for (let i = firstOptionIndex - 1; i >= 0; i -= 1) {
    const candidate = lines[i].trim();
    if (!candidate || /^─+$/.test(candidate)) continue;
    // Standalone ☐/☒ markers (decorative section dividers in the headered
    // variant) are not the question — keep skipping them.
    if (/^[☐☒]\s*$/.test(candidate)) continue;
    // The headerless variant introduced in claude-cli >=2.1 prefixes the
    // actual question with `☐ ` (e.g. "☐ RPS R1 1라운드 — …"). Previously
    // we skipped any ☐/☒ line and returned null, never opening the picker.
    // Strip the marker so the dashboard label matches the on-screen text.
    const markerMatch = candidate.match(/^[☐☒]\s+(.+)$/);
    if (markerMatch) {
      question = markerMatch[1].trim();
      break;
    }
    question = candidate;
    break;
  }
  if (!question) return null;

  const options: InteractiveOption[] = [];
  let allowFreeform = false;
  for (const optionLineIndex of optionLineIndexes) {
    const match = lines[optionLineIndex].match(CLAUDE_TUI_OPTION_PATTERN);
    if (!match) continue;
    const label = match[2].trim();
    if (/^Chat about this$/i.test(label)) continue;
    if (/^Type something\.?$/i.test(label)) allowFreeform = true;

    const description = readClaudeOptionDescription(lines, optionLineIndex);
    options.push({ label, ...(description ? { description } : {}) });
  }
  if (options.length === 0) return null;

  const header = readString(page.header) || readClaudeHeaderLine(lines, firstOptionIndex - 1);
  return {
    questionId: `q${index + 1}`,
    question,
    ...(header ? { header } : {}),
    multiSelect: detectClaudeTuiMultiSelect(page.screenText),
    options,
    ...(allowFreeform ? { allowFreeform: true } : {}),
  };
}

function parseClaudeInteractiveTuiQuestion(page: ClaudeInteractiveTuiPage, index: number): InteractiveQuestion | null {
  const lines = page.screenText.split(/\r?\n/);
  let navIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes('✔ Submit') && /[☐☒]/.test(lines[i])) {
      navIndex = i;
      break;
    }
  }
  if (navIndex < 0) return parseClaudeHeaderlessInteractiveTuiQuestion(page, index);
  if (!page.screenText.includes('Enter to select')) return null;

  let question = '';
  let questionLineIndex = -1;
  for (let i = navIndex + 1; i < lines.length; i += 1) {
    const candidate = lines[i].trim();
    if (!candidate || /^─+$/.test(candidate)) continue;
    if (candidate === 'Review your answers' || candidate === 'Ready to submit your answers?') return null;
    question = candidate;
    questionLineIndex = i;
    break;
  }
  if (!question) return null;

  const options: InteractiveOption[] = [];
  let allowFreeform = false;
  for (let i = questionLineIndex + 1; i < lines.length; i += 1) {
    const match = lines[i].match(CLAUDE_TUI_OPTION_PATTERN);
    if (!match) continue;
    const label = match[2].trim();
    if (/^Type something\.?$/i.test(label)) {
      allowFreeform = true;
      continue;
    }
    if (/^Chat about this$/i.test(label)) continue;

    let description: string | undefined;
    const nextLine = lines[i + 1]?.trim();
    if (nextLine
      && !CLAUDE_TUI_OPTION_PATTERN.test(lines[i + 1])
      && !/^─+$/.test(nextLine)
      && !/^Enter to select\b/.test(nextLine)) {
      description = nextLine;
    }
    options.push({ label, ...(description ? { description } : {}) });
  }
  if (options.length === 0) return null;

  const header = readString(page.header);
  return {
    questionId: `q${index + 1}`,
    question,
    ...(header ? { header } : {}),
    multiSelect: detectClaudeTuiMultiSelect(page.screenText),
    options,
    ...(allowFreeform ? { allowFreeform: true } : {}),
  };
}

/**
 * Read the question the live claude TUI picker is CURRENTLY focused on, plus
 * whether that focused page renders multi-select checkbox markers.
 *
 * Used to repair a multi-question prompt after the fact: when the daemon
 * Tab-captures pages 2..N it snapshots ~120ms after the Tab keypress, before
 * the newly-focused page's option-row checkbox column has redrawn — so those
 * questions get frozen as multiSelect:false even though the picker is
 * multi-select. Re-reading the focused page on a later status tick (once it has
 * settled) lets us attribute the now-visible glyphs to the matching question
 * and upgrade just that one. Returns null when no picker question is on screen.
 */
export function readFocusedClaudeTuiQuestion(
  screenText: string,
): { question: string; header?: string; multiSelect: boolean } | null {
  if (!screenText.includes('Enter to select')) return null;
  const parsed = parseClaudeInteractiveTuiQuestion({ screenText }, 0);
  if (!parsed) return null;
  return {
    question: parsed.question,
    ...(parsed.header ? { header: parsed.header } : {}),
    multiSelect: parsed.multiSelect,
  };
}

export function detectClaudeAskUserQuestionPromptFromTuiPages(
  pages: ClaudeInteractiveTuiPage[],
  options: { promptId: string; providerType?: string; createdAt?: number },
): InteractivePrompt | null {
  if (pages.length === 0) return null;
  const headers = claudeTuiQuestionHeaders(pages[0].screenText);
  const questions = pages.map((page, index) => parseClaudeInteractiveTuiQuestion({
    ...page,
    header: page.header || headers[index],
  }, index)).filter((question): question is InteractiveQuestion => !!question);
  if (questions.length !== pages.length) return null;
  return {
    promptId: options.promptId,
    origin: 'cli',
    providerType: options.providerType || 'claude-cli',
    createdAt: options.createdAt || Date.now(),
    questions,
  };
}

export function buildClaudeInteractiveTuiAnswerSteps(
  prompt: InteractivePrompt,
  response: InteractivePromptResponse,
): string[] {
  if (response.promptId !== prompt.promptId) throw new Error('Interactive prompt response does not match active prompt');
  const steps: string[] = [];
  for (const question of prompt.questions) {
    const answer = response.answers[question.questionId];
    if (!answer) throw new Error(`Missing answer for ${question.questionId}`);
    const freeformText = answer.freeformText?.trim() ?? '';

    // Defensive multi-select fallback: a checkbox picker is the ONLY way an
    // answer can carry more than one selected label, so treat any such answer
    // as multi-select even when `question.multiSelect` was captured as false.
    // This guards the multi-question capture race: pages 2..N can freeze as
    // single-select (their glyph column hadn't redrawn at Tab-snapshot time),
    // and the old single-select branch would then either throw on 2+ checked
    // boxes or emit a bare digit (cursor move, no toggle) for 1 box — silently
    // dropping that page's selection. Keying off the answer's label count makes
    // the keystroke protocol correct regardless of the captured flag.
    const treatAsMultiSelect = question.multiSelect || answer.selectedLabels.length > 1;

    if (treatAsMultiSelect) {
      // Multi-select: Claude TUI renders each option as a checkbox. The
      // keystroke model here was reverse-engineered live against claude-cli
      // v2.1.170 (do not "simplify" from the screen text — it lies):
      //
      //   * A numeric digit key TOGGLES that option's checkbox directly and
      //     does NOT move the cursor. So a digit alone checks the option.
      //   * Space toggles whatever row the cursor is sitting on (the digit
      //     never moved it), so a trailing Space would spuriously toggle the
      //     cursor's row (usually option 1) — NEVER pair digit+Space here.
      //   * Enter does NOT advance the page; it toggles the cursor's row too.
      //     The ONLY key that commits this question and advances (to the next
      //     question, or to the final "Review your answers" screen for the
      //     last question) is Tab.
      //
      // So: one digit per selected label, then a single Tab to advance.
      const labels = answer.selectedLabels;
      if (labels.length === 0) {
        throw new Error(`Expected at least one selected label for ${question.questionId}`);
      }
      for (const label of labels) {
        const selectedIndex = question.options.findIndex(option => option.label === label);
        if (selectedIndex < 0) throw new Error(`Unknown option for ${question.questionId}: ${label}`);
        steps.push(String(selectedIndex + 1));
      }
      // Tab commits this question's checked set and advances. (Unlike
      // single-select, where the digit auto-advances, a multi-select page
      // stays put under digit input so the user can toggle multiple boxes.)
      steps.push('\t');
    } else if (freeformText) {
      // Freeform: select the "Type something." option (always the last visible
      // option before "Chat about this"), then type the text and confirm.
      const typeOptionIndex = question.options.findIndex(o => /^Type something\.?$/i.test(o.label));
      const optionNumber = typeOptionIndex >= 0 ? typeOptionIndex + 1 : question.options.length;
      steps.push(String(optionNumber));
      // Type the text character by character, then Enter to confirm.
      for (const ch of freeformText) steps.push(ch);
      steps.push('\r');
    } else {
      if (answer.selectedLabels.length !== 1) throw new Error(`Expected one selected label for ${question.questionId}`);
      const selectedIndex = question.options.findIndex(option => option.label === answer.selectedLabels[0]);
      if (selectedIndex < 0) throw new Error(`Unknown option for ${question.questionId}: ${answer.selectedLabels[0]}`);
      // Use numeric key (1-based) to jump directly to the option. This avoids
      // cursor-position drift between questions that arrow-key navigation suffers
      // from — the TUI accepts a digit key to jump straight to that option index.
      steps.push(String(selectedIndex + 1));
    }
  }
  // After all questions are answered, Claude TUI shows a final confirm screen
  // ("Submit answers" / "Cancel"). The first option is pre-selected, so a
  // single Enter confirms and submits.
  steps.push('\r');
  return steps;
}

export function interactivePromptFromClaudeAskUserQuestion(input: unknown, options: {
  promptId: string;
  providerType: string;
  createdAt?: number;
  origin?: InteractivePrompt['origin'];
}): InteractivePrompt | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const questions = Array.isArray(record.questions)
    ? record.questions.map(normalizeQuestion).filter((item): item is InteractiveQuestion => !!item)
    : [];
  if (questions.length === 0) return null;
  return {
    promptId: options.promptId,
    origin: options.origin || 'cli',
    providerType: options.providerType,
    createdAt: options.createdAt || Date.now(),
    questions,
  };
}

export function detectClaudeAskUserQuestionPromptFromJson(value: unknown, providerType = 'claude-cli'): InteractivePrompt | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const blocks: unknown[] = [];
  if (Array.isArray(record.content)) blocks.push(...record.content);
  const message = record.message;
  if (message && typeof message === 'object' && Array.isArray((message as Record<string, unknown>).content)) {
    blocks.push(...((message as Record<string, unknown>).content as unknown[]));
  }
  if (record.type === 'tool_use') blocks.push(record);

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const name = readString(b.name);
    if (b.type !== 'tool_use' || name !== 'AskUserQuestion') continue;
    const id = readString(b.id) || readString(record.id) || `ask-user-${Date.now()}`;
    const prompt = interactivePromptFromClaudeAskUserQuestion(b.input, {
      promptId: id,
      providerType,
      origin: 'cli',
    });
    if (prompt) return prompt;
  }
  return null;
}
