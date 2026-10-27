/** Relay clock and queue/part shapes shared by assistant-relay.ts (moved out of it unchanged). */
import type { TurnOutcome } from '@adhdev/mesh-shared';
import type { AuditedCoordinatorReply } from './assistant-native-window.js';
import type { RenderedAttemptCoverage } from './assistant-relay-store.js';
import type { AssistantInputSource } from './store-guards.js';

export interface RelayClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export const realClock: RelayClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Batch {
    coordinatorSessionId: string;
    attemptIds: string[];
    outcome: TurnOutcome;
    firstCommitAt: number;
    lastCommitAt: number;
    quietTimer: unknown;
    maxTimer: unknown;
}

export interface RenderedReportPage {
    attemptId: string; reportId: string; offset: number; totalPoints: number;
    coverage?: RenderedAttemptCoverage;
    autoStopped?: boolean;
}
/** `gap`: replies of a queued notice this part announces. `surfaced`: attempts the assistant is told about by notice/cursor instead of a body. */
export type Part = { text: string; source: AssistantInputSource; messageId: string; meshId?: string; reports?: RenderedReportPage[];
    gap?: { item: Item & { kind: 'line' }; replies: AuditedCoordinatorReply[] }; surfaced?: string[] };

/** One entry of `assistant_pending_relays` → `assistantEvents` (MCP-only assistant). */
export interface AssistantPulledEvent {
    source: AssistantInputSource;
    messageId: string;
    text: string;
    meshId?: string;
}

export type Item =
    | { kind: 'relay'; meshId: string; coordinatorSessionId: string; attemptIds: string[]; outcome: TurnOutcome; committedAt: number; idle: boolean }
    | { kind: 'line'; source: AssistantInputSource; text: string; messageId: string; meshId?: string; forSessionId?: string; gapReplies?: AuditedCoordinatorReply[] };
