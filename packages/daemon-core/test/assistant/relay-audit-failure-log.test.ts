import { describe, expect, it, vi } from 'vitest';
import { LOG } from '../../src/logging/logger.js';
import { RelayAuditFailureLog } from '../../src/assistant/relay-audit-failure-log.js';

describe('RelayAuditFailureLog', () => {
    it('warns once for a repeating failure, re-warns after the window, announces recovery', () => {
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const debug = vi.spyOn(LOG, 'debug').mockImplementation(() => {});
        const info = vi.spyOn(LOG, 'info').mockImplementation(() => {});
        const log = new RelayAuditFailureLog();
        for (let i = 0; i < 10; i++) log.note('coordinator native audit unavailable', i * 60_000);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(debug).toHaveBeenCalledTimes(9);
        log.note('coordinator native audit unavailable', RelayAuditFailureLog.REWARN_MS + 1);
        expect(warn).toHaveBeenCalledTimes(2);
        log.note('different', RelayAuditFailureLog.REWARN_MS + 2);
        expect(warn).toHaveBeenCalledTimes(3);
        log.note(null, RelayAuditFailureLog.REWARN_MS + 3);
        expect(info).toHaveBeenCalledTimes(1);
        vi.restoreAllMocks();
    });
});
