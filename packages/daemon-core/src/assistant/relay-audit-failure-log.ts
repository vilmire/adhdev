import { LOG } from '../logging/logger.js';

/**
 * Rate-limited reporting for the relay gap audit. The audit is best effort and,
 * when a coordinator's native transcript cannot be read, fails identically every
 * minute until the condition clears. Warn when the failure is new or changed
 * (and at most every 30 min while it persists), debug otherwise, and say once
 * when it recovers.
 */
export class RelayAuditFailureLog {
    static readonly REWARN_MS = 30 * 60_000;
    private last: { message: string; warnedAt: number } | null = null;

    note(message: string | null, now: number): void {
        const prev = this.last;
        if (message === null) {
            if (prev) LOG.info('Assistant', 'relay gap audit recovered');
            this.last = null;
            return;
        }
        if (!prev || prev.message !== message || now - prev.warnedAt >= RelayAuditFailureLog.REWARN_MS) {
            LOG.warn('Assistant', `relay gap audit failed: ${message}${prev ? ' (still failing)' : ' (repeats are logged at debug)'}`);
            this.last = { message, warnedAt: now };
        } else {
            LOG.debug('Assistant', `relay gap audit failed: ${message}`);
        }
    }
}
