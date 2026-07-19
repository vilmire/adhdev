/**
 * AUTOAPPROVE-FLAP (signal2) — SpecCliAdapter.isApprovalRecentlyResolved must report a
 * real, time-bounded resolution instead of a hard-coded `false`.
 *
 * Root cause: claude-cli drives the spec adapter (specs/4.0.json), whose
 * isApprovalRecentlyResolved() stubbed to `false`. The mesh event forwarder's
 * shouldSuppressAutoApprovingWorkerApproval uses two signals to drop a duplicate
 * agent:waiting_approval re-emitted across the approval↔busy TUI flap:
 *   signal1 = auto-approve fired < 8s ago (lastAutoApproveFiredAt), and
 *   signal2 = adapter.isApprovalRecentlyResolved().
 * With signal2 stubbed to false, only signal1 guarded the flap; the tight
 * approval(~1.5s)↔busy(~4.5s) toggle re-emitted outside signal1's fire and flapped up to
 * the coordinator. These tests pin that resolving an approval-class modal now arms
 * signal2 for the cooldown window, and that a picker/confirm press or a silent miss does
 * NOT arm it.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';

type ModalButton = { index: number; label: string; key: string; current: boolean };

const APPROVAL_BUTTONS: ModalButton[] = [
    { index: 1, label: 'Yes', key: '1\r', current: true },
    { index: 2, label: 'No', key: '2\r', current: false },
];

// A SpecCliAdapter over a fake driver whose clickModalButton reports whether a button with
// the requested FSM display index exists — the same match semantics the real FsmDriver
// applies. `status` sets the authoritative FSM state the stamp gate reads.
function makeAdapter(opts: { status: 'approval' | 'picker' | 'confirm' | 'generating'; buttons?: ModalButton[]; kind?: string }): any {
    const buttons = opts.buttons ?? APPROVAL_BUTTONS;
    const adapter = Object.create(SpecCliAdapter.prototype);
    Object.assign(adapter, {
        cliType: 'claude-cli',
        latestState: { id: 's', label: 'l', title: null, status: opts.status },
        latestModal: { title: 'Do you want to proceed?', buttons, kind: opts.kind ?? 'approval' },
        driver: {
            clickModalButton: (index: number): boolean => buttons.some(b => b.index === index),
            dispatch: () => { /* unused */ },
        },
    });
    return adapter;
}

afterEach(() => { vi.useRealTimers(); });

describe('SpecCliAdapter.isApprovalRecentlyResolved (AUTOAPPROVE-FLAP signal2)', () => {
    it('is false before any modal is resolved', () => {
        const adapter = makeAdapter({ status: 'approval' });
        expect(adapter.isApprovalRecentlyResolved()).toBe(false);
    });

    it('reports true immediately after a successful approval-modal press', () => {
        const adapter = makeAdapter({ status: 'approval' });
        expect(adapter.resolveModalMatched(0)).toBe(true); // display index 1, present
        expect(adapter.isApprovalRecentlyResolved()).toBe(true);
    });

    it('reports true within the cooldown and false once it elapses', () => {
        vi.useFakeTimers();
        const adapter = makeAdapter({ status: 'approval' });
        expect(adapter.resolveModalMatched(0)).toBe(true);

        vi.advanceTimersByTime(7999);
        expect(adapter.isApprovalRecentlyResolved()).toBe(true);

        vi.advanceTimersByTime(2); // now > 8000ms since resolve
        expect(adapter.isApprovalRecentlyResolved()).toBe(false);
    });

    it('does NOT arm signal2 when the FSM is not in an approval state (picker press)', () => {
        const adapter = makeAdapter({ status: 'picker', kind: 'picker' });
        // The button press itself succeeds, but a /model picker must never arm the approval cooldown.
        expect(adapter.resolveModalMatched(0)).toBe(true);
        expect(adapter.isApprovalRecentlyResolved()).toBe(false);
    });

    it('does NOT arm signal2 on a silent miss (no button matched the mapped index)', () => {
        const adapter = makeAdapter({ status: 'approval' });
        // Out-of-range array position → +1 fallback targets a display index no button has → miss.
        expect(adapter.resolveModalMatched(9)).toBe(false);
        expect(adapter.isApprovalRecentlyResolved()).toBe(false);
    });
});
