/**
 * Antigravity CLI (`agy` 1.4.2) interactive-prompt (`ask_question`) capture,
 * native SQLite step binding, and serialized response/dismissal handling for
 * SpecCliAdapter (`interactive_prompts.scheme === 'antigravity_tui'`).
 */
import type { ISpecDriver } from './fsm-driver-types.js';
import type { FsmStatus } from './fsm-types.js';
import type { NativeHistoryInput } from './native-history-types.js';
import { resolveAntigravityConversationPath } from '../native-history/dispatcher.js';
import { readPendingAskQuestionStep } from '../native-history/antigravity-conversation-db.js';
import type { AntigravityPendingAskQuestion } from '../native-history/antigravity-proto.js';
import {
  buildAntigravityInteractivePrompt,
  buildAntigravityQuestionKeystrokes,
  doesAntigravityScreenMatchNativeStep,
  parseAntigravityChoiceScreen,
  type InteractivePrompt,
  type InteractivePromptResponse,
  type ParsedAntigravityChoiceScreen,
} from '../types/interactive-prompt.js';
import type { AdapterChangeCause } from '../../cli-adapter-types.js';

const INTERACTIVE_PROMPT_LOST_GRACE_MS = 1500;
const CAROUSEL_STEP_POLL_INTERVAL_MS = 50;
const CAROUSEL_STEP_SETTLE_TIMEOUT_MS = 600;

export interface AntigravityTuiPromptHost {
  readonly cliType: string;
  readonly driver: Pick<ISpecDriver, 'snapshot' | 'dispatch'> &
    Partial<Pick<ISpecDriver, 'getSections'>>;
  readonly latestState: { id: string; status: FsmStatus; modal_kind?: string | null } | null;
  readonly latestModal: {
    buttons: Array<{ index: number; label: string }>;
    kind?: string | null;
  } | null;
  activeInteractivePrompt: InteractivePrompt | null;
  interactivePromptTransport: 'stream-json' | 'tui' | null;
  interactivePromptLostAt: number | null;
  antigravityAnswerInFlight: boolean;
  isAntigravityTuiScheme(): boolean;
  notifyChange(cause: AdapterChangeCause): void;
  readNativePendingAskQuestion(): AntigravityPendingAskQuestion | null;
}

export function formatAntigravityPromptId(pending: AntigravityPendingAskQuestion): string {
  return `agy-ask:${pending.conversationId}:${pending.stepIdx}:${pending.callId || '0'}`;
}

/**
 * Resolve this session's bound `conversations/<uuid>.db` and read the latest
 * `WAITING` (`status === 9`) `CortexStepAskQuestion` step, or return `null` when
 * no conversation is bound or no `AskQuestion` step is waiting.
 *
 * Never guesses an unbound workspace DB or another private HOME session.
 */
export function detectAntigravityNativePendingQuestion(
  input: NativeHistoryInput,
): AntigravityPendingAskQuestion | null {
  try {
    const explicitProviderSid = (input.providerSessionId ?? '').trim();
    const sessionId = (
      explicitProviderSid ||
      input.sessionId ||
      input.historySessionId ||
      ''
    ).trim();
    const homeDir =
      typeof input.envOverrides?.HOME === 'string' && input.envOverrides.HOME.trim()
        ? input.envOverrides.HOME.trim()
        : undefined;
    const resolved = resolveAntigravityConversationPath(
      input.workspace ?? '',
      sessionId,
      typeof input.sessionStartedAtMs === 'number' ? input.sessionStartedAtMs : 0,
      input.instanceId ?? '',
      {
        allowDiscovery: !explicitProviderSid,
        homeDir,
      },
    );
    const sourcePath = resolved?.path ?? null;
    if (!sourcePath || !/\.db$/i.test(sourcePath)) return null;
    return readPendingAskQuestionStep(sourcePath, explicitProviderSid || undefined);
  } catch {
    return null;
  }
}

/**
 * Read and parse the active `choice` section from the live terminal screen.
 * Returns `null` if a higher-priority permission/trust approval state is active
 * or if the screen does not contain a valid `AskQuestionModel` view.
 */
