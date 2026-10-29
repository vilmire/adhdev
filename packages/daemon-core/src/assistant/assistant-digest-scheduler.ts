/**
 * Daily digest (2026-10-18 review): once a day, at a local hour, the assistant
 * is asked for a three-line summary of the projects it follows — what finished,
 * what is blocked, what needs the owner. The only other unprompted input was
 * the 30-minute stall notice, which says nothing about what went well.
 *
 * Same delivery as the idle review turn (relay `enqueueInput`, held until the
 * assistant is ready, pinned to the session it was evaluated for). Setting:
 * `assistant.json` `digestHour` (0–23, default 9; `null` turns it off). The day
 * it fired persists as `lastDigestAt`, so a restart never sends a second one.
 */

export const DEFAULT_DIGEST_HOUR = 9;

export const DIGEST_INPUT_TEXT = '[ADHDev digest] Daily summary. For the projects you follow, tell the user in at most three short lines '
    + 'what finished, what is blocked, and what needs their decision since the last summary. Read project_status only where you need to. '
    + 'If nothing changed, say so in one line.';

export interface AssistantDigestPorts {
    liveSessionId(): string | null;
    isReady(sessionId: string): boolean;
    modalOpen(sessionId: string): boolean;
    /** `assistant.json` `digestHour`: undefined → default hour, null → off. */
    digestHour(): number | null | undefined;
    lastDigestAt(): number | null;
    /** The assistant follows at least one project (open relay thread). */
    followsProjects(): boolean;
    relayBusy(): boolean;
    enqueue(input: { source: 'digest'; text: string; messageId: string; forSessionId: string }): void;
    /** Owner-decision block for the "needs you" part (decision-nudge.ts); empty/absent → none. */
    decisionSection?(now: number): string;
    recordDigest(at: number): void;
}

export type DigestOutcome =
    | { fired: true; messageId: string }
    | { fired: false; reason: 'off' | 'not_the_hour' | 'already_today' | 'no_session' | 'not_ready' | 'nothing_followed' | 'busy' };

function sameLocalDay(a: number, b: number): boolean {
    const x = new Date(a);
    const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export class AssistantDigestScheduler {
    constructor(private readonly ports: AssistantDigestPorts) {}

    evaluate(now: number): DigestOutcome {
        const setting = this.ports.digestHour();
        if (setting === null) return { fired: false, reason: 'off' };
        const hour = setting === undefined ? DEFAULT_DIGEST_HOUR : setting;
        if (new Date(now).getHours() !== hour) return { fired: false, reason: 'not_the_hour' };
        const last = this.ports.lastDigestAt();
        if (last !== null && sameLocalDay(last, now)) return { fired: false, reason: 'already_today' };
        const sid = this.ports.liveSessionId();
        if (!sid) return { fired: false, reason: 'no_session' };
        if (!this.ports.isReady(sid) || this.ports.modalOpen(sid)) return { fired: false, reason: 'not_ready' };
        if (!this.ports.followsProjects()) return { fired: false, reason: 'nothing_followed' };
        if (this.ports.relayBusy()) return { fired: false, reason: 'busy' };
        const messageId = `digest:${now}`;
        this.ports.recordDigest(now);
        let section = '';
        try { section = this.ports.decisionSection?.(now) ?? ''; } catch { /* the digest is still worth sending */ }
        this.ports.enqueue({ source: 'digest', text: section ? `${DIGEST_INPUT_TEXT}\n\n${section}` : DIGEST_INPUT_TEXT, messageId, forSessionId: sid });
        return { fired: true, messageId };
    }
}
