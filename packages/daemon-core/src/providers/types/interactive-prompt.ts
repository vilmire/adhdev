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
