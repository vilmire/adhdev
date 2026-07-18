/**
 * BUTTON-INDEX-MISMAP (Fix C) — SpecCliAdapter.resolveModal must translate an ARRAY
 * POSITION (the index pickApprovalButton / mesh_approve select from the surfaced label
 * list) to the button's real FSM DISPLAYED index before dispatching the click.
 *
 * Root cause: resolveModal blindly sent `arrayPos + 1` as the FSM click index, while the
 * FSM matches a click by the button's on-screen number (evaluator sets button.index =
 * Number(m[1])). For a 1..N contiguous modal the two coincide, so the bug hid — but a
 * PARTIAL / non-contiguous modal (e.g. "1. Yes / 3. Always / 4. No" → display indices
 * [1,3,4] at array positions [0,1,2]) diverges: `arrayPos + 1` targets a display index the
 * FSM never rendered, so handleClickModalButton finds no button and NOTHING is pressed —
 * yet the old void resolveModal reported success. These tests pin the array→display mapping
 * and the miss→false verdict resolveModalMatched now surfaces.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

type ModalButton = { index: number; label: string; key: string; current: boolean };

// Build a SpecCliAdapter over a fake driver that records click_modal_button dispatches
// and reports (via clickModalButton) whether a button with the requested FSM display index
// exists in the modal — the same match semantics the real FsmDriver.handleClickModalButton
// applies.
function makeAdapter(buttons: ModalButton[]): { adapter: any; clicks: number[] } {
    const clicks: number[] = [];
    const adapter = Object.create(SpecCliAdapter.prototype);
    Object.assign(adapter, {
        cliType: 'antigravity-cli',
        latestModal: { title: 'Do you want to proceed?', buttons, kind: 'approval' },
        driver: {
            // Real driver returns true only when a button whose .index === requested exists.
            clickModalButton: (index: number): boolean => {
                clicks.push(index);
                return buttons.some(b => b.index === index);
            },
            dispatch: () => { /* unused on this path */ },
        },
    });
    return { adapter, clicks };
}

// A PARTIAL approval modal: the "2. …" option is absent, so display indices are
// non-contiguous. Array positions [0,1,2] map to display indices [1,3,4].
const PARTIAL_BUTTONS: ModalButton[] = [
    { index: 1, label: 'Yes', key: '1\r', current: true },
    { index: 3, label: 'Yes, and always allow', key: '3\r', current: false },
    { index: 4, label: 'No', key: '4\r', current: false },
];

describe('SpecCliAdapter — resolveModal button-index mapping (Fix C)', () => {
    it('maps array position → real FSM display index for a partial/non-contiguous modal', () => {
        const { adapter, clicks } = makeAdapter(PARTIAL_BUTTONS);

        // Array position 1 is the "always allow" option whose DISPLAY index is 3.
        // The old code sent arrayPos+1 = 2 → a display index the modal never rendered.
        adapter.resolveModal(1);
        expect(clicks).toEqual([3]);
    });

    it('maps the last array position (2) to display index 4, not 3', () => {
        const { adapter, clicks } = makeAdapter(PARTIAL_BUTTONS);
        adapter.resolveModal(2); // "No" — display index 4
        expect(clicks).toEqual([4]);
    });

    it('array position 0 maps to display index 1 (the contiguous-head case still works)', () => {
        const { adapter, clicks } = makeAdapter(PARTIAL_BUTTONS);
        adapter.resolveModal(0);
        expect(clicks).toEqual([1]);
    });

    it('resolveModalMatched reports true when the mapped display index exists', () => {
        const { adapter } = makeAdapter(PARTIAL_BUTTONS);
        expect(adapter.resolveModalMatched(1)).toBe(true); // → display 3, present
    });

    it('resolveModalMatched reports false when the array position maps to no button', () => {
        const { adapter, clicks } = makeAdapter(PARTIAL_BUTTONS);
        // Out-of-range array position → legacy +1 fallback (index 4) → still a miss vs the
        // present buttons only if that display index is absent; use a clearly OOB position.
        const matched = adapter.resolveModalMatched(9);
        // arrayPos 9 is beyond the list → falls back to 9+1 = 10, which no button has.
        expect(matched).toBe(false);
        expect(clicks).toEqual([10]);
    });

    it('a contiguous 1..N modal is unaffected (array position === display index - 1)', () => {
        const contiguous: ModalButton[] = [
            { index: 1, label: 'Yes', key: '1\r', current: true },
            { index: 2, label: 'No', key: '2\r', current: false },
        ];
        const { adapter, clicks } = makeAdapter(contiguous);
        adapter.resolveModal(0);
        adapter.resolveModal(1);
        expect(clicks).toEqual([1, 2]);
    });
});

describe('antigravity-cli spec declares arrow-nav + continuation for its approval modals (Fix C.4)', () => {
    const raw = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'adhdev-providers/cli/antigravity-cli/specs/4.0.json'), 'utf8'),
    );

    it.each(['approval', 'trust'])('%s modal buttons use select_mode arrow_keys', (stateId) => {
        const state = (raw.states ?? []).find((s: any) => s.id === stateId);
        expect(state?.extract?.buttons?.select_mode).toBe('arrow_keys');
    });

    it.each(['approval', 'trust'])('%s modal buttons enable continuation_lines for wrapped labels', (stateId) => {
        const state = (raw.states ?? []).find((s: any) => s.id === stateId);
        expect(state?.extract?.buttons?.continuation_lines).toBe(true);
    });

    it('the antigravity 4.0 spec still validates with the new button fields', () => {
        expect(validateFsmSpec(raw)).toEqual([]);
    });
});
