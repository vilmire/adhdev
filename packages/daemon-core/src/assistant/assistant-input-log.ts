/**
 * Assistant input log — per assistant session, the ordered record of the
 * inputs the daemon delivered into it (design 2026-10-07-assistant-layer.md
 * §4.10.2 check 5, §4.10.7).
 *
 * Store verbs read it to classify a write's origin (`classifyWriteOrigin`,
 * fail-closed: a caller with no log stages), to key skill patch caps by
 * session + turn, and to know whether an idle review turn is open. The relay
 * (a later unit) appends one entry per delivered input and closes turns on the
 * bus `turn{committed}`; until then nothing appends and every agent write
 * stages, which is the intended fail-closed default.
 *
 * In-memory and bounded on purpose: after a daemon restart the log is empty,
 * so the first write after a restart stages until a human speaks again.
 * Truncation can only drop the oldest entries, which at worst removes the last
 * human entry and makes classification stage — never apply.
 */

import { classifyWriteOrigin, isReviewOrigin, type AssistantInputSource, type StoreWriteOrigin } from './store-guards.js';

/** Entries kept per session (oldest dropped first). */
export const ASSISTANT_INPUT_LOG_MAX_ENTRIES = 64;
/** Sessions kept (least recently appended dropped first). One assistant exists; this is a leak bound. */
export const ASSISTANT_INPUT_LOG_MAX_SESSIONS = 8;

export interface AssistantInputEntry {
    source: AssistantInputSource;
    /** Epoch ms the daemon delivered the input. */
    at: number;
    /** Turn this input opened or joined (steer while a turn was open). */
    turnId: string;
    messageId?: string;
}

export interface AssistantInputTurnView {
    turnId: string;
    /** Source of the input that opened the turn. */
    openedBy: AssistantInputSource;
    open: boolean;
}

interface SessionLog {
    entries: AssistantInputEntry[];
    turnSeq: number;
    current: { turnId: string; openedBy: AssistantInputSource; open: boolean } | null;
    /** Monotonic count of human inputs ever appended (not reduced by truncation). */
    humanInputs: number;
    /** True once the oldest entries were dropped (review windows reaching past the cut are tainted). */
    truncated: boolean;
    /**
     * True when the log began with the session itself (`begin` at a fresh
     * launch). A log created lazily — after a daemon restart re-bound a live
     * process, whose context still holds pre-restart relays — does not know
     * what came before its first entry.
     */
    fromStart: boolean;
}

export interface AssistantWriteContext {
    origin: StoreWriteOrigin;
    /** Skill-cap key parts. `turnId` is `no-turn` when no turn was ever recorded. */
    sessionId: string;
    turnId: string;
    /** True when the session has a log at all (false → origin was forced to stage). */
    logged: boolean;
    /**
     * Set for a review-turn write (`review` / `review_tainted`): the review
     * input's message id (`review:<ms>`), or `<session>:<turn>` when it had
     * none. Staged writes carry it so the owner can resolve one review's
     * writes in one action, and metrics credit the review turn once.
     */
    reviewTurnId?: string;
}

export class AssistantInputLog {
    private readonly sessions = new Map<string, SessionLog>();

    constructor(
        private readonly maxEntries: number = ASSISTANT_INPUT_LOG_MAX_ENTRIES,
        private readonly maxSessions: number = ASSISTANT_INPUT_LOG_MAX_SESSIONS,
    ) {}

    /**
     * Record one delivered input. Opens a new turn unless a turn is open, in
     * which case the input joins it (steer). Returns the turn id.
     */
    append(sessionId: string, source: AssistantInputSource, opts: { at?: number; messageId?: string } = {}): string {
        const id = normalizeId(sessionId);
        if (!id) throw new Error('AssistantInputLog.append requires a session id');
        let log = this.sessions.get(id);
        if (log) {
            this.sessions.delete(id); // re-insert → most recently used
        } else {
            log = { entries: [], turnSeq: 0, current: null, humanInputs: 0, truncated: false, fromStart: false };
        }
        this.sessions.set(id, log);
        while (this.sessions.size > this.maxSessions) {
            const oldest = this.sessions.keys().next().value as string;
            this.sessions.delete(oldest);
        }
        if (!log.current || !log.current.open) {
            log.turnSeq += 1;
            log.current = { turnId: `t${log.turnSeq}`, openedBy: source, open: true };
        }
        log.entries.push({ source, at: opts.at ?? Date.now(), turnId: log.current.turnId, ...(opts.messageId ? { messageId: opts.messageId } : {}) });
        if (log.entries.length > this.maxEntries) {
            log.entries.splice(0, log.entries.length - this.maxEntries);
            log.truncated = true;
        }
        if (source === 'human') log.humanInputs += 1;
        return log.current.turnId;
    }

