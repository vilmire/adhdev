/**
 * opencode FSM spec — the `approval` state's screens are VERBATIM captures of a
 * real `opencode` 1.18.31 process driven through node-pty and rendered with the
 * same ghostty-vt terminal emulator the daemon uses (not hand-written
 * approximations). Captured live 2026-09-25 in a scratch workspace with a
 * project-local `opencode.json` setting `permission.bash: "ask"` (opencode's
 * default config has no restrictive permissions, so the modal must be coaxed
 * out deliberately — see fixtures/opencode-approval-bash-2026-09-25.txt and
 * fixtures/opencode-always-allow-scope-widen-2026-09-25.txt for the exact
 * captured screens).
 *
 * ★Why this spec's `approval` state has NO `select_mode`/press capability on
 * its buttons (unlike claude-cli/grok-cli/antigravity-cli): opencode's
 * permission row — `Allow once   Allow always   Reject` — renders as plain
 * text with NO on-screen numbers and NO per-button key hint. Focus is shown
 * ONLY via an ANSI background-color repaint (verified from the raw PTY bytes:
 * the focused cell carries `\x1b[48;5;215m`, the others `\x1b[48;5;234m`), and
 * opencode hides the real terminal cursor throughout (`\x1b[?25l`). The FSM
 * evaluator only ever reads `formatPlainText()` — the SAME rendering these
 * fixtures are dumped from — which carries neither signal. So there is no
 * text-extractable "this row is focused" fact for `cursor_marker` to match,
 * and `select_mode: 'arrow_keys'` requires exactly that (fsm-driver.ts refuses
 * to press when no row reads `current`, rather than fabricate a cursor origin
 * — the MESHAPPROVE-STALE-MODAL guard, see
 * driver-approval-deadlock-unactionable-modal.test.ts). Live-verified
 * separately (4 independent PTY captures, including one with an 18s idle
 * dwell before pressing Enter) that a FRESH render of either modal always
 * defaults focus to its first/leftmost button, and that a bare `\x1b` (Escape)
 * dismisses/declines the modal regardless of prior arrow navigation — but
 * "always resets on THIS instance" is a single-observation fact, not the
 * general contract `select_mode: 'arrow_keys'` needs across an ARBITRARY later
 * `click_modal_button` call, so it is documented rather than encoded as a
 * press rule. These tests assert exactly the capability that IS real today:
 * the labels parse, and the auto-approve signature/least-privilege-pick logic
 * (approval-gate.ts / approval-utils.ts) reads them correctly — not a press
 * capability that does not exist.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections, sectionText, extractButtonsFromRule } from '../../../src/providers/spec/evaluator.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';
import {
    pickApprovalButton,
    hasNegativeApprovalOption,
    hasReliableApprovalAffirmative,
    isNegativeApprovalLabel,
} from '../../../src/providers/approval-utils.js';

function repoRootDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '../../../../../..');
}

function resolveSpecPath(): string {
    const repoRoot = repoRootDir();
    const candidates = [
        path.join(repoRoot, 'adhdev-providers/cli/opencode/specs/1.0.json'),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli/opencode/specs/1.0.json'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) throw new Error('opencode 1.0.json spec not found in: ' + candidates.join(', '));
    return found;
}

function loadSpec(): CliSpecV4 {
    const raw = JSON.parse(fs.readFileSync(resolveSpecPath(), 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}

function loadFixture(name: string): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return fs.readFileSync(path.join(here, 'fixtures', name), 'utf8').replace(/\n$/, '');
}

function loadManifest(): { approvalPositiveHints?: string[] } {
    const repoRoot = repoRootDir();
    const p = path.join(repoRoot, 'adhdev-providers/cli/opencode/provider.v1.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function clk(now: number, entered: number): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map() };
}

function fire(spec: CliSpecV4, from: string, screen: string, ageMs = 9000): string | null {
    const now = 1_000_000;
    const lines = screen.split('\n');
    const res = evaluateFsm(spec, from, screen, { row: 0, col: 0 }, lines, clk(now, now - ageMs));
    return (res.fired as { label?: string } | null)?.label ?? null;
}

// ── Captured live: a bash-command permission prompt (opencode 1.18.31) ──────
const APPROVAL_MODAL = loadFixtureSafe('opencode-approval-bash-2026-09-25.txt');
// ── Captured live: the "Always allow <pattern>" scope-broadening confirm ────
const SCOPE_WIDEN_MODAL = loadFixtureSafe('opencode-always-allow-scope-widen-2026-09-25.txt');

function loadFixtureSafe(name: string): string {
    try { return loadFixture(name); } catch { return ''; }
}

describe('opencode spec — loads', () => {
    it('passes FSM spec validation', () => {
        expect(() => loadSpec()).not.toThrow();
    });
});

describe('opencode FSM — transitions on real captured screens', () => {
    it('enters approval on the bash-command permission modal', () => {
        const spec = loadSpec();
        expect(APPROVAL_MODAL.length).toBeGreaterThan(0);
        expect(fire(spec, 'busy', APPROVAL_MODAL)).toBe('→approval');
    });

    it('also enters approval on the "Always allow" scope-widening confirm', () => {
        // Same modal_kind/state — opencode does not render this as a visually
        // distinct FSM state, only a different button vocabulary.
        const spec = loadSpec();
        expect(SCOPE_WIDEN_MODAL.length).toBeGreaterThan(0);
        expect(fire(spec, 'busy', SCOPE_WIDEN_MODAL)).toBe('→approval');
    });
});

describe('opencode FSM — modal button extraction (labels only, no press)', () => {
    it('parses the three permission choices in screen order', () => {
        const spec = loadSpec();
        const sections = resolveSections(spec.sections ?? {}, APPROVAL_MODAL.split('\n'));
        const approval = spec.states.find((s) => s.id === 'approval')!;
        const rule = (approval as { extract?: { buttons?: unknown } }).extract!.buttons as never;
        const hay = sectionText(sections, 'status_tail', APPROVAL_MODAL);
        const buttons = extractButtonsFromRule(rule, hay);

        expect(buttons.map((b) => b.label)).toEqual(['Allow once', 'Allow always', 'Reject']);
    });

    it('parses the scope-widening confirm as Confirm/Cancel', () => {
        const spec = loadSpec();
        const sections = resolveSections(spec.sections ?? {}, SCOPE_WIDEN_MODAL.split('\n'));
        const approval = spec.states.find((s) => s.id === 'approval')!;
        const rule = (approval as { extract?: { buttons?: unknown } }).extract!.buttons as never;
        const hay = sectionText(sections, 'status_tail', SCOPE_WIDEN_MODAL);
        const buttons = extractButtonsFromRule(rule, hay);

        expect(buttons.map((b) => b.label)).toEqual(['Confirm', 'Cancel']);
    });

    it('declares no select_mode/key_group — press capability is intentionally absent', () => {
        // Guards the documented decision: adding a fabricated cursor origin here
        // would be exactly the class of bug driver-approval-deadlock-
        // unactionable-modal.test.ts exists to prevent (MESHAPPROVE-STALE-MODAL).
        // If a future engine change adds a real focus signal (e.g. formatVT
        // attribute spans), this test should be the one updated alongside it.
        const spec = loadSpec();
        const approval = spec.states.find((s) => s.id === 'approval')!;
        const rule = (approval as { extract?: { buttons?: { select_mode?: unknown; key_group?: unknown } } }).extract!.buttons!;
        expect(rule.select_mode).toBeUndefined();
        expect(rule.key_group).toBeUndefined();
    });
});

describe('opencode approval — signature detection and least-privilege pick (label-level only)', () => {
    const permissionButtons = ['Allow once', 'Allow always', 'Reject'];
    const scopeWidenButtons = ['Confirm', 'Cancel'];

    it('recognises the permission modal as answerable via its negative option', () => {
        expect(hasNegativeApprovalOption(permissionButtons)).toBe(true);
        expect(isNegativeApprovalLabel('Reject')).toBe(true);
        expect(isNegativeApprovalLabel('Allow once')).toBe(false);
    });

    it('recognises the scope-widening confirm as answerable via Cancel', () => {
        expect(hasNegativeApprovalOption(scopeWidenButtons)).toBe(true);
        expect(isNegativeApprovalLabel('Cancel')).toBe(true);
    });

    it('picks "Allow once" over "Allow always" — the least-privilege affirmative', () => {
        // "Allow always" persists the grant ("until OpenCode is restarted" per
        // the live-captured scope-widen modal) — exactly the class of trap
        // approval-utils.ts warns about for grok's "always-approve mode" option.
        const picked = pickApprovalButton(permissionButtons, loadManifest() as never);
        expect(picked.label).toBe('Allow once');
        expect(picked.index).toBe(0);
    });

    it('regresses to "Allow once" even without the manifest hint (index-0 default)', () => {
        // Documents that the manifest hint order matters for OTHER providers
        // (e.g. grok, where the broadest grant sorts first); for opencode the
        // safe choice already happens to be button 0, so this is a guard against
        // a future reordering of approvalPositiveHints silently changing that.
        const withHints = pickApprovalButton(permissionButtons, loadManifest() as never);
        const withoutHints = pickApprovalButton(permissionButtons, {} as never);
        expect(withHints.label).toBe('Allow once');
        expect(withoutHints.label).toBe('Allow once');
    });
});
