/**
 * Read-only projections of the spec-path adapter: the debug bundle
 * (getDebugSnapshot) and the PTY screen scrapes (assistant bubbles, codex
 * session id). Split out of cli-adapter.ts (file-size gate). Pure functions of
 * the values the adapter hands in — nothing here mutates adapter state.
 */
import type { ISpecDriver } from './fsm-driver-types.js';
import type { FsmStatus } from './fsm-types.js';
import type { ChatMessage } from '../../types.js';
import type { InteractivePrompt } from '../types/interactive-prompt.js';
import { extractAntigravityScreenAssistantMessages } from './antigravity-screen-messages.js';
import { stripAnsi } from './provider-failure-classifier.js';

/** The adapter values the debug bundle reports. */
export interface SpecDebugView {
    cliType: string;
    cliName: string;
    specId: string;
    workingDir: string;
    spawned: boolean;
    exited: boolean;
    exitCode: number | null;
    providerFailureKind: string | null;
    spawnedAtMs: number;
    providerSessionId: string | undefined;
    latestState: { id: string; label: string; title: string | null; status: FsmStatus } | null;
    latestModal: unknown;
    activeInteractivePrompt: InteractivePrompt | null;
    status: string | undefined;
    messages: unknown[];
}

/**
 * The one debug bundle: spec_debug, the chat debug bundle (web-core
 * spec-debug-normalize.ts) and the dev CLI debugger (dev-cli-debug.ts,
 * dashboards) all read this shape.
 */
export function buildSpecDebugSnapshot(v: SpecDebugView, driver: ISpecDriver): Record<string, unknown> {
    let screen = '';
    let sections: Record<string, string> | undefined;
    try {
        screen = driver.snapshot();
        // Pass `screen` so the sections describe the frame we just captured
        // (see FsmDriver.getSections) rather than a later repaint.
        sections = Object.fromEntries((driver.getSections?.(screen) ?? []).map(s => [s.id, s.text]));
    } catch { /* best-effort */ }
    return {
        cliType: v.cliType,
        type: v.cliType,
        spec_id: v.specId,
        current_state: v.latestState,
        current_modal: v.latestModal,
        activeModal: v.latestModal ?? null,
        activeInteractivePrompt: v.activeInteractivePrompt,
        exited: v.exited,
        exitCode: v.exitCode,
        providerFailureKind: v.providerFailureKind,
        ready: v.spawned,
        screen,
        screenText: screen,
        sections,
        stateHistory: driver.getStateHistory(),
        idleHoldPending: driver.hasIdleHoldPending(),
        lastBusyAt: driver.getLastBusyAt(),
        specPath: driver.getSpecPath(),
        cursorPosition: driver.getCursorPosition(),
        completionIdleDebounce: driver.getCompletionIdleDebounceState(),
        // v4 FSM live transition table. Every outgoing transition from the
        // current state with its per-condition match result + countdown — the
        // canonical "why isn't it moving" answer.
        fsm: driver.getFsmDebug?.() ?? null,
        // The full pre-transition evaluation table captured at each transition
        // — answers "why did this rule fire" after the fact, unlike the live
        // `fsm` field which only reflects the current instant.
        fsmHistory: driver.getFsmSnapshotHistory?.() ?? null,
        // PTY input/output/resize/cursor event timeline (debug-only) so the
        // snapshot shows what we typed / what the PTY printed around each
        // status transition. Null for drivers without the timeline.
        eventTimeline: driver.getEventTimeline?.() ?? null,
        // Extended fields
        name: v.cliName,
        status: v.status,
        workingDir: v.workingDir,
        spawnedAtMs: v.spawnedAtMs,
        providerSessionId: v.providerSessionId ?? null,
        messages: v.messages,
        committedMessages: v.messages,
    };
}

/** codex-cli prints its session uuid in the status line (`model · effort · <uuid>`). */
export function extractCodexSessionIdFromScreen(screenText: string): string | undefined {
    const clean = stripAnsi(screenText);
    const match = clean.match(/(?:gpt-|o\d|codex-)[^\n·]*·[^\n·]*·\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return match?.[1];
}

/** Providers whose assistant bubbles can be scraped off the PTY screen. */
export function screenScrapeSupported(cliType: string): boolean {
    return cliType === 'claude-cli' || cliType === 'antigravity-cli';
}

/**
 * PTY-scrape assistant bubbles for the live parse / spec-debug snapshot.
 *
 * Native-history remains the completion-path authority
 * (`chatMessagesOwnedExternally`). This scrape is the fail-closed
 * fallback the gate already consults via getScriptParsedStatus().messages
 * when the on-disk transcript has no final standard assistant — which is
 * the antigravity layout where the JSON report is on screen under
 * `● Bash(...)` but never lands as a step_type-15 field-20 answer.
 *
 * `bodySection` is the spec's resolved `body` section of this same frame
 * (claude only), or undefined to scan the whole screen.
 */
export function scrapeScreenAssistantMessages(cliType: string, screenText: string, bodySection: string | undefined): ChatMessage[] {
    if (cliType === 'antigravity-cli') return extractAntigravityScreenAssistantMessages(screenText);
    if (cliType !== 'claude-cli') return [];
    const body = bodySection || screenText;
    const messages: ChatMessage[] = [];
    const seen = new Set<string>();
    for (const line of body.split(/\r?\n/)) {
        const match = line.match(/^\s*⏺\s+(.+?)\s*$/);
        const content = match?.[1]?.trim();
        if (!content || seen.has(content)) continue;
        seen.add(content);
        messages.push({
            role: 'assistant',
            kind: 'standard',
            content,
            source: 'assistant_text',
            userFacing: true,
            bubbleState: 'final',
        });
    }
    return messages;
}