    /**
     * A fresh assistant process started (launch_assistant): start an empty log
     * that knows it covers the whole session, so the first review window can be
     * judged from the session start.
     */
    begin(sessionId: string): void {
        const id = normalizeId(sessionId);
        if (!id) return;
        this.sessions.delete(id);
        this.sessions.set(id, { entries: [], turnSeq: 0, current: null, humanInputs: 0, truncated: false, fromStart: true });
        while (this.sessions.size > this.maxSessions) {
            const oldest = this.sessions.keys().next().value as string;
            this.sessions.delete(oldest);
        }
    }

    /** The open turn ended (bus `turn{committed}` / interrupted). Idempotent. */
    closeTurn(sessionId: string): void {
        const log = this.sessions.get(normalizeId(sessionId));
        if (log?.current) log.current.open = false;
    }

    /** Forget a session (new session, stop, explicit reset). */
    reset(sessionId: string): void {
        this.sessions.delete(normalizeId(sessionId));
    }

    has(sessionId: string): boolean {
        return this.sessions.has(normalizeId(sessionId));
    }

    sources(sessionId: string): AssistantInputSource[] {
        return (this.sessions.get(normalizeId(sessionId))?.entries ?? []).map((e) => e.source);
    }

    entries(sessionId: string): AssistantInputEntry[] {
        return [...(this.sessions.get(normalizeId(sessionId))?.entries ?? [])];
    }

    currentTurn(sessionId: string): AssistantInputTurnView | null {
        const c = this.sessions.get(normalizeId(sessionId))?.current;
        return c ? { ...c } : null;
    }

    /** True while a turn opened by the idle review input is still open (§4.10.7 whitelist window). */
    isReviewTurnOpen(sessionId: string): boolean {
        const c = this.sessions.get(normalizeId(sessionId))?.current;
        return !!c && c.open && c.openedBy === 'review';
    }

    /** Total human inputs ever appended for the session (review trigger input). */
    humanInputCount(sessionId: string): number {
        return this.sessions.get(normalizeId(sessionId))?.humanInputs ?? 0;
    }

    /**
     * Origin + cap key for a store write by `sessionId`. Fail-closed: an absent
     * or unknown session classifies over an empty list, which stages.
     */
    writeContext(sessionId: string | null | undefined): AssistantWriteContext {
        const id = normalizeId(sessionId);
        const log = id ? this.sessions.get(id) : undefined;
        let origin = classifyWriteOrigin(log ? log.entries.map((e) => e.source) : [], { truncated: !log || log.truncated || !log.fromStart });
        const reviewTurnOpen = !!(log?.current?.open && log.current.openedBy === 'review');
        // A review origin applies only inside the review turn; a write after that
        // turn closed (and before anything else arrived) has no human behind it.
        if (isReviewOrigin(origin) && !reviewTurnOpen) origin = 'relay';
        let reviewTurnId: string | undefined;
        if (isReviewOrigin(origin) && log?.current) {
            const opener = log.entries.find((e) => e.turnId === log.current!.turnId && e.source === 'review');
            reviewTurnId = opener?.messageId || `${id}:${log.current.turnId}`;
        }
        return {
            origin,
            sessionId: id || 'unbound',
            turnId: log?.current?.turnId ?? 'no-turn',
            logged: !!log,
            ...(reviewTurnId ? { reviewTurnId } : {}),
        };
    }
}

function normalizeId(id: string | null | undefined): string {
    return typeof id === 'string' ? id.trim() : '';
}
