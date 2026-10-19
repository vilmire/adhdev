import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  AGY_STATUS_WAITING,
  AGY_STEP_TYPE_ASK_QUESTION,
  extractPendingAskQuestionFromStepPayload,
} from '../../../src/providers/native-history/antigravity-proto.js';
import { readPendingAskQuestionStep } from '../../../src/providers/native-history/antigravity-conversation-db.js';
import { __resetAntigravityClaimRegistry } from '../../../src/providers/native-history/antigravity-claim-registry.js';
import {
  buildAntigravityCancelKeystrokes,
  buildAntigravityInteractivePrompt,
  buildAntigravityInteractiveTuiAnswerSteps,
  buildAntigravityQuestionKeystrokes,
  parseAntigravityChoiceScreen,
} from '../../../src/providers/types/interactive-prompt.js';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import type { DashboardEvent, ISpecDriver } from '../../../src/providers/spec/fsm-driver-types.js';
import type { FsmStatus } from '../../../src/providers/spec/fsm-types.js';

// ── Protobuf Wire Encoding Helpers for Tests ─────────────────────────────────

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeLengthDelimited(fieldNumber: number, payload: Buffer | string): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(buf.length), buf]);
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(value)]);
}

function buildAskQuestionOptionProto(label: string, id?: string): Buffer {
  const parts: Buffer[] = [];
  if (id) parts.push(encodeLengthDelimited(1, id));
  parts.push(encodeLengthDelimited(2, label));
  return Buffer.concat(parts);
}

function buildAskQuestionItemProto(params: {
  questionText: string;
  options: Array<{ label: string; id?: string }>;
  isMultiSelect?: boolean;
}): Buffer {
  const parts: Buffer[] = [encodeLengthDelimited(1, params.questionText)];
  for (const opt of params.options) {
    parts.push(encodeLengthDelimited(2, buildAskQuestionOptionProto(opt.label, opt.id)));
  }
  if (params.isMultiSelect) {
    parts.push(encodeVarintField(3, 1));
  }
  return Buffer.concat(parts);
}

function buildStepPayloadWithField154(params: {
  callId?: string;
  toolName?: string;
  questions: Array<{
    questionText: string;
    options: Array<{ label: string; id?: string }>;
    isMultiSelect?: boolean;
  }>;
  hasResponse?: boolean;
}): Buffer {
  const parts: Buffer[] = [];
  // Metadata submessage (field 5): 5.3 = toolName, 5.5 = callId
  const metaParts: Buffer[] = [];
  if (params.toolName) metaParts.push(encodeLengthDelimited(3, params.toolName));
  if (params.callId) metaParts.push(encodeLengthDelimited(5, params.callId));
  if (metaParts.length > 0) {
    parts.push(encodeLengthDelimited(5, Buffer.concat(metaParts)));
  }

  // CortexStepAskQuestion submessage (field 154)
  const askParts: Buffer[] = [];
  for (const q of params.questions) {
    askParts.push(encodeLengthDelimited(1, buildAskQuestionItemProto(q)));
  }
  if (params.hasResponse) {
    // field 154.3 = response entry
    askParts.push(encodeLengthDelimited(3, encodeLengthDelimited(1, 'already-answered')));
  }
  parts.push(encodeLengthDelimited(154, Buffer.concat(askParts)));
  return Buffer.concat(parts);
}

function buildStepPayloadWithJsonFallback(params: {
  submessageField: 5 | 20;
  callId: string;
  questions: Array<{
    question: string;
    options: string[];
    is_multi_select?: boolean;
  }>;
}): Buffer {
  const jsonArgs = JSON.stringify({ questions: params.questions });
  if (params.submessageField === 5) {
    const meta = Buffer.concat([
      encodeLengthDelimited(3, 'ask_question'),
      encodeLengthDelimited(4, jsonArgs),
      encodeLengthDelimited(5, params.callId),
    ]);
    return encodeLengthDelimited(5, meta);
  }
  const toolCall = Buffer.concat([
    encodeLengthDelimited(1, params.callId),
    encodeLengthDelimited(2, 'ask_question'),
    encodeLengthDelimited(7, jsonArgs),
  ]);
  return encodeLengthDelimited(20, toolCall);
}