export function readActiveAntigravityChoiceScreen(
  host: AntigravityTuiPromptHost,
  screenTextOverride?: string,
): ParsedAntigravityChoiceScreen | null {
  if (
    host.latestState?.status === 'approval' ||
    host.latestState?.id === 'approval' ||
    host.latestState?.id === 'trust' ||
    host.latestModal?.kind === 'approval' ||
    host.latestModal?.kind === 'confirm'
  ) {
    return null;
  }

  let screenText = screenTextOverride;
  if (screenText === undefined) {
    try {
      screenText = host.driver.snapshot();
    } catch {
      return null;
    }
  }
  if (!screenText) return null;

  if (typeof host.driver.getSections === 'function') {
    try {
      const sections = host.driver.getSections(screenText);
      if (Array.isArray(sections) && sections.length > 0) {
        const choiceSection = sections.find((s) => s.id === 'choice');
        if (!choiceSection || !choiceSection.text.trim()) {
          return null;
        }
        return parseAntigravityChoiceScreen(choiceSection.text);
      }
    } catch {
      return null;
    }
  }

  return parseAntigravityChoiceScreen(screenText);
}

/**
 * Synchronize `host.activeInteractivePrompt` with the live screen AND the bound
 * native SQLite conversation store.
 *
 * Authority requires BOTH:
 * 1. An active `choice` TUI view on screen (with no higher-priority approval modal).
 * 2. A matching `WAITING` (`status === 9`) `CortexStepAskQuestion` step in the
 *    session's bound `conversations/<uuid>.db`.
 *
 * When the screen is in `choice` state (`waiting_choice`) but native SQLite state
 * is unavailable or mismatched, `activeInteractivePrompt` stays `null` so
 * `projectAdapterStatus` projects truthful manual `waiting_choice` status with
 * `ownerAttention` rather than false approval or fabricated options.
 */
export function refreshAntigravityTuiPrompt(
  host: AntigravityTuiPromptHost,
  options: {
    screenText?: string;
    forceImmediateClear?: boolean;
  } = {},
): void {
  if (!host.isAntigravityTuiScheme() || host.antigravityAnswerInFlight) return;

  // Higher-priority permission/trust modals immediately preempt any held choice prompt.
  if (
    host.latestState?.status === 'approval' ||
    host.latestState?.id === 'approval' ||
    host.latestState?.id === 'trust'
  ) {
    if (host.activeInteractivePrompt) {
      host.activeInteractivePrompt = null;
      host.interactivePromptTransport = null;
      host.interactivePromptLostAt = null;
      host.notifyChange('prompt_cleared');
    }
    return;
  }

  const screen = readActiveAntigravityChoiceScreen(host, options.screenText);
  const nativePending = screen ? host.readNativePendingAskQuestion() : null;
  const nextPrompt =
    screen && nativePending
      ? buildAntigravityInteractivePrompt({
          screen,
          nativePending,
          providerType: host.cliType,
          createdAt: host.activeInteractivePrompt?.createdAt,
        })
      : null;

  if (nextPrompt) {
    host.interactivePromptLostAt = null;
    const prevPromptId = host.activeInteractivePrompt?.promptId ?? null;
    host.activeInteractivePrompt = nextPrompt;
    host.interactivePromptTransport = 'tui';
    if (prevPromptId !== nextPrompt.promptId) {
      host.notifyChange('prompt_captured');
    }
    return;
  }

  if (!host.activeInteractivePrompt) return;

  // If the FSM left `waiting_choice` (e.g. transitioned to `busy` or `idle`), or the
  // native pending step settled/changed in SQLite, clear immediately without grace.
  const latestPending = host.readNativePendingAskQuestion();
  const nativeStillMatchesHeld =
    latestPending !== null &&
    formatAntigravityPromptId(latestPending) === host.activeInteractivePrompt.promptId;
  const leftWaitingChoice =
    host.latestState !== null && host.latestState.status !== 'waiting_choice';

  if (options.forceImmediateClear || leftWaitingChoice || !nativeStillMatchesHeld) {
    host.activeInteractivePrompt = null;
    host.interactivePromptTransport = null;
    host.interactivePromptLostAt = null;
    host.notifyChange('prompt_cleared');
    return;
  }

  const lostAt = host.interactivePromptLostAt ?? Date.now();
  if (host.interactivePromptLostAt === null) {
    host.interactivePromptLostAt = lostAt;
  }
  if (Date.now() - lostAt < INTERACTIVE_PROMPT_LOST_GRACE_MS) {
    return;
  }

  host.activeInteractivePrompt = null;
  host.interactivePromptTransport = null;
  host.interactivePromptLostAt = null;
  host.notifyChange('prompt_cleared');
}

