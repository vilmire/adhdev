/**
 * Human input into the assistant session — the one hook through which a
 * dashboard chat send reaches the assistant input log (design
 * 2026-10-07-assistant-layer.md §4.10.2 check 5, §4.10.7).
 *
 * `send_chat` (commands/chat-commands-write.ts) reports every CLI chat submit
 * here with the command source the ROUTER stamped (`COMMAND_SOURCE_ARG`, never
 * caller-supplied). Only dashboard sources count as a person typing:
 *   - `ws`         cloud dashboard over the server WS,
 *   - `p2p`        cloud dashboard over the P2P data channel,
 *   - `standalone` standalone HTTP/WS dashboard.
 * Everything else — `api` (API keys / shortcuts automation), `mesh`, `ipc`,
 * `internal`, `ext`, an absent or unknown source — is not human and is
 * dropped here, so the input log keeps its fail-closed (staging) default.
 *
 * The assistant runtime installs the sink; it records the entry only for the
 * registry-bound assistant session, at delivery (a FIFO-parked body is logged
 * when the driver drains it — `AssistantRelay.recordHumanSubmit`).
 *
 * Dependency-free on purpose: the send path imports it.
 */

import type { SubmitOutcome } from '@adhdev/mesh-shared';

export const ASSISTANT_HUMAN_COMMAND_SOURCES = ['ws', 'p2p', 'standalone'] as const;

export function isHumanCommandSource(source: unknown): boolean {
    return typeof source === 'string' && (ASSISTANT_HUMAN_COMMAND_SOURCES as readonly string[]).includes(source);
}

export interface SessionChatInputReport {
    /** Every id the send addressed (resolved session key, requested target id). */
    sessionIds: readonly string[];
    messageId: string;
    /** Router-stamped command source. */
    source: unknown;
    outcome: SubmitOutcome;
}

type Sink = (report: SessionChatInputReport) => void;

let sink: Sink | null = null;

/** Assistant runtime wiring (null on dispose). */
export function setAssistantHumanInputSink(next: Sink | null): void {
    sink = next;
}

/** Send path: report a chat submit. No-op unless the source is a human dashboard and an assistant runtime is wired. */
export function reportSessionChatInput(report: SessionChatInputReport): void {
    if (!sink || !isHumanCommandSource(report.source)) return;
    try {
        sink(report);
    } catch {
        /* the send already happened; attribution is best-effort and fails closed */
    }
}
