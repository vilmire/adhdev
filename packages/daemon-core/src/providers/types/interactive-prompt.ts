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

const CLAUDE_TUI_OPTION_PATTERN = /^\s*(?:[❯›>]\s*)?(\d+)\.\s+(.+?)\s*$/;

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
  return /Enter to select/i.test(text) && /Esc to cancel/i.test(text);
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
  if (!isClaudeTuiSelectFooter(page.screenText)) return null;
  if (!/Type something\.?|Chat about this/i.test(page.screenText)) return null;

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
    multiSelect: /Space to select|toggle selections/i.test(page.screenText),
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
    multiSelect: /Space to select|toggle selections/i.test(page.screenText),
    options,
    ...(allowFreeform ? { allowFreeform: true } : {}),
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
    if (question.multiSelect) throw new Error('Claude TUI multi-select prompts are not supported yet');
    const answer = response.answers[question.questionId];
    if (!answer) throw new Error(`Missing answer for ${question.questionId}`);
    if (answer.freeformText) throw new Error('Claude TUI freeform answers are not supported yet');
    if (answer.selectedLabels.length !== 1) throw new Error(`Expected one selected label for ${question.questionId}`);
    const selectedIndex = question.options.findIndex(option => option.label === answer.selectedLabels[0]);
    if (selectedIndex < 0) throw new Error(`Unknown option for ${question.questionId}: ${answer.selectedLabels[0]}`);
    // Use numeric key (1-based) to jump directly to the option. This avoids
    // cursor-position drift between questions that arrow-key navigation suffers
    // from — the TUI accepts a digit key to jump straight to that option index.
    steps.push(String(selectedIndex + 1));
  }
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
