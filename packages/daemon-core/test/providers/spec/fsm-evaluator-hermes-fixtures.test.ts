/**
 * hermes-cli v4 FSM — REAL captured screens.
 *
 * Sibling of fsm-evaluator-hermes.test.ts, which drives the same spec with
 * hand-written screens (`user:` / `assistant:` prose lines that no real hermes
 * TUI ever renders). This file drives it with screens captured verbatim from a
 * live Hermes Agent and stored as fixtures under
 * `adhdev-providers/tests/fixtures/hermes-*.txt`.
 *
 * Provenance: the captures were recovered from the hermes provider's legacy
 * script tests (`adhdev-providers/tests/hermes-cli-{approval,detect-status}.test.js`),
 * where they lived as INLINE string literals inside the test bodies. Those tests
 * exercise `scripts/1.0/*.js`, which the live daemon no longer calls: a CLI
 * provider now routes through SpecCliAdapter only (`providers/spec/route.ts`),
 * and `invoke_provider_script`'s `category === 'cli'` branch returns on every
 * path before reaching `scriptFn(...)` (`commands/stream-commands.ts`). Extracting
 * the captures to fixture files preserves the live-measured screens — the part
 * that has lasting value — independently of the dead scripts that consumed them.
 *
 * WHY the assertions are shaped as they are: this is a CHARACTERIZATION test.
 * The spec is the authority; where a fixture and the spec disagree, the
 * disagreement is recorded as a KNOWN GAP with the reason, not "fixed" by
 * loosening the spec. Three such gaps are pinned below (clarify-box invisibility,
 * stale-scrollback approval, timed-out dialog). Pinning them means a future spec
 * change that closes a gap fails here loudly and gets reviewed, rather than
 * passing unnoticed.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections, sectionText, extractButtonsFromRule } from '../../../src/providers/spec/evaluator.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

function resolveProvidersRepo(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../../../..');
    const candidates = [
        path.join(repoRoot, 'adhdev-providers'),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream'),
    ];
    const found = candidates.find(p => fs.existsSync(path.join(p, 'cli/hermes-cli/specs/4.0.json')));
    if (!found) throw new Error('adhdev-providers repo not found in: ' + candidates.join(', '));
    return found;
}

const PROVIDERS_REPO = resolveProvidersRepo();
const PROVIDER_DIR = path.join(PROVIDERS_REPO, 'cli/hermes-cli');
/**
 * Captured screens live in the repo-level `tests/fixtures/`, NOT under
 * `cli/hermes-cli/`, and that placement is load-bearing: the provider channel
 * digest hashes every git-tracked file under `<category>/<provider>`
 * (scripts/lib/provider-channels.mjs → computeProviderTreeDigest). Adding
 * fixtures inside the provider dir moves the bundle digest, which fails
 * `check:provider-channels` and forces a channel regeneration + provider version
 * bump — i.e. it would push an update to every existing hermes user purely to
 * ship test data. Keeping them outside the hashed tree avoids that entirely.
 */
const FIXTURE_DIR = path.join(PROVIDERS_REPO, 'tests/fixtures');