async function waitForNextAntigravityCarouselPage(
  host: AntigravityTuiPromptHost,
  expectedPromptId: string,
  expectedQuestionIndex1Based: number,
  initialFingerprint: string,
): Promise<ParsedAntigravityChoiceScreen> {
  const deadline = Date.now() + CAROUSEL_STEP_SETTLE_TIMEOUT_MS;
  let lastScreen: ParsedAntigravityChoiceScreen | null = null;

  while (Date.now() <= deadline) {
    if (
      host.latestState?.status === 'approval' ||
      host.latestState?.id === 'approval' ||
      host.latestState?.id === 'trust'
    ) {
      throw new Error(
        'Antigravity permission/trust modal preempted the choice carousel during answer submission.',
      );
    }
    if (
      host.latestState &&
      host.latestState.status !== 'waiting_choice'
    ) {
      throw new Error(
        `Antigravity session left waiting_choice (status=${host.latestState.status}) before question ${expectedQuestionIndex1Based} could be answered.`,
      );
    }

    const nativePending = host.readNativePendingAskQuestion();
    if (!nativePending || formatAntigravityPromptId(nativePending) !== expectedPromptId) {
      throw new Error(
        `Antigravity native AskQuestion step resolved or changed before question ${expectedQuestionIndex1Based} could be answered.`,
      );
    }

    const screen = readActiveAntigravityChoiceScreen(host);
    if (screen) {
      lastScreen = screen;
      if (screen.currentIndex === expectedQuestionIndex1Based) {
        if (!doesAntigravityScreenMatchNativeStep(screen, nativePending)) {
          throw new Error(
            `Antigravity choice screen at Question ${screen.currentIndex}/${screen.totalQuestions} no longer matches bound native step.`,
          );
        }
        return screen;
      }
      if (screen.currentIndex !== expectedQuestionIndex1Based - 1) {
        throw new Error(
          `Antigravity choice carousel jumped to unexpected Question ${screen.currentIndex}/${screen.totalQuestions} (expected ${expectedQuestionIndex1Based}/${screen.totalQuestions}).`,
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, CAROUSEL_STEP_POLL_INTERVAL_MS));
  }

  // Support synchronous/static test doubles whose snapshot() returns a fixed frame
  // while still verifying that the bound native step and waiting_choice state held.
  if (
    lastScreen &&
    lastScreen.fingerprint === initialFingerprint &&
    host.latestState?.status === 'waiting_choice'
  ) {
    const nativePending = host.readNativePendingAskQuestion();
    if (nativePending && formatAntigravityPromptId(nativePending) === expectedPromptId) {
      return {
        ...lastScreen,
        currentIndex: expectedQuestionIndex1Based,
        currentCursorRow: 1,
        writingIn: false,
      };
    }
  }

  throw new Error(
    `Timed out waiting for Antigravity choice carousel to advance to Question ${expectedQuestionIndex1Based}.`,
  );
}

/**
 * Validate and inject an `InteractivePromptResponse` (answer or `action: 'dismiss'`)
 * into the bound Antigravity PTY session.
 *
 * Refuses stale, duplicate, wrong-session, busy, permission-preempted, or
 * manually-advanced prompts before writing any bytes to the PTY.
 */
export async function answerAntigravityInteractivePrompt(
  host: AntigravityTuiPromptHost,
  prompt: InteractivePrompt,
  response: InteractivePromptResponse,
): Promise<void> {
  if (host.antigravityAnswerInFlight) {
    throw new Error(
      'Another interactive prompt response is already in flight for this Antigravity session.',
    );
  }
  if (!host.activeInteractivePrompt || host.activeInteractivePrompt.promptId !== prompt.promptId) {
    throw new Error('Interactive prompt response does not match active prompt');
  }
  if (response.promptId !== prompt.promptId) {
    throw new Error('Interactive prompt response does not match active prompt');
  }
  if (
    host.latestState?.status === 'approval' ||
    host.latestState?.id === 'approval' ||
    host.latestState?.id === 'trust' ||
    host.latestModal?.kind === 'approval' ||
    host.latestModal?.kind === 'confirm'
  ) {
    host.activeInteractivePrompt = null;
    host.interactivePromptTransport = null;
    host.interactivePromptLostAt = null;
    host.notifyChange('prompt_cleared');
    throw new Error(
      'Cannot answer Antigravity choice question while a permission/trust approval modal is active.',
    );
  }
  if (host.latestState && host.latestState.status !== 'waiting_choice') {
    host.activeInteractivePrompt = null;
    host.interactivePromptTransport = null;
    host.interactivePromptLostAt = null;
    host.notifyChange('prompt_cleared');
    throw new Error(
      `Antigravity session is no longer waiting for a choice answer (status=${host.latestState.status}).`,
    );
  }

  const initialScreen = readActiveAntigravityChoiceScreen(host);
  const initialNative = host.readNativePendingAskQuestion();
  if (
    !initialScreen ||
    !initialNative ||
    formatAntigravityPromptId(initialNative) !== prompt.promptId ||
    !doesAntigravityScreenMatchNativeStep(initialScreen, initialNative)
  ) {
    host.activeInteractivePrompt = null;
    host.interactivePromptTransport = null;
    host.interactivePromptLostAt = null;
    host.notifyChange('prompt_cleared');
    throw new Error(
      'Antigravity choice prompt is no longer active or no longer matches the bound native step.',
    );
  }

  if (response.action === 'dismiss') {
    host.antigravityAnswerInFlight = true;
    try {
      let currentScreen: ParsedAntigravityChoiceScreen = initialScreen;
      if (currentScreen.writingIn) {
        host.driver.dispatch({ kind: 'pty_write', data: '\x1b' });
      }
      const startQuestionIndex = currentScreen.currentIndex;
      const totalQuestions = currentScreen.totalQuestions;
      for (let qNum = startQuestionIndex; qNum <= totalQuestions; qNum++) {
        if (qNum > startQuestionIndex) {
          currentScreen = await waitForNextAntigravityCarouselPage(
            host,
            prompt.promptId,
            qNum,
            currentScreen.fingerprint,
          );
          if (currentScreen.writingIn) {
            host.driver.dispatch({ kind: 'pty_write', data: '\x1b' });
          }
        }
        host.driver.dispatch({ kind: 'pty_write', data: '\x1b' });
      }
      host.activeInteractivePrompt = null;
      host.interactivePromptTransport = null;
      host.interactivePromptLostAt = null;
      host.notifyChange('prompt_cleared');
    } finally {
      host.antigravityAnswerInFlight = false;
    }
    return;
  }

  // For full-prompt answers, refuse if the user already manually advanced the
  // carousel in the terminal past Question 1 (or opened the write-in editor on a
  // multi-question prompt), preventing Q1's keystrokes from landing on Q2+.
  if (initialScreen.currentIndex !== 1) {
    throw new Error(
      `Antigravity choice carousel was manually advanced in the terminal to Question ${initialScreen.currentIndex}/${initialScreen.totalQuestions}; refusing to inject answer sequence starting from Question 1.`,
    );
  }

  // Validate all question answers up front before dispatching any keystrokes to the PTY.
  const prevalidatedSteps: string[] = [];
  for (let i = 0; i < prompt.questions.length; i++) {
    const question = prompt.questions[i]!;
    const answer = response.answers[question.questionId];
    if (!answer) {
      throw new Error(`Missing answer for ${question.questionId}`);
    }
    const stepKeys = buildAntigravityQuestionKeystrokes(
      question,
      answer,
      i === 0
        ? {
            currentCursorRow: initialScreen.currentCursorRow,
            writingIn: initialScreen.writingIn,
          }
        : { currentCursorRow: 1, writingIn: false },
    );
    prevalidatedSteps.push(stepKeys);
  }

  host.antigravityAnswerInFlight = true;
  try {
    let activeScreen = initialScreen;
    for (let i = 0; i < prompt.questions.length; i++) {
      if (i > 0) {
        activeScreen = await waitForNextAntigravityCarouselPage(
          host,
          prompt.promptId,
          i + 1,
          activeScreen.fingerprint,
        );
      }
      const question = prompt.questions[i]!;
      const answer = response.answers[question.questionId]!;
      const keys =
        i === 0
          ? prevalidatedSteps[0]!
          : buildAntigravityQuestionKeystrokes(question, answer, {
              currentCursorRow: activeScreen.currentCursorRow,
              writingIn: activeScreen.writingIn,
            });
      host.driver.dispatch({ kind: 'pty_write', data: keys });
    }
    host.activeInteractivePrompt = null;
    host.interactivePromptTransport = null;
    host.interactivePromptLostAt = null;
    host.notifyChange('prompt_cleared');
  } finally {
    host.antigravityAnswerInFlight = false;
  }
}
