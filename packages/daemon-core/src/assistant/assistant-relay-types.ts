/** Relay clock and queue/part shapes shared by assistant-relay.ts (moved out of it unchanged). */
import type { SendPolicy, SubmitOutcome, TurnOutcome } from '@adhdev/mesh-shared';
import type { Unsubscribe } from '../sessions/lifecycle-bus.js';
import type { AssistantInputLog } from './assistant-input-log.js';
import type { AssistantRelayBusEvent } from './assistant-relay.js';
import type { AttemptReportSnapshot } from './assistant-native-window.js';
import type { ReportContinuation } from './report-continuation.js';
import type { AssistantRelayStore } from './assistant-relay-store.js';
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
    gap?: { item: Item & { kind: 'line' }; replies: AuditedCoordinatorReply[] }; surfaced?: string[];
    /** Not news for the owner (a capture miss, a "still working" ping): it rides along with a real update but never wakes the assistant alone. */
    quiet?: boolean };

/** One entry of `assistant_pending_relays` → `assistantEvents` (MCP-only assistant). */
export interface AssistantPulledEvent {
    source: AssistantInputSource;
    messageId: string;
    text: string;
    meshId?: string;
}

export type Item =
    | { kind: 'relay'; meshId: string; coordinatorSessionId: string; attemptIds: string[]; outcome: TurnOutcome; committedAt: number; idle: boolean }
    | { kind: 'line'; source: AssistantInputSource; text: string; messageId: string; meshId?: string; forSessionId?: string; gapReplies?: AuditedCoordinatorReply[];
        /** A ping with no new content: waits for a real update to ride along with; dropped after `RELAY_QUIET_LINE_TTL_MS`. */
        quiet?: boolean; queuedAt?: number };

export interface MeshWorkCounts { activeMissions: number; pending: number; assigned: number }

/**
 * A remote-hosted project's state as its host's poll answered (content-free;
 * assistant/assistant-remote-relay.ts). Its turns arrive through
 * `onRemoteCommitted`, the host's ledger having committed them.
 */
export interface RemoteProjectSnapshot {
    /** A plain attempt is open on the host's coordinator (it is working). */
    open: boolean;
    /** The coordinator is parked on an approval or a choice. */
    modal: boolean;
    work: MeshWorkCounts | null;
    /** The host's content-free `[Mesh]` line. */
    statusLine: string | null;
}

export interface AssistantRelayPorts {
    /** e.g. `bus.on(ASSISTANT_RELAY_BUS_KINDS, h, { name: 'assistant.relay' })`. */
    subscribe(handler: (event: AssistantRelayBusEvent) => void): Unsubscribe;
    /** `meshCoordinatorFor` of a live session, or null. */
    coordinatorMeshOf(sessionId: string): string | null;
    /** Project slug; null when the mesh no longer exists. */
    projectSlug(meshId: string): string | null;
    /** Session-only diagnostic projection. Never evidence for an exact attempt capture. */
    readCoordinatorTail(sessionId: string): Promise<string | null>;
    /**
     * Existing evidence only; exact attempt/session/mesh, never the newest tail
     * and never `readCoordinatorTail`. A string is a legacy exact body
     * (`final_native`). A snapshot without `completeness: 'final_native'`
     * (old remote hosts) is unverified.
     */
    rehydrateAttemptReport?(meshId: string, sessionId: string, attemptId: string): Promise<AttemptReportSnapshot | string | null>;
    /** Native finals since `sinceMs` for the missing-relay detector. */
    auditCoordinatorReplies?(sinceMs: number): Promise<readonly AuditedCoordinatorReply[] & { complete?: boolean }>;
    /** Recheck the exact project_read cursor before waking the assistant. */
    canReadCoordinatorReply?(reply: AuditedCoordinatorReply): Promise<boolean>;
    readCoordinatorReference?(meshId: string, sessionId: string): Promise<ReportContinuation | null>;
    /** Local metric bump for one uncovered native final. */
    onRelayGap?(klass: 'no_attempt' | 'inside_attempt' | 'restart_closed', at: number): void;
    /** Content-free `[Mesh]` line (`buildMeshStatusLineForNotification`). */
    meshStatusLine?(meshId: string): string | null;
    meshWork(meshId: string): MeshWorkCounts | null;
    /** Registry: does an assistant entry exist at all (trigger condition 3)? */
    hasAssistant(): boolean;
    /** Registry: the bound assistant session, or null. */
    assistantSessionId(): string | null;
    /** Live: the assistant will take input now (ready status, no modal). */
    isAssistantReady(sessionId: string): boolean;
    /**
     * Driver FIFO membership (`SessionInputService.isParked`). Lets a parked
     * human input be logged exactly when the drain writes it. Absent → the
     * oldest parked human input is logged on each assistant turn start.
     */
    isParked?(sessionId: string, messageId: string): Promise<boolean>;
    /** The existing submit funnel (`send_chat` / SessionInputService), `origin` set by the adapter. */
    submit(sessionId: string, input: { text: string; messageId: string; policy: SendPolicy }): Promise<SubmitOutcome>;
    inputLog: AssistantInputLog;
    store: AssistantRelayStore;
    /** Delivery hook (registry `markFirstRelay`, metrics). */
    onRelayDelivered?(meshIds: readonly string[], at: number): void;
    /** An idle review input (§4.10.7) reached the assistant (review history, `review_turns`). */
    onReviewDelivered?(sessionId: string, messageId: string, at: number): void;
    /** Native submit confirmation only; MCP pulls need their own receipt acknowledgement. */
    onInputsSubmitted?(sessionId: string, messageIds: readonly string[], at: number): void;
    clock?: RelayClock;
    /** Short notices before a full relay push (relay-nudge.ts); 0 pushes at once. */
    maxNudgeAttempts?: number;
    nudgeBackoffMs?: number;
}
