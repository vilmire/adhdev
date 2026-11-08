/**
 * Screen / transcript reads for the spec-path adapter — split out of
 * cli-adapter.ts for the file-size gate (move only, no behavior change). Each
 * function takes exactly what the corresponding SpecCliAdapter method read from
 * `this`; the adapter methods are thin delegates.
 */
import type { ISpecDriver } from './fsm-driver-types.js';
import type { ChatMessage } from '../../types.js';
import type { NativeHistoryConfig } from './types.js';
import type { NativeHistoryInput } from './native-history-types.js';
import type { KimiPendingQuestionReader } from '../kimi-pending-question.js';
import { detectBackgroundTaskActive, backgroundTaskSnapshot, type BackgroundTaskDetection } from './background-task-detector.js';
import {
    extractCodexSessionIdFromScreen, scrapeScreenAssistantMessages, screenScrapeSupported,
} from './spec-adapter-readouts.js';

export function readCurrentScreenSections(driver: ISpecDriver, screenText: string): Record<string, string> {
    try {
        // Resolve against the caller's screen, not a fresh read.
        const sections = driver.getSections(screenText) ?? [];
        return Object.fromEntries(sections.map(section => [section.id, section.text]));
    } catch {
        return {};
    }
}

export function extractProviderSessionIdFromScreen(driver: ISpecDriver, cliType: string, providerSessionId: string | undefined): string | undefined {
    if (cliType !== 'codex-cli') return providerSessionId;
    let screenText = '';
    try {
        screenText = driver.snapshot();
    } catch {
        return providerSessionId;
    }
    return extractCodexSessionIdFromScreen(screenText) || providerSessionId;
}

/** PTY-scrape assistant bubbles — see scrapeScreenAssistantMessages. */
export function readScreenAssistantMessages(driver: ISpecDriver, cliType: string): ChatMessage[] {
    if (!screenScrapeSupported(cliType)) return [];
    let screenText = '';
    try {
        screenText = driver.snapshot();
    } catch {
        return [];
    }
    const body = cliType === 'claude-cli' ? readCurrentScreenSections(driver, screenText).body : undefined;
    return scrapeScreenAssistantMessages(cliType, screenText, body);
}

export function detectSpecBackgroundTask(
    cliType: string,
    nativeHistory: NativeHistoryConfig | undefined,
    existingKimiBackgroundReader: KimiPendingQuestionReader | undefined,
    ensureKimiBackgroundReader: () => KimiPendingQuestionReader,
    nativeHistoryInput: (opts: { withOwner: boolean }) => NativeHistoryInput,
): BackgroundTaskDetection {
    if (cliType === 'kimi' && (nativeHistory?.source?.kind === 'jsonl' || existingKimiBackgroundReader)) {
        const reader = ensureKimiBackgroundReader();
        const view = reader.read(nativeHistory, nativeHistoryInput({ withOwner: false }));
        return backgroundTaskSnapshot(view.state, view.background);
    }
    if (!nativeHistory?.source) {
        // antigravity-cli declares no declarative `source` (its authority is
        // the per-session conversations/<uuid>.db, read via the built-in
        // reader) — the detector dispatches on agentType and resolves the
        // store itself. Without this branch antigravity reported
        // support:'unknown' and the background_task_active hold was silently
        // inert (the early-completion defect: a worker ending its turn with
        // an async run_command still running projected completed).
        if (cliType === 'antigravity-cli') {
            try {
                return detectBackgroundTaskActive(undefined, nativeHistoryInput({ withOwner: true }));
            } catch {
                return { active: false, count: 0, ids: [], support: 'unknown' };
            }
        }
        // No transcript source: only the detector can say whether this
        // provider is tracked at all (claude-cli/kimi) or unknown.
        return { active: false, count: 0, ids: [], support: cliType === 'claude-cli' || cliType === 'kimi' ? 'tracked' : 'unknown' };
    }
    try {
        return detectBackgroundTaskActive(nativeHistory, nativeHistoryInput({ withOwner: false }));
    } catch {
        return { active: false, count: 0, ids: [], support: 'unknown' };
    }
}