function loadSpec(): CliSpecV4 {
    const raw = JSON.parse(fs.readFileSync(path.join(PROVIDER_DIR, 'specs/4.0.json'), 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}

/** Read a captured screen. The trailing newline is stripped so the last line is
 *  the real bottom row — `status_tail` is a from_bottom window, so a phantom
 *  empty last line would shift it and silently weaken every busy-cue check. */
function fixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8').replace(/\n$/, '');
}

/** Evaluate a captured screen from `from`, with the cursor on the bottom row
 *  (where a real terminal leaves it) and enough elapsed time that min_hold_ms /
 *  stable_ms guards are satisfied — this isolates the REGEX/section behavior
 *  under test from the timing guards, which the sibling suite already covers. */
function settled(spec: CliSpecV4, from: string, screen: string) {
    const row = screen.split('\n').length - 1;
    const clock: FsmClock = { now: 30_000, stateEnteredAt: 0, regionLastChangedAt: new Map() };
    return evaluateFsm(spec, from, screen, { row, col: 1 }, undefined, clock);
}

function approvalButtons(spec: CliSpecV4, screen: string): string[] {
    const lines = screen.split('\n');
    const sections = resolveSections((spec as unknown as { sections: Record<string, never> }).sections ?? {}, lines);
    const approval = spec.states.find(s => s.id === 'approval')!;
    const rule = approval.extract!.buttons!;
    const hay = sectionText(sections, rule.section, lines.join('\n'));
    return extractButtonsFromRule(rule, hay).map(b => b.label);
}

describe('hermes-cli v4 FSM — real captured screens', () => {
    const spec = loadSpec();

    // ── Fixtures are an asset, not incidental test scaffolding ───────────────
    it('every captured screen fixture is present and non-empty', () => {
        const screens = fs.readdirSync(FIXTURE_DIR).filter(f => f.startsWith('hermes-') && f.endsWith('.txt'));
        expect(screens.length).toBeGreaterThanOrEqual(13);
        for (const f of screens) expect(fixture(f).trim().length).toBeGreaterThan(0);
    });

    // ── busy detection on real footers ───────────────────────────────────────
    // Each of these carries a genuine live busy cue inside the bottom
    // `status_tail` window. All three footer generations Hermes has shipped are
    // represented, so a spec edit that drops one is caught.
    it.each([
        ['hermes-busy-msg-interrupt-footer.txt', 'current `⚕ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel` footer'],
        ['hermes-busy-reasoning-footer.txt', 'reasoning spinner + msg=interrupt footer'],
        ['hermes-busy-legacy-interrupt-footer.txt', 'legacy v0.8 `Enter to interrupt, Ctrl+C to cancel` footer'],
    ])('idle → busy on %s (%s)', (file) => {
        expect(settled(spec, 'idle', fixture(file)).fired?.to).toBe('busy');
    });

    it.each([
        ['hermes-busy-msg-interrupt-footer.txt'],
        ['hermes-busy-reasoning-footer.txt'],
        ['hermes-busy-legacy-interrupt-footer.txt'],
    ])('busy does NOT fall back to idle while %s still shows the cue', (file) => {
        expect(settled(spec, 'busy', fixture(file)).fired?.to).not.toBe('idle');
    });

    // ── idle detection on real settled screens ───────────────────────────────
    it.each([
        ['hermes-idle-bare-prompt.txt', 'bare ❯ after the welcome line'],
        ['hermes-idle-completed-assistant-box.txt', 'closed ╰─ box + token status line + ❯'],
    ])('busy → idle on %s (%s)', (file) => {
        expect(settled(spec, 'busy', fixture(file)).fired?.to).toBe('idle');
    });

    it('busy → idle when a stale msg=interrupt line sits far above a later bare ❯', () => {
        // SPINNER-BODY-SELFMATCH with a REAL capture: the stale footer is 25+
        // lines up, outside the from_bottom:4 status_tail window, so it must not
        // hold the session in `generating`.
        expect(settled(spec, 'busy', fixture('hermes-idle-stale-interrupt-scrollback.txt')).fired?.to).toBe('idle');
    });

    it('idle does NOT false-fire to busy on the stale-interrupt scrollback screen', () => {
        expect(settled(spec, 'idle', fixture('hermes-idle-stale-interrupt-scrollback.txt')).fired?.to).not.toBe('busy');
    });

    // ── approval on the numbered Dangerous Command dialog ────────────────────
    it('→approval fires from idle and busy on the captured Dangerous Command dialog', () => {
        const screen = fixture('hermes-approval-dangerous-command-numbered.txt');
        for (const from of ['idle', 'busy']) {
            expect(settled(spec, from, screen).fired?.to).toBe('approval');
        }
    });

    it('extracts all four Dangerous Command buttons in screen order, with 1-based enter keys', () => {
        // The legacy parse_approval test asserted exactly this button list. It is
        // the single most valuable assertion in the dead suite: auto-approve
        // selects by index, so a mis-ordered or short list picks the WRONG button
        // (cf. the grok broadest-first hazard). Reproduced here against the spec.
        const screen = fixture('hermes-approval-dangerous-command-numbered.txt');
        expect(approvalButtons(spec, screen)).toEqual([
            'Allow once',
            'Allow for this session',
            'Add to permanent allowlist',
            'Deny',
        ]);
    });

    it('button rows keep min_count ≥ 2 satisfied so auto-approve is not starved', () => {
        // deriveModal drops the modal when fewer than min_count buttons extract,
        // which is exactly the AUTOAPPROVE wedge shape: current_modal=null → the
        // approval never resolves and the session stalls.
        const rule = spec.states.find(s => s.id === 'approval')!.extract!.buttons!;
        const found = approvalButtons(spec, fixture('hermes-approval-dangerous-command-numbered.txt'));
        expect(found.length).toBeGreaterThanOrEqual(rule.min_count ?? 2);
    });

    it('an approval screen whose footer already shows the busy cue resolves toward busy, not stuck approval', () => {
        // Captured mid-transition: the dialog box is still painted but the command
        // is already running (`⚕ ❯ msg=interrupt …` on the footer). approval→busy
        // requires the modal cue GONE; here it is still present, so the session
        // must not silently drop to idle and lose the pending state.
        const ev = settled(spec, 'approval', fixture('hermes-approval-resolved-with-interrupt-footer.txt'));
        expect(ev.fired?.to).not.toBe('idle');
    });

    // ── composer must resolve by ANCHOR, not by whole-screen fallback ────────
    // Injection-hardening: neutering the composer anchor left every transition
    // assertion green, because on an anchor MISS the section falls back to the
    // whole screen — which still contains a `❯` somewhere, so `composer ~ [❯>]`
    // keeps reading true. That fallback is the exact trap the spec's own
    // _sections_note documents. These assertions pin the resolved section itself,
    // so a broken anchor is caught instead of being masked by the fallback.
    it('composer resolves to the single bottom prompt row on a settled idle screen', () => {
        const screen = fixture('hermes-idle-completed-assistant-box.txt');
        const lines = screen.split('\n');
        const sections = resolveSections((spec as unknown as { sections: Record<string, never> }).sections ?? {}, lines);
        const composer = sections.find(s => s.id === 'composer')!;
        // lines:1 → exactly one row, and it must be the bare prompt, NOT the
        // whole screen (which here is 8 rows including the assistant box).
        expect(composer.text.split('\n')).toHaveLength(1);
        expect(composer.text.trim()).toBe('❯');
        expect(composer.fromLine).toBe(lines.length - 1);
    });

    it('composer does NOT swallow the whole screen when the bare prompt is absent (busy footer)', () => {
        // On a busy screen the bottom row is `⚕ ❯ msg=interrupt · …`, which the
        // `^\s*[❯>]\s*$` anchor deliberately does not match. The section then
        // falls back to whole-screen — assert that observed shape so the fallback
        // stays a KNOWN behavior rather than an invisible one.
        const screen = fixture('hermes-busy-msg-interrupt-footer.txt');
        const lines = screen.split('\n');
        const sections = resolveSections((spec as unknown as { sections: Record<string, never> }).sections ?? {}, lines);
        const composer = sections.find(s => s.id === 'composer')!;
        expect(composer.fromLine).toBe(0);
        expect(composer.text.split('\n')).toHaveLength(lines.length);
    });

    // ── KNOWN GAPS — fixture and spec disagree ───────────────────────────────
    // Pinned deliberately (see file header). Each records what the legacy script
    // engine did, what the spec does, and why it matters. Closing a gap SHOULD
    // fail the matching test here — that is the point.

    it('KNOWN GAP: the `Hermes needs your input` clarify box is invisible to the spec', () => {
        // The modal anchor's only hit on this screen is `↑/↓ to select, Enter to
        // confirm`, which Hermes renders BELOW the box. Since `modal` has no
        // `until`, the section starts at that line and runs to the bottom — so it
        // contains neither the question nor the choices, and →approval cannot fire.
        // Legacy parse_approval DID surface this as waiting_approval with three
        // buttons. Live impact: a clarify prompt reads as idle, so the dashboard
        // shows no approval and the turn waits on a selection nobody is asked for.
        const screen = fixture('hermes-approval-clarify-box.txt');
        expect(settled(spec, 'idle', screen).fired?.to).not.toBe('approval');
        expect(approvalButtons(spec, screen)).toEqual([]);
    });

    it.each([
        ['hermes-picker-clarify-choices.txt'],
        ['hermes-picker-clarify-choices-cursor-third.txt'],
    ])('KNOWN GAP: clarify CHOICE list %s also fails to raise picker/approval', (file) => {
        // Same root cause as above. The cursor-on-third-option variant exists
        // because the legacy parser had a bug class where a non-first ❯ cursor
        // truncated the list; the spec never sees the list at all.
        const ev = settled(spec, 'idle', fixture(file));
        expect(ev.fired?.to).not.toBe('picker');
        expect(ev.fired?.to).not.toBe('approval');
    });

    it('KNOWN GAP: a Dangerous Command dialog left in scrollback re-raises approval when the live prompt is idle', () => {
        // The screen ends at a settled `❯` with 2 history lines and a welcome
        // banner between it and the dialog, but `modal` has no `until`, so the
        // anchor still matches the old box and →approval (priority 100) wins.
        // Legacy detect_status explicitly returned 'idle' here. Live impact: a
        // resolved approval can re-assert itself and re-notify.
        expect(settled(spec, 'idle', fixture('hermes-idle-stale-approval-scrollback.txt')).fired?.to).toBe('approval');
    });

    it('KNOWN GAP: a timed-out/denied dialog still raises approval with zero extractable buttons', () => {
        // `⏱ Timeout — denying command` — already resolved by Hermes. The spec
        // fires →approval, but the rows are unnumbered so extraction yields [] —
        // below min_count. That is the starved-modal shape: approval state with no
        // actionable buttons. Legacy parse_approval returned null for this screen.
        const screen = fixture('hermes-approval-dangerous-command-timed-out.txt');
        expect(settled(spec, 'idle', screen).fired?.to).toBe('approval');
        expect(approvalButtons(spec, screen)).toEqual([]);
    });
});
