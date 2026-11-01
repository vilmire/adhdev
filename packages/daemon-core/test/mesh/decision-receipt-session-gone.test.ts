import { describe, expect, it } from 'vitest';
import { createDecisionReceiptChecker } from '../../src/mesh/mesh-mission-decision-delivery.js';

function checkerWith(execute: (cmd: string, args: any) => Promise<any>) {
    return createDecisionReceiptChecker(async () => ({ execute }) as any);
}

describe('decision receipt checker', () => {
    it('a vanished session is a definitive lost (no endless waiting poll)', async () => {
        const calls: string[] = [];
        const check = checkerWith(async (cmd) => { calls.push(cmd); return { success: false, error: 'Live session not found for targetSessionId: s1' }; });
        expect(await check('s1', 'w1', 'text')).toBe('lost');
        expect(calls).toEqual(['outgoing_receipts']);
    });
    it('other failures still throw so the delivery keeps waiting', async () => {
        const check = checkerWith(async () => ({ success: false, error: 'timeout' }));
        await expect(check('s1', 'w1', 'text')).rejects.toThrow('timeout');
    });
});