function createConversationDb(
  dbPath: string,
  rows: Array<{ idx: number; step_type: number; status: number; step_payload: Buffer }>,
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      DROP TABLE IF EXISTS steps;
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER NOT NULL,
        status INTEGER NOT NULL,
        step_payload BLOB NOT NULL,
        task_details BLOB
      );
    `);
    const insert = db.prepare(
      'INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)',
    );
    for (const row of rows) {
      insert.run(row.idx, row.step_type, row.status, row.step_payload);
    }
  } finally {
    db.close();
  }
}

// ── 1. Protobuf & SQLite WAITING (status === 9) Decoder Tests ────────────────

describe('Antigravity native-history AskQuestion decoder (field 154 + JSON fallback, status 9 only)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-askq-test-'));
    __resetAntigravityClaimRegistry();
  });

  afterEach(() => {
    __resetAntigravityClaimRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('decodes field 154 CortexStepAskQuestion single-select, multi-select, and carousel questions', () => {
    const payload = buildStepPayloadWithField154({
      callId: 'call-ask-101',
      toolName: 'ask_question',
      questions: [
        {
          questionText: 'Which runtime target should we use?',
          options: [
            { label: 'Node.js 22 (Recommended)', id: 'opt-node' },
            { label: 'Bun', id: 'opt-bun' },
          ],
          isMultiSelect: false,
        },
        {
          questionText: 'Which checks should run before commit?',
          options: [{ label: 'Typecheck' }, { label: 'Unit tests' }, { label: 'Lint' }],
          isMultiSelect: true,
        },
      ],
    });

    const decoded = extractPendingAskQuestionFromStepPayload(payload);
    expect(decoded).not.toBeNull();
    expect(decoded?.callId).toBe('call-ask-101');
    expect(decoded?.toolName).toBe('ask_question');
    expect(decoded?.questions).toHaveLength(2);
    expect(decoded?.questions[0]).toEqual({
      questionText: 'Which runtime target should we use?',
      options: [
        { id: 'opt-node', text: 'Node.js 22 (Recommended)', label: 'Node.js 22 (Recommended)' },
        { id: 'opt-bun', text: 'Bun', label: 'Bun' },
      ],
      multiSelect: false,
      isMultiSelect: false,
    });
    expect(decoded?.questions[1]).toEqual({
      questionText: 'Which checks should run before commit?',
      options: [
        { id: 'opt_1', text: 'Typecheck', label: 'Typecheck' },
        { id: 'opt_2', text: 'Unit tests', label: 'Unit tests' },
        { id: 'opt_3', text: 'Lint', label: 'Lint' },
      ],
      multiSelect: true,
      isMultiSelect: true,
    });
  });

  it('rejects field 154 payload when responses (154.3) are already recorded', () => {
    const answeredPayload = buildStepPayloadWithField154({
      callId: 'call-ask-answered',
      toolName: 'ask_question',
      questions: [
        {
          questionText: 'Already answered?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
      hasResponse: true,
    });
    expect(extractPendingAskQuestionFromStepPayload(answeredPayload)).toBeNull();
  });

  it('falls back to 5.4 and 20.7 ask_question JSON arguments when field 154 is absent', () => {
    for (const subField of [5, 20] as const) {
      const payload = buildStepPayloadWithJsonFallback({
        submessageField: subField,
        callId: `call-json-${subField}`,
        questions: [
          {
            question: 'Select deployment region:',
            options: ['us-east-1', 'eu-west-1'],
            is_multi_select: false,
          },
        ],
      });
      const decoded = extractPendingAskQuestionFromStepPayload(payload);
      expect(decoded).not.toBeNull();
      expect(decoded?.callId).toBe(`call-json-${subField}`);
      expect(decoded?.questions).toEqual([
        {
          questionText: 'Select deployment region:',
          options: [
            { id: 'opt_1', text: 'us-east-1', label: 'us-east-1' },
            { id: 'opt_2', text: 'eu-west-1', label: 'eu-west-1' },
          ],
          multiSelect: false,
          isMultiSelect: false,
        },
      ]);
    }
  });

  it('reads pending AskQuestion from SQLite ONLY when status === 9 (WAITING) and conversationId matches', () => {
    const convUuid = '11111111-2222-4333-8444-555555555555';
    const foreignUuid = '99999999-8888-4777-8666-555555555555';
    const dbPath = path.join(tmpDir, '.gemini', 'antigravity-cli', 'conversations', `${convUuid}.db`);
    const payload = buildStepPayloadWithField154({
      callId: 'call-waiting-9',
      toolName: 'ask_question',
      questions: [
        {
          questionText: 'Choose cache strategy:',
          options: [{ label: 'In-memory LRU' }, { label: 'Redis' }],
          isMultiSelect: false,
        },
      ],
    });

    createConversationDb(dbPath, [
      { idx: 1, step_type: 14, status: 3, step_payload: Buffer.from([0x08, 0x01]) },
      { idx: 2, step_type: AGY_STEP_TYPE_ASK_QUESTION, status: AGY_STATUS_WAITING, step_payload: payload },
    ]);

    const hit = readPendingAskQuestionStep(dbPath, convUuid);
    expect(hit).not.toBeNull();
    expect(hit?.conversationId).toBe(convUuid);
    expect(hit?.stepIdx).toBe(2);
    expect(hit?.callId).toBe('call-waiting-9');

    // Foreign expectedConversationId must fail closed.
    expect(readPendingAskQuestionStep(dbPath, foreignUuid)).toBeNull();

    // Settled step (status === 3 DONE) must return null.
    const settledDbPath = path.join(
      tmpDir,
      '.gemini',
      'antigravity-cli',
      'conversations',
      '22222222-2222-4333-8444-555555555555.db',
    );
    createConversationDb(settledDbPath, [
      { idx: 1, step_type: 14, status: 3, step_payload: Buffer.from([0x08, 0x01]) },
      { idx: 2, step_type: AGY_STEP_TYPE_ASK_QUESTION, status: 3, step_payload: payload },
    ]);
    expect(readPendingAskQuestionStep(settledDbPath)).toBeNull();

    // If a later assistant/user step (step_type 15) was appended after a leftover status 9 row, reject.
    const supersededDbPath = path.join(
      tmpDir,
      '.gemini',
      'antigravity-cli',
      'conversations',
      '33333333-2222-4333-8444-555555555555.db',
    );
    createConversationDb(supersededDbPath, [
      { idx: 2, step_type: AGY_STEP_TYPE_ASK_QUESTION, status: AGY_STATUS_WAITING, step_payload: payload },
      { idx: 3, step_type: 15, status: 3, step_payload: Buffer.from([0x08, 0x01]) },
    ]);
    expect(readPendingAskQuestionStep(supersededDbPath)).toBeNull();
  });
});

// ── 2. Screen Parser & Keystroke Builder Tests ───────────────────────────────

describe('Antigravity TUI choice screen parser and keystroke builder (antigravity_tui)', () => {
  it('parses single-select, multi-select, and write-in screens and strips K+1 Write-in... into allowFreeform', () => {
    const singleScreen = [
      '  Question',
      '  ────────────────────────────────────────',
      '  Question 1/2: Which database engine should we use?',
      '    1. PostgreSQL',
      '  > 2. SQLite',
      '    3. Write-in...',
      '',
      '  ↑/↓ Navigate • Enter Select • <esc> Skip',
    ].join('\n');

    const parsedSingle = parseAntigravityChoiceScreen(singleScreen);
    expect(parsedSingle).not.toBeNull();
    expect(parsedSingle?.currentIndex).toBe(1);
    expect(parsedSingle?.totalQuestions).toBe(2);
    expect(parsedSingle?.multiSelect).toBe(false);
    expect(parsedSingle?.currentCursorRow).toBe(2);
    expect(parsedSingle?.writeInRowIndex).toBe(3);
    expect(parsedSingle?.options).toEqual([
      { index: 1, label: 'PostgreSQL', checked: false },
      { index: 2, label: 'SQLite', checked: false },
    ]);

    const multiScreen = [
      '  Question',
      '  ────────────────────────────────────────',
      '  Question 2/2: Which features should be enabled?',
      '  > 1. [x] WAL mode',
      '    2. [ ] Foreign keys',
      '    3. Write-in...',
      '',
      '  ↑/↓ Navigate • space Toggle • Enter Submit • <esc> Skip',
    ].join('\n');

    const parsedMulti = parseAntigravityChoiceScreen(multiScreen);
    expect(parsedMulti).not.toBeNull();
    expect(parsedMulti?.currentIndex).toBe(2);
    expect(parsedMulti?.totalQuestions).toBe(2);
    expect(parsedMulti?.multiSelect).toBe(true);
    expect(parsedMulti?.options).toEqual([
      { index: 1, label: 'WAL mode', checked: true },
      { index: 2, label: 'Foreign keys', checked: false },
    ]);

    const writeInScreen = [
      '  Question',
      '  ────────────────────────────────────────',
      '  Question 1/1: Enter custom port:',
      '  Your answer:',
      '  > 8080',
      '',
      '  Enter Submit • <esc> Back',
    ].join('\n');

    const parsedWriteIn = parseAntigravityChoiceScreen(writeInScreen);
    expect(parsedWriteIn).not.toBeNull();
    expect(parsedWriteIn?.writingIn).toBe(true);
    expect(parsedWriteIn?.currentIndex).toBe(1);
    expect(parsedWriteIn?.totalQuestions).toBe(1);
  });

  it('rejects quoted choice screens followed by composer or live spinner and ordinary numbered prose', () => {
    const quotedWithComposer = [
      '  Question',
      '  ────────────────────────────────────────',
      '  Question 1/1: Quoted question?',
      '  > 1. Option A',
      '    2. Write-in...',
      '  ↑/↓ Navigate • Enter Select • <esc> Skip',
      '  ────────────────────────────────────────',
      '  > Type your message',
    ].join('\n');
    expect(parseAntigravityChoiceScreen(quotedWithComposer)).toBeNull();

    const numberedProse = [
      '  1. First item',
      '  2. Second item',
      '  3. Write-in...',
    ].join('\n');
    expect(parseAntigravityChoiceScreen(numberedProse)).toBeNull();
  });

  it('builds exact agy 1.4.2 keystrokes: single digit auto-advance, multi digit toggle+Enter (no Tab), write-in K+1+text+Enter, >9 arrows from cursor, and Esc skip (no final review Enter)', () => {
    // 1. Single-select <= 9: bare digit, no \r
    const singleQ = {
      questionId: 'q1',
      question: 'Pick one:',
      multiSelect: false,
      allowFreeform: true,
      options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
    };
    expect(buildAntigravityQuestionKeystrokes(singleQ, { selectedLabels: ['Beta'] })).toBe('2');

    // 2. Single-select freeform write-in: K+1 = 4 -> '4' + text + '\r'
    expect(
      buildAntigravityQuestionKeystrokes(singleQ, {
        selectedLabels: [],
        freeformText: 'Custom value',
      }),
    ).toBe('4Custom value\r');

    // 3. Multi-select <= 9: digits toggle, then '\r' (never '\t')
    const multiQ = {
      questionId: 'q2',
      question: 'Pick many:',
      multiSelect: true,
      allowFreeform: true,
      options: [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }],
    };
    const multiKeys = buildAntigravityQuestionKeystrokes(multiQ, {
      selectedLabels: ['One', 'Three'],
    });
    expect(multiKeys).toBe('13\r');
    expect(multiKeys).not.toContain('\t');

    // 4. >9 options single-select and multi-select respecting actual currentCursorRow
    const twelveOptions = Array.from({ length: 12 }, (_, idx) => ({
      label: `Option ${idx + 1}`,
    }));
    const largeSingleQ = {
      questionId: 'qLargeSingle',
      question: 'Pick from 12:',
      multiSelect: false,
      allowFreeform: true,
      options: twelveOptions,
    };
    // Cursor currently at row 3, target row 11 -> 8 down arrows + '\r'
    expect(
      buildAntigravityQuestionKeystrokes(
        largeSingleQ,
        { selectedLabels: ['Option 11'] },
        { currentCursorRow: 3 },
      ),
    ).toBe(`${'\x1b[B'.repeat(8)}\r`);

    const largeMultiQ = {
      questionId: 'qLargeMulti',
      question: 'Pick multiple from 12:',
      multiSelect: true,
      allowFreeform: true,
      options: twelveOptions,
    };
    // Select Option 2 (digit '2' moves cursor to row 2 & toggles) and Option 11 (9 down arrows + Space), then '\r'
    expect(
      buildAntigravityQuestionKeystrokes(
        largeMultiQ,
        { selectedLabels: ['Option 2', 'Option 11'] },
        { currentCursorRow: 5 },
      ),
    ).toBe(`2${'\x1b[B'.repeat(9)} \r`);

    // 5. Carousel answer steps: NO trailing final review '\r' after last question
    const carouselPrompt = {
      promptId: 'agy-ask:conv:1:call',
      origin: 'cli' as const,
      providerType: 'antigravity-cli',
      createdAt: 1000,
      questions: [singleQ, multiQ],
    };
    const steps = buildAntigravityInteractiveTuiAnswerSteps(carouselPrompt, {
      promptId: 'agy-ask:conv:1:call',
      answers: {
        q1: { selectedLabels: ['Alpha'] },
        q2: { selectedLabels: ['Two', 'Three'] },
      },
    });
    expect(steps).toEqual(['1', '23\r']);

    // 6. Cancel / Skip: N - M + 1 Esc presses (plus 1 leading Esc if writingIn)
    expect(buildAntigravityCancelKeystrokes({ currentIndex: 1, totalQuestions: 3 })).toBe(
      '\x1b\x1b\x1b',
    );
    expect(
      buildAntigravityCancelKeystrokes({ currentIndex: 2, totalQuestions: 3, writingIn: true }),
    ).toBe('\x1b\x1b\x1b');
  });
});

// ── 3. SpecCliAdapter End-to-End Binding, Serialization & Negative Guards ────

describe('SpecCliAdapter Antigravity choice-question binding & response safety', () => {
  let tmpHome: string;
  const convUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const foreignUuid = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-adapter-choice-'));
    __resetAntigravityClaimRegistry();
  });

  afterEach(() => {
    __resetAntigravityClaimRegistry();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function createHarness(params: {
    screenText: string;
    stateId?: string;
    status?: FsmStatus;
    providerSessionId?: string;
  }) {
    let currentScreen = params.screenText;
    let currentState = {
      id: params.stateId ?? 'choice',
      label: params.stateId === 'approval' ? 'Approval requested' : 'Question requested',
      title: null as string | null,
      status: (params.status ?? 'waiting_choice') as FsmStatus,
    };
    let currentModal: {
      title: string | null;
      buttons: Array<{ index: number; label: string }>;
      kind?: 'approval' | 'picker' | 'confirm' | 'choice' | null;
    } | null = null;
    const writes: string[] = [];
    let eventHandler: ((ev: DashboardEvent) => void) | null = null;

    const fakeDriver: ISpecDriver = {
      dispatch(cmd) {
        if (cmd.kind === 'pty_write') {
          writes.push(cmd.data);
          onPtyWrite?.(cmd.data);
        }
      },
      onEvent(cb) {
        eventHandler = cb;
        return () => {
          eventHandler = null;
        };
      },
      snapshot: () => currentScreen,
      getScreen: () => currentScreen,
      getSections: (text: string) => [{ id: 'choice', text, startLine: 0, endLine: 20 }],
      getStateHistory: () => [],
      clickModalButton: () => false,
      detach: () => {},
    };

    let onPtyWrite: ((data: string) => void) | null = null;

    const adapter = Object.create(SpecCliAdapter.prototype) as SpecCliAdapter &
      Record<string, any>;
    adapter.cliType = 'antigravity-cli';
    adapter.cliName = 'Antigravity CLI';
    adapter.workingDir = path.join(tmpHome, 'workspace');
    adapter.driver = fakeDriver;
    adapter.spec = {
      id: 'antigravity-cli',
      name: 'Antigravity CLI',
      interactive_prompts: { scheme: 'antigravity_tui' },
      native_history: { reader: 'antigravity-cli' },
    };
    adapter.spawned = true;
    adapter.exited = false;
    adapter.spawnedAtMs = 1000;
    adapter.spawnedEnv = { HOME: tmpHome };
    adapter.owningSessionId = 'session-agy-1';
    adapter.providerSessionId = params.providerSessionId ?? convUuid;
    adapter.latestState = currentState;
    adapter.latestModal = currentModal;
    adapter.activeInteractivePrompt = null;
    adapter.interactivePromptTransport = null;
    adapter.interactivePromptLostAt = null;
    adapter.antigravityAnswerInFlight = false;
    adapter.runtimeSettings = {};

    return {
      adapter,
      writes,
      setScreen(next: string) {
        currentScreen = next;
      },
      setState(next: { id: string; label: string; title: string | null; status: FsmStatus }) {
        currentState = next;
        adapter.latestState = next;
      },
      setModal(next: typeof currentModal) {
        currentModal = next;
        adapter.latestModal = next;
      },
      setOnPtyWrite(fn: ((data: string) => void) | null) {
        onPtyWrite = fn;
      },
      emitStateChanged() {
        eventHandler?.({ kind: 'state_changed', state: currentState, modal: currentModal } as any);
      },
    };
  }

  const carouselQ1Screen = [
    '  Question',
    '  ────────────────────────────────────────',
    '  Question 1/2: Which database engine should we use?',
    '  > 1. PostgreSQL',
    '    2. SQLite',
    '    3. Write-in...',
    '',
    '  ↑/↓ Navigate • Enter Select • <esc> Skip',
  ].join('\n');

  const carouselQ2Screen = [
    '  Question',
    '  ────────────────────────────────────────',
    '  Question 2/2: Which features should be enabled?',
    '  > 1. [ ] WAL mode',
    '    2. [ ] Foreign keys',
    '    3. Write-in...',
    '',
    '  ↑/↓ Navigate • space Toggle • Enter Submit • <esc> Skip',
  ].join('\n');

  function writeBoundWaitingDb(uuid = convUuid, status = AGY_STATUS_WAITING) {
    const dbPath = path.join(
      tmpHome,
      '.gemini',
      'antigravity-cli',
      'conversations',
      `${uuid}.db`,
    );
    const payload = buildStepPayloadWithField154({
      callId: 'call-carousel-42',
      toolName: 'ask_question',
      questions: [
        {
          questionText: 'Which database engine should we use?',
          options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
          isMultiSelect: false,
        },
        {
          questionText: 'Which features should be enabled?',
          options: [{ label: 'WAL mode' }, { label: 'Foreign keys' }],
          isMultiSelect: true,
        },
      ],
    });
    createConversationDb(dbPath, [
      { idx: 1, step_type: 14, status: 3, step_payload: Buffer.from([0x08, 0x01]) },
      { idx: 7, step_type: AGY_STEP_TYPE_ASK_QUESTION, status, step_payload: payload },
    ]);
    return dbPath;
  }

  it('projects truthful manual waiting_choice fallback (no activeModal, no fabricated options) when native DB is unavailable or unbound', () => {
    // Only a foreign conversation DB exists on disk; our bound convUuid has no DB yet.
    writeBoundWaitingDb(foreignUuid, AGY_STATUS_WAITING);
    const { adapter } = createHarness({
      screenText: carouselQ1Screen,
      providerSessionId: convUuid,
    });

    const status = adapter.getStatus();
    expect(status.status).toBe('waiting_choice');
    expect(status.activeModal).toBeNull();
    expect(status.activeInteractivePrompt).toBeNull();
    expect(status.ownerAttention).toEqual({
      stateId: 'choice',
      message: 'Question requested',
    });
  });

  it('binds live choice screen + WAITING native step and answers a 2-question carousel end-to-end with no trailing Enter', async () => {
    writeBoundWaitingDb(convUuid, AGY_STATUS_WAITING);
    const { adapter, writes, setScreen } = createHarness({
      screenText: carouselQ1Screen,
      providerSessionId: convUuid,
    });

    const status = adapter.getStatus();
    expect(status.status).toBe('waiting_choice');
    expect(status.activeModal).toBeNull();
    expect(status.ownerAttention).toBeUndefined();
    expect(status.activeInteractivePrompt).not.toBeNull();
    expect(status.activeInteractivePrompt?.promptId).toBe(
      `agy-ask:${convUuid}:7:call-carousel-42`,
    );
    expect(status.activeInteractivePrompt?.questions).toHaveLength(2);
    expect(status.activeInteractivePrompt?.questions[0]?.allowFreeform).toBe(true);
    expect(status.activeInteractivePrompt?.questions[1]?.multiSelect).toBe(true);

    // When Q1 is answered with '2' (SQLite), advance the mock screen to Question 2/2.
    setOnPtyWriteForCarousel();
    function setOnPtyWriteForCarousel() {
      adapter.driver.dispatch = (cmd) => {
        if (cmd.kind === 'pty_write') {
          writes.push(cmd.data);
          if (writes.length === 1) {
            setScreen(carouselQ2Screen);
          }
        }
      };
    }

    await adapter.setInteractivePromptResponse({
      promptId: `agy-ask:${convUuid}:7:call-carousel-42`,
      answers: {
        q1: { selectedLabels: ['SQLite'] },
        q2: { selectedLabels: ['WAL mode', 'Foreign keys'] },
      },
    });

    // Q1 single-select -> '2'; Q2 multi-select -> '12\r' (no Tab, no trailing final review '\r')
    expect(writes).toEqual(['2', '12\r']);
    expect(adapter.activeInteractivePrompt).toBeNull();
  });

  it('refuses stale, duplicate, manually-advanced, settled-DB, or permission-preempted responses without writing to PTY', async () => {
    writeBoundWaitingDb(convUuid, AGY_STATUS_WAITING);
    const { adapter, writes, setScreen, setState, setModal } = createHarness({
      screenText: carouselQ1Screen,
      providerSessionId: convUuid,
    });

    const prompt = adapter.getStatus().activeInteractivePrompt!;
    expect(prompt).not.toBeNull();

    // 1. Stale promptId
    await expect(
      adapter.setInteractivePromptResponse({
        promptId: 'agy-ask:stale:1:call',
        answers: { q1: { selectedLabels: ['PostgreSQL'] }, q2: { selectedLabels: ['WAL mode'] } },
      }),
    ).rejects.toThrow(/does not match active prompt/);
    expect(writes).toHaveLength(0);

    // 2. Manually advanced carousel in terminal (screen is already on Question 2/2)
    setScreen(carouselQ2Screen);
    await expect(
      adapter.setInteractivePromptResponse({
        promptId: prompt.promptId,
        answers: { q1: { selectedLabels: ['PostgreSQL'] }, q2: { selectedLabels: ['WAL mode'] } },
      }),
    ).rejects.toThrow(/manually advanced/);
    expect(writes).toHaveLength(0);

    // Restore Q1 screen and re-capture
    setScreen(carouselQ1Screen);
    expect(adapter.getStatus().activeInteractivePrompt?.promptId).toBe(prompt.promptId);

    // 3. Permission modal preempts choice state -> refuses choice answer
    setState({ id: 'approval', label: 'Approval requested', title: null, status: 'approval' });
    setModal({
      title: 'Do you want to proceed?',
      buttons: [
        { index: 1, label: 'Yes' },
        { index: 2, label: 'No' },
      ],
      kind: 'approval',
    });
    await expect(
      adapter.setInteractivePromptResponse({
        promptId: prompt.promptId,
        answers: { q1: { selectedLabels: ['PostgreSQL'] }, q2: { selectedLabels: ['WAL mode'] } },
      }),
    ).rejects.toThrow(/permission\/trust approval modal is active/);
    expect(writes).toHaveLength(0);

    // 4. Native step settled in SQLite (status === 3 DONE) -> refuses answer
    setState({ id: 'choice', label: 'Question requested', title: null, status: 'waiting_choice' });
    setModal(null);
    writeBoundWaitingDb(convUuid, AGY_STATUS_WAITING);
    expect(adapter.getStatus().activeInteractivePrompt?.promptId).toBe(prompt.promptId);
    writeBoundWaitingDb(convUuid, 3); // settled in DB before answer arrives
    await expect(
      adapter.setInteractivePromptResponse({
        promptId: prompt.promptId,
        answers: { q1: { selectedLabels: ['PostgreSQL'] }, q2: { selectedLabels: ['WAL mode'] } },
      }),
    ).rejects.toThrow(/no longer active or no longer matches/);
    expect(writes).toHaveLength(0);
  });

  it('aborts mid-carousel if a permission modal preempts after Question 1 so trailing keys never hit the approval modal', async () => {
    writeBoundWaitingDb(convUuid, AGY_STATUS_WAITING);
    const { adapter, writes, setState, setModal } = createHarness({
      screenText: carouselQ1Screen,
      providerSessionId: convUuid,
    });

    const prompt = adapter.getStatus().activeInteractivePrompt!;
    adapter.driver.dispatch = (cmd) => {
      if (cmd.kind === 'pty_write') {
        writes.push(cmd.data);
        // Simulate a permission modal appearing right after Q1 keystrokes
        setState({ id: 'approval', label: 'Approval requested', title: null, status: 'approval' });
        setModal({
          title: 'Allow calling this tool?',
          buttons: [
            { index: 1, label: 'Yes' },
            { index: 2, label: 'No' },
          ],
          kind: 'approval',
        });
      }
    };

    await expect(
      adapter.setInteractivePromptResponse({
        promptId: prompt.promptId,
        answers: {
          q1: { selectedLabels: ['PostgreSQL'] },
          q2: { selectedLabels: ['WAL mode'] },
        },
      }),
    ).rejects.toThrow(/preempted/);

    // Only Q1's key ('1') was sent; Q2's keys ('1\r') were NOT injected into the approval modal!
    expect(writes).toEqual(['1']);
  });

  it('F1: rejects when carousel screen fails to advance to Question 2/2 after timeout and never dispatches Question 2 keys', async () => {
    writeBoundWaitingDb(convUuid, AGY_STATUS_WAITING);
    const { adapter, writes } = createHarness({
      screenText: carouselQ1Screen,
      providerSessionId: convUuid,
    });

    const prompt = adapter.getStatus().activeInteractivePrompt!;
    expect(prompt).not.toBeNull();

    // Screen remains stuck on Question 1/2 even after Q1 keystrokes are written.
    await expect(
      adapter.setInteractivePromptResponse({
        promptId: prompt.promptId,
        answers: {
          q1: { selectedLabels: ['PostgreSQL'] },
          q2: { selectedLabels: ['WAL mode'] },
        },
      }),
    ).rejects.toThrow(/Timed out waiting for Antigravity choice carousel to advance to Question 2/);

    // Only Q1 ('1') was dispatched; Q2 was stopped.
    expect(writes).toEqual(['1']);
    expect(adapter.activeInteractivePrompt).toBeNull();

    // Even if getStatus() refreshes while screen and DB remain unchanged, the consumed
    // promptId must not re-arm or allow a replay.
    expect(adapter.getStatus().activeInteractivePrompt).toBeNull();
  });

  it('F1 (dismiss): enforces observation fences across carousel skip and write-in exit', async () => {
    writeBoundWaitingDb(convUuid, AGY_STATUS_WAITING);
    const { adapter, writes } = createHarness({
      screenText: carouselQ1Screen,
      providerSessionId: convUuid,
    });

    const prompt = adapter.getStatus().activeInteractivePrompt!;
    // Screen stays stuck on Question 1/2 when dismiss is requested -> sends only first Esc and rejects
    await expect(
      adapter.setInteractivePromptResponse({
        promptId: prompt.promptId,
        action: 'dismiss',
        answers: {},
      }),
    ).rejects.toThrow(/Timed out waiting for Antigravity choice carousel to advance to Question 2/);
    expect(writes).toEqual(['\x1b']);
  });

  it('F2: reconciles live pre-checked checkboxes (wanted, unwanted, mixed, multi+write-in, >9 cursor, and live Q2 carousel edits)', async () => {
    const multiQ = {
      questionId: 'qMulti',
      question: 'Select checks:',
      multiSelect: true,
      allowFreeform: true,
      options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
    };

    // 1. Pre-checked wanted ('Alpha' already [x]) -> only '\r' (does NOT toggle Alpha off)
    expect(
      buildAntigravityQuestionKeystrokes(
        multiQ,
        { selectedLabels: ['Alpha'] },
        { currentlyCheckedRows: [1] },
      ),
    ).toBe('\r');

    // 2. Pre-checked unwanted ('Alpha' [x], user wants 'Beta') -> '12\r'
    expect(
      buildAntigravityQuestionKeystrokes(
        multiQ,
        { selectedLabels: ['Beta'] },
        { currentlyCheckedRows: [1] },
      ),
    ).toBe('12\r');

    // 3. Mixed pre-checked ('Alpha' [x], 'Beta' [x], user wants 'Alpha' & 'Gamma') -> '23\r'
    expect(
      buildAntigravityQuestionKeystrokes(
        multiQ,
        { selectedLabels: ['Alpha', 'Gamma'] },
        { currentlyCheckedRows: [1, 2] },
      ),
    ).toBe('23\r');

    // 4. Multi-select + Write-in with 'Alpha' already [x] and user wants 'Alpha' + freeform -> '4Custom\r'
    expect(
      buildAntigravityQuestionKeystrokes(
        multiQ,
        { selectedLabels: ['Alpha'], freeformText: 'Custom' },
        { currentlyCheckedRows: [1] },
      ),
    ).toBe('4Custom\r');

    // 5. >9 options with pre-checked row 2 (unwanted) and row 11 (already wanted), user wants row 10 & row 11
    const twelveOptions = Array.from({ length: 12 }, (_, idx) => ({
      label: `Option ${idx + 1}`,
    }));
    const largeMultiQ = {
      questionId: 'qLargeMulti',
      question: 'Pick multiple from 12:',
      multiSelect: true,
      allowFreeform: true,
      options: twelveOptions,
    };
    expect(
      buildAntigravityQuestionKeystrokes(
        largeMultiQ,
        { selectedLabels: ['Option 10', 'Option 11'] },
        { currentCursorRow: 4, currentlyCheckedRows: [2, 11] },
      ),
    ).toBe(`2${'\x1b[B'.repeat(8)} \r`);

    // 6. Refuses safely when multi-select is in writingIn mode and checkbox state is unobservable
    expect(() =>
      buildAntigravityQuestionKeystrokes(
        multiQ,
        { selectedLabels: ['Alpha'] },
        { writingIn: true },
      ),
    ).toThrow(/Cannot reconcile multi-select checkboxes/);

    // 7. Adapter end-to-end carousel where Question 2/2 arrives with 'WAL mode' already [x]
    writeBoundWaitingDb(convUuid, AGY_STATUS_WAITING);
    const q2PrecheckedScreen = [
      '  Question',
      '  ────────────────────────────────────────',
      '  Question 2/2: Which features should be enabled?',
      '    1. [x] WAL mode',
      '  > 2. [ ] Foreign keys',
      '    3. Write-in...',
      '',
      '  ↑/↓ Navigate • space Toggle • Enter Submit • <esc> Skip',
    ].join('\n');

    const { adapter, writes, setScreen } = createHarness({
      screenText: carouselQ1Screen,
      providerSessionId: convUuid,
    });
    const prompt = adapter.getStatus().activeInteractivePrompt!;
    adapter.driver.dispatch = (cmd) => {
      if (cmd.kind === 'pty_write') {
        writes.push(cmd.data);
        if (writes.length === 1) {
          setScreen(q2PrecheckedScreen);
        }
      }
    };

    await adapter.setInteractivePromptResponse({
      promptId: prompt.promptId,
      answers: {
        q1: { selectedLabels: ['PostgreSQL'] },
        q2: { selectedLabels: ['WAL mode'] },
      },
    });
    // Q1 -> '1'; Q2 ('WAL mode' already [x]) -> '\r'
    expect(writes).toEqual(['1', '\r']);
  });

  it('F3: prevents consumed native (conversationId, stepIdx, callId) tuple from re-arming across status refresh while allowing a new stepIdx/callId episode', async () => {
    writeBoundWaitingDb(convUuid, AGY_STATUS_WAITING);
    const singleScreen = [
      '  Question',
      '  ────────────────────────────────────────',
      '  Question 1/1: Which database engine should we use?',
      '  > 1. PostgreSQL',
      '    2. SQLite',
      '    3. Write-in...',
      '',
      '  ↑/↓ Navigate • Enter Select • <esc> Skip',
    ].join('\n');

    const singleDbPath = path.join(
      tmpHome,
      '.gemini',
      'antigravity-cli',
      'conversations',
      `${convUuid}.db`,
    );
    const step7Payload = buildStepPayloadWithField154({
      callId: 'call-single-7',
      toolName: 'ask_question',
      questions: [
        {
          questionText: 'Which database engine should we use?',
          options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
          isMultiSelect: false,
        },
      ],
    });
    createConversationDb(singleDbPath, [
      { idx: 1, step_type: 14, status: 3, step_payload: Buffer.from([0x08, 0x01]) },
      { idx: 7, step_type: AGY_STEP_TYPE_ASK_QUESTION, status: AGY_STATUS_WAITING, step_payload: step7Payload },
    ]);

    const { adapter, writes } = createHarness({
      screenText: singleScreen,
      providerSessionId: convUuid,
    });

    const firstPrompt = adapter.getStatus().activeInteractivePrompt!;
    expect(firstPrompt?.promptId).toBe(`agy-ask:${convUuid}:7:call-single-7`);

    const response = {
      promptId: firstPrompt.promptId,
      answers: { q1: { selectedLabels: ['PostgreSQL'] } },
    };
    await adapter.setInteractivePromptResponse(response);
    expect(writes).toEqual(['1']);

    // Status refresh before native repaint / DB settlement must NOT recapture the consumed step
    expect(adapter.getStatus().activeInteractivePrompt).toBeNull();

    // Replaying the same response must reject and write nothing
    await expect(adapter.setInteractivePromptResponse(response)).rejects.toThrow(
      /already submitted|does not match active prompt/i,
    );
    expect(writes).toEqual(['1']);

    // A new AskQuestion episode at stepIdx 11 in the same conversation captures and answers normally
    const step11Payload = buildStepPayloadWithField154({
      callId: 'call-single-11',
      toolName: 'ask_question',
      questions: [
        {
          questionText: 'Which database engine should we use?',
          options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
          isMultiSelect: false,
        },
      ],
    });
    createConversationDb(singleDbPath, [
      { idx: 1, step_type: 14, status: 3, step_payload: Buffer.from([0x08, 0x01]) },
      { idx: 7, step_type: AGY_STEP_TYPE_ASK_QUESTION, status: 3, step_payload: step7Payload },
      { idx: 11, step_type: AGY_STEP_TYPE_ASK_QUESTION, status: AGY_STATUS_WAITING, step_payload: step11Payload },
    ]);

    const secondPrompt = adapter.getStatus().activeInteractivePrompt!;
    expect(secondPrompt?.promptId).toBe(`agy-ask:${convUuid}:11:call-single-11`);
    await adapter.setInteractivePromptResponse({
      promptId: secondPrompt.promptId,
      answers: { q1: { selectedLabels: ['SQLite'] } },
    });
    expect(writes).toEqual(['1', '2']);
  });

  it('F1 (ordinary answer from open Write-in): splits Escape from option keys, requires observed Write-in exit on Q1 and Q2, and aborts on stalled exit or preemption', async () => {
    const q1WriteInScreen = [
      '  Question',
      '  ────────────────────────────────────────',
      '',
      '  Question 1/2: Which database engine should we use?',
      '  Your answer:',
      '  >',
      '  enter Submit · esc Back',
    ].join('\n');

    const q1OptionsScreen = [
      '  Question',
      '  ────────────────────────────────────────',
      '',
      '  Question 1/2: Which database engine should we use?',
      '  > 1. PostgreSQL',
      '    2. SQLite',
      '    3. Write-in...',
      '  ↑/↓ Navigate · enter Submit · esc Skip',
    ].join('\n');

    const q2WriteInScreen = [
      '  Question',
      '  ────────────────────────────────────────',
      '',
      '  Question 2/2: Which runtime?',
      '  Your answer:',
      '  >',
      '  enter Submit · esc Back',
    ].join('\n');

    const q2OptionsScreen = [
      '  Question',
      '  ────────────────────────────────────────',
      '',
      '  Question 2/2: Which runtime?',
      '  > 1. Node 22',
      '    2. Bun',
      '    3. Write-in...',
      '  ↑/↓ Navigate · enter Submit All · esc Skip',
    ].join('\n');

    const dbPath = path.join(
      tmpHome,
      '.gemini',
      'antigravity-cli',
      'conversations',
      `${convUuid}.db`,
    );
    const writeTwoSingleDb = (callId: string, stepIdx: number) => {
      const payload = buildStepPayloadWithField154({
        callId,
        toolName: 'ask_question',
        questions: [
          {
            questionText: 'Which database engine should we use?',
            options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
            isMultiSelect: false,
          },
          {
            questionText: 'Which runtime?',
            options: [{ label: 'Node 22' }, { label: 'Bun' }],
            isMultiSelect: false,
          },
        ],
      });
      createConversationDb(dbPath, [
        { idx: 1, step_type: 14, status: 3, step_payload: Buffer.from([0x08, 0x01]) },
        { idx: stepIdx, step_type: AGY_STEP_TYPE_ASK_QUESTION, status: AGY_STATUS_WAITING, step_payload: payload },
      ]);
    };

    // 1. Stalled Write-in exit on Q1: sends only '\x1b', times out, and never sends option digit
    writeTwoSingleDb('call-wi-1', 10);
    const h1 = createHarness({ screenText: q1WriteInScreen, providerSessionId: convUuid });
    const p1 = h1.adapter.getStatus().activeInteractivePrompt!;
    await expect(
      h1.adapter.setInteractivePromptResponse({
        promptId: p1.promptId,
        answers: {
          q1: { selectedLabels: ['PostgreSQL'] },
          q2: { selectedLabels: ['Bun'] },
        },
      }),
    ).rejects.toThrow(/Timed out waiting for Antigravity Write-in editor to return to options on Question 1/);
    expect(h1.writes).toEqual(['\x1b']);

    // 2. Permission preemption between '\x1b' and option selection on Q1 aborts before option digit
    writeTwoSingleDb('call-wi-2', 11);
    const h2 = createHarness({ screenText: q1WriteInScreen, providerSessionId: convUuid });
    const p2 = h2.adapter.getStatus().activeInteractivePrompt!;
    h2.adapter.driver.dispatch = (cmd) => {
      if (cmd.kind === 'pty_write') {
        h2.writes.push(cmd.data);
        h2.setModal({
          kind: 'approval',
          title: 'Do you want to proceed?',
          buttons: [{ label: 'Yes', keys: '1' }],
        });
      }
    };
    await expect(
      h2.adapter.setInteractivePromptResponse({
        promptId: p2.promptId,
        answers: {
          q1: { selectedLabels: ['PostgreSQL'] },
          q2: { selectedLabels: ['Bun'] },
        },
      }),
    ).rejects.toThrow(/permission\/trust modal preempted/i);
    expect(h2.writes).toEqual(['\x1b']);

    // 3. Stalled Write-in exit on Q2: Q1 answers '1', Q2 opens in Write-in, sends '\x1b', times out before '2'
    writeTwoSingleDb('call-wi-3', 12);
    const h3 = createHarness({ screenText: q1OptionsScreen, providerSessionId: convUuid });
    const p3 = h3.adapter.getStatus().activeInteractivePrompt!;
    h3.adapter.driver.dispatch = (cmd) => {
      if (cmd.kind === 'pty_write') {
        h3.writes.push(cmd.data);
        if (h3.writes.length === 1) {
          h3.setScreen(q2WriteInScreen);
        }
      }
    };
    await expect(
      h3.adapter.setInteractivePromptResponse({
        promptId: p3.promptId,
        answers: {
          q1: { selectedLabels: ['PostgreSQL'] },
          q2: { selectedLabels: ['Bun'] },
        },
      }),
    ).rejects.toThrow(/Timed out waiting for Antigravity Write-in editor to return to options on Question 2/);
    expect(h3.writes).toEqual(['1', '\x1b']);

    // 4. Observed Write-in exit on both Q1 and Q2 dispatches separate '\x1b' then option digits and succeeds
    writeTwoSingleDb('call-wi-4', 13);
    const h4 = createHarness({ screenText: q1WriteInScreen, providerSessionId: convUuid });
    const p4 = h4.adapter.getStatus().activeInteractivePrompt!;
    h4.adapter.driver.dispatch = (cmd) => {
      if (cmd.kind === 'pty_write') {
        h4.writes.push(cmd.data);
        if (h4.writes.length === 1) {
          h4.setScreen(q1OptionsScreen);
        } else if (h4.writes.length === 2) {
          h4.setScreen(q2WriteInScreen);
        } else if (h4.writes.length === 3) {
          h4.setScreen(q2OptionsScreen);
        }
      }
    };
    await h4.adapter.setInteractivePromptResponse({
      promptId: p4.promptId,
      answers: {
        q1: { selectedLabels: ['PostgreSQL'] },
        q2: { selectedLabels: ['Bun'] },
      },
    });
    expect(h4.writes).toEqual(['\x1b', '1', '\x1b', '2']);

    // 5. Sibling multi-select Q2 arriving in Write-in editor refuses without sending any Q2 bytes
    writeBoundWaitingDb(convUuid, AGY_STATUS_WAITING);
    const q2MultiWriteInScreen = [
      '  Question',
      '  ────────────────────────────────────────',
      '',
      '  Question 2/2: Which features should be enabled?',
      '  Your answer:',
      '  >',
      '  enter Submit · esc Back',
    ].join('\n');
    const h5 = createHarness({ screenText: carouselQ1Screen, providerSessionId: convUuid });
    const p5 = h5.adapter.getStatus().activeInteractivePrompt!;
    h5.adapter.driver.dispatch = (cmd) => {
      if (cmd.kind === 'pty_write') {
        h5.writes.push(cmd.data);
        if (h5.writes.length === 1) {
          h5.setScreen(q2MultiWriteInScreen);
        }
      }
    };
    await expect(
      h5.adapter.setInteractivePromptResponse({
        promptId: p5.promptId,
        answers: {
          q1: { selectedLabels: ['PostgreSQL'] },
          q2: { selectedLabels: ['WAL mode'] },
        },
      }),
    ).rejects.toThrow(/Cannot reconcile multi-select checkboxes/);
    expect(h5.writes).toEqual(['1']);
  });
});
