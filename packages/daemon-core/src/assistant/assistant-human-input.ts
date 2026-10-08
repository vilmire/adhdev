/**
 * Human input into the assistant session — the one hook through which a
 * dashboard chat send, or a submit key typed into the dashboard's remote
 * terminal, reaches the assistant input log (design
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
 * Raw terminal input (`pty_input`, the dashboard xterm) is reported through
 * `reportSessionTerminalInput` with the same trusted source: the router stamps
 * it for the `pty_input` command (standalone dashboard), and the cloud P2P
 * `pty_input` frame — which writes straight to the adapter without the router
 * and is refused for share-link peers — reports `p2p` from its transport.
 * Unit: one `human` entry per write that carries a submit key
 * (`countTerminalSubmits`), at most `TERMINAL_SUBMITS_PER_WRITE_CAP` per write.
 * Keystrokes without a submit key are not logged. Input that reaches the
 * session host without the daemon (adhmux, session-host direct attach) is
 * local-machine input the daemon never sees and stays unlogged.
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

export interface SessionTerminalInputReport {
    /** Every id the write addressed (requested target id, resolved session key). */
    sessionIds: readonly string[];
    /** The raw bytes written to the PTY. */
    data: string;
    /** Router-stamped command source, or the transport's own (`p2p` frame). */
    source: unknown;
}

export interface AssistantHumanInputSink {
    chat(report: SessionChatInputReport): void;
    terminal(report: SessionTerminalInputReport): void;
}

let sink: AssistantHumanInputSink | null = null;

/** Assistant runtime wiring (null on dispose). */
export function setAssistantHumanInputSink(next: AssistantHumanInputSink | null): void {
    sink = next;
}

/** Send path: report a chat submit. No-op unless the source is a human dashboard and an assistant runtime is wired. */
export function reportSessionChatInput(report: SessionChatInputReport): void {
    if (!sink || !isHumanCommandSource(report.source)) return;
    try {
        sink.chat(report);
    } catch {
        /* the send already happened; attribution is best-effort and fails closed */
    }
}

/**
 * `human` entries one terminal write may add. A person's Enter press is
 * one write with one submit key; a write carrying several is a paste or a
 * replayed burst, which is still one act by one person — the same as one
 * multi-line `send_chat`, which logs once. A cap of 1 keeps a pasted script of
 * fifty lines from adding fifty human inputs and firing the idle review
 * trigger (6 human inputs) on its own.
 */
export const TERMINAL_SUBMITS_PER_WRITE_CAP = 1;

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Submit keys in one raw terminal write: each `\r`, `\n`, or `\r\n` (one key)
 * outside a bracketed paste. Line breaks inside `ESC[200~ … ESC[201~` are the
 * paste's own text, not submits; the Enter after the end marker is. `ESC \r`
 * (Alt+Enter, a soft newline in agent CLIs) is not a submit. `inPaste` carries
 * an unterminated paste across writes; the result says whether one is still
 * open after this write.
 */
export function countTerminalSubmits(data: string, inPaste = false): { submits: number; inPaste: boolean } {
    let submits = 0;
    let i = 0;
    let paste = inPaste;
    while (i < data.length) {
        if (paste) {
            const end = data.indexOf(BRACKETED_PASTE_END, i);
            if (end < 0) return { submits, inPaste: true };
            paste = false;
            i = end + BRACKETED_PASTE_END.length;
            continue;
        }
        if (data.startsWith(BRACKETED_PASTE_START, i)) {
            paste = true;
            i += BRACKETED_PASTE_START.length;
            continue;
        }
        const ch = data[i];
        if (ch === '\x1b' && data[i + 1] === '\r') {
            i += data[i + 2] === '\n' ? 3 : 2;
            continue;
        }
        if (ch === '\r' || ch === '\n') {
            submits += 1;
            i += ch === '\r' && data[i + 1] === '\n' ? 2 : 1;
            continue;
        }
        i += 1;
    }
    return { submits, inPaste: paste };
}

/**
 * PTY write path: report raw terminal input after it was written. No-op unless
 * the source is a human dashboard and an assistant runtime is wired.
 */
export function reportSessionTerminalInput(report: SessionTerminalInputReport): void {
    if (!sink || !isHumanCommandSource(report.source) || typeof report.data !== 'string' || !report.data) return;
    try {
        sink.terminal(report);
    } catch {
        /* the write already happened; attribution is best-effort and fails closed */
    }
}
