/**
 * MODELSWITCH — picker modals must NOT be auto-approved.
 *
 * Root cause this guards: a /model (or /mode) picker shares the dashboard
 * `waiting_approval` status with a genuine tool-consent modal so the dashboard
 * still surfaces it — but the auto-approve worker used to treat ANY
 * waiting_approval with buttons as approvable and blindly select the first
 * non-empty button (pickAutoApprovalButton → findIndex(Boolean)), which on the
 * /model picker is "Default/Opus". Result: the model was silently switched to
 * the first option the instant the picker opened, before the user could choose.
 *
 * The fix carries a semantic `modal_kind` ('approval' | 'picker' | 'confirm')
 * from the spec state, through the FSM driver (modalKindForState) and the
 * cli-adapter (activeModal.kind), into the auto-approve gate
 * (maybeAutoApproveStatus), which now fires ONLY for kind='approval' AND only
 * when the buttons structurally look like a real consent prompt (an affirmative
 * via pickApprovalButton + a decline via hasNegativeApprovalOption).
 *
 * These tests exercise the REAL pieces — the shipped spec files via the real
 * loader, the real FSM evaluator driving idle→picker/idle→approval, the real
 * modalKindForState the driver uses, and the real maybeAutoApproveStatus gate —
 * rather than stubbing the FSM. (A full FsmDriver instance needs the native
 * ghostty-vt terminal backend, so the PTY byte layer is the only thing not
 * reconstructed here; everything above it is the production code path.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadFsmSpec, validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm } from '../../../src/providers/spec/fsm-evaluator.js';
import { modalKindForState, stateById, type CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';
import { CliProviderInstance } from '../../../src/providers/cli-provider-instance.js';
import { ManualAttendanceTracker } from '../../../src/providers/manual-attendance.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const CLI_PROVIDERS = ['claude-cli', 'codex-cli', 'hermes-cli', 'antigravity-cli'] as const;

function loadLiveSpec(provider: string): CliSpecV4 {
  const dir = path.join(REPO_ROOT, 'adhdev-providers/cli', provider);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'provider.v1.json'), 'utf8'));
  const declared = manifest?.compatibility?.find((c: any) => typeof c?.spec === 'string')?.spec;
  const specPath = path.join(dir, declared ?? 'spec.json');
  const res = loadFsmSpec(specPath);
  if (!res.ok) throw new Error(`spec load failed for ${provider}: ${res.errors.join('; ')}`);
  return res.spec;
}

// ── Part A: the shipped specs declare a modal_kind for every modal state ──────
//
// The auto-approve gate is provider-common: it relies on every modal state in
// the live (manifest-referenced) spec carrying a kind. A picker state must read
// as 'picker'; approval/trust consent states as 'approval'. A modal state with
// no kind would default to 'approval' and could be auto-answered — so the audit
// also fails any modal state that is left unclassified.

describe('shipped CLI specs — every modal state carries a modal_kind', () => {
  for (const provider of CLI_PROVIDERS) {
    it(`${provider}: picker→'picker', approval/trust→'approval', no modal state unclassified`, () => {
      const spec = loadLiveSpec(provider);
      const modalStates = spec.states.filter(s => s.modal);
      expect(modalStates.length).toBeGreaterThan(0);
      for (const state of modalStates) {
        const kind = modalKindForState(state);
        expect(kind, `${provider} state '${state.id}' must declare a modal_kind`).not.toBeNull();
        if (state.id === 'picker') expect(kind, `${provider} '${state.id}'`).toBe('picker');
        if (state.id === 'approval' || state.id === 'trust') expect(kind, `${provider} '${state.id}'`).toBe('approval');
      }
    });
  }

  it('claude-cli live approval screen is classified approval by the real evaluator', () => {
    const spec = loadLiveSpec('claude-cli');
    // A real claude tool-consent prompt: the ❯ 1. choice block PLUS the decisive
    // modal chrome a real screen always renders — the "Do you want to proceed?"
    // question and the "Esc to cancel · Tab to amend · ctrl+e to explain" footer.
    // (The ❯ 1. anchor alone is no longer sufficient — APPROVESTUCK fixA requires
    // the decisive marker so a worker-typed "1." composer line cannot false-enter
    // approval. See fsm-evaluator-claude.test.ts.)
    const approvalScreen = [
      '⏺ I will run a command.',
      '────────────────────────────────────────────',
      ' Bash command',
      ' npm test',
      ' Do you want to proceed?',
      '❯ 1. Yes',
      "  2. Yes, and don't ask again",
      '  3. No, tell Claude what to do differently',
      '────────────────────────────────────────────',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n');
    const ev = evaluateFsm(spec, 'idle', approvalScreen, { row: 8, col: 2 }, undefined,
      { now: 10_000, stateEnteredAt: 0, regionLastChangedAt: new Map() });
    expect(ev.fired?.to).toBe('approval');
    const state = stateById(spec, 'approval')!;
    expect(modalKindForState(state)).toBe('approval');
  });
});

// ── Part B: real evaluator → real kind → real auto-approve gate ───────────────
//
// A minimal but faithful v4 spec (run through the real loader + evaluator, NOT
// a stub) with an approval state (kind=approval) and a picker state
// (kind=picker). We drive idle→{picker,approval} with screens, take the kind
// from the real modalKindForState (exactly what FsmDriver.emitStateChanged puts
// on the emitted modal), and feed an adapter-shaped status into the real
// maybeAutoApproveStatus.

function miniSpec(): CliSpecV4 {
  return {
    $schema: 'adhdev:cli/spec@4', id: 'test.modal-kind', name: 'modal-kind', binary: '/bin/true',
    send_message: { submit_key: '\r' },
    sections: { zone: { from_bottom: 6 } },
    states: [
      { id: 'idle', label: 'Ready', initial: true, status: 'idle' },
      { id: 'approval', label: 'Approval', modal: true, modal_kind: 'approval',
        extract: { buttons: { section: 'zone', pattern: '^\\s*(?:[❯>]\\s*)?(\\d+)\\.\\s*(.+?)\\s*$', flags: 'gm', key_for_index: '{index}\r', min_count: 2 } } },
      { id: 'picker', label: 'Picker', modal: true, modal_kind: 'picker',
        extract: { buttons: { section: 'zone', pattern: '^\\s*(?:[❯>]\\s*)?(\\d+)\\.\\s*(.+?)\\s*$', flags: 'gm', key_for_index: '{index}\r' } } },
    ],
    transitions: [
      { from: 'idle', to: 'picker', priority: 100, when: { section: 'zone', matches: 'Select a model' } },
      { from: 'idle', to: 'approval', priority: 90, when: { section: 'zone', matches: 'Allow command' } },
    ],
  } as unknown as CliSpecV4;
}

const PICKER_SCREEN = ['(body)', 'Select a model', '', '❯ 1. Default (recommended)', '  2. Opus', '  3. Sonnet'].join('\n');
const APPROVAL_SCREEN = ['(body)', 'Allow command npm test?', '', '❯ 1. Yes', "  2. Yes, and don't ask again", '  3. No, tell Claude'].join('\n');

/** Run the real evaluator and return the kind the driver would emit. */
function classify(screen: string): { stateId: string; kind: 'approval' | 'picker' | 'confirm' | null } {
  const spec = miniSpec();
  const ev = evaluateFsm(spec, 'idle', screen, { row: 5, col: 2 }, undefined,
    { now: 10_000, stateEnteredAt: 0, regionLastChangedAt: new Map() });
  const state = ev.fired ? stateById(spec, ev.fired.to)! : null;
  return { stateId: ev.fired?.to ?? '(none)', kind: state ? modalKindForState(state) : null };
}

const SETTLE_MS = 600;
const liveInstances: any[] = [];

function makeGate(): { instance: any; resolves: number[]; fires: number; call: (status: any, now: number) => void } {
  const resolves: number[] = [];
  let fires = 0;
  const instance = Object.create(CliProviderInstance.prototype) as any;
  instance.type = 'claude-cli';
  instance.provider = { name: 'Claude', settings: {} };
  instance.settings = { autoApprove: true };
  instance.autoApproveBusy = false;
  instance.autoApproveBusyTimer = null;
  instance.autoApproveSettleTimer = null;
  instance.lastAutoApprovalSignature = '';
  instance.pendingAutoApprovalSignature = '';
  instance.pendingAutoApprovalSince = 0;
  instance.autoApproveInactiveSince = 0;
  instance.manualAttendance = new ManualAttendanceTracker();
  instance.adapter = { resolveModal: (i: number) => resolves.push(i), getStatus: () => ({ status: 'idle' }) };
  instance.appendRuntimeSystemMessage = () => { fires += 1; };
  liveInstances.push(instance);
  return {
    instance, resolves, get fires() { return fires; },
    call: (status: any, now: number) => instance.maybeAutoApproveStatus(status, now),
  } as any;
}

/** An adapter-shaped status, exactly as SpecCliAdapter.getStatus() builds it for
 *  a modal state: status=waiting_approval, activeModal carrying the kind. */
function modalStatus(kind: 'approval' | 'picker' | 'confirm' | null | undefined, buttons: string[], message = 'modal') {
  const activeModal: any = { message, buttons };
  if (kind !== undefined) activeModal.kind = kind;
  return { status: 'waiting_approval', activeModal };
}

afterEach(() => {
  for (const inst of liveInstances.splice(0)) {
    if (inst.autoApproveSettleTimer) clearTimeout(inst.autoApproveSettleTimer);
    if (inst.autoApproveBusyTimer) clearTimeout(inst.autoApproveBusyTimer);
  }
});

describe('auto-approve gate — picker excluded, approval preserved (real evaluator + real gate)', () => {
  it('the real evaluator classifies the /model screen as a picker and the consent screen as approval', () => {
    expect(classify(PICKER_SCREEN)).toEqual({ stateId: 'picker', kind: 'picker' });
    expect(classify(APPROVAL_SCREEN)).toEqual({ stateId: 'approval', kind: 'approval' });
  });

  it('does NOT auto-approve a picker modal — even past the settle window (the MODELSWITCH bug)', () => {
    const { kind } = classify(PICKER_SCREEN); // kind === 'picker', straight from the real evaluator
    const gate = makeGate();
    const status = modalStatus(kind, ['1. Default (recommended)', '2. Opus', '3. Sonnet'], 'Select a model');
    // Drive it repeatedly, well past SETTLE_MS — a picker must never resolve.
    gate.call(status, 1_000);
    gate.call(status, 1_000 + SETTLE_MS + 50);
    gate.call(status, 1_000 + SETTLE_MS * 3);
    expect(gate.resolves).toEqual([]);
    expect(gate.fires).toBe(0);
  });

  it('DOES auto-approve a genuine approval modal once settled (regression guard for worker auto-approve)', async () => {
    const { kind } = classify(APPROVAL_SCREEN); // kind === 'approval'
    const gate = makeGate();
    const status = modalStatus(kind, ['Yes', "Yes, and don't ask again", 'No, tell Claude']);
    gate.call(status, 1_000);                       // first sighting — starts settle clock
    expect(gate.fires).toBe(0);
    gate.call(status, 1_000 + SETTLE_MS + 50);      // settled → fire (recordAutoApproval is synchronous)
    expect(gate.fires).toBe(1);
    // resolveModal is deferred via setTimeout(0). Picks the affirmative ('Yes',
    // index 0) — never a decline, never a blind first.
    await new Promise(r => setTimeout(r, 10));
    expect(gate.resolves).toEqual([0]);
  });

  it('still auto-approves a legacy approval modal that carries NO kind (un-migrated specs preserved)', async () => {
    const gate = makeGate();
    const status = modalStatus(undefined, ['Yes', 'No']); // kind absent → defaults to approval
    gate.call(status, 1_000);
    gate.call(status, 1_000 + SETTLE_MS + 50);
    expect(gate.fires).toBe(1);
    await new Promise(r => setTimeout(r, 10));
    expect(gate.resolves).toEqual([0]);
  });

  it('does NOT auto-approve a picker-shaped modal even when kind is absent (structural backstop)', () => {
    // A picker with no decline option and no affirmative hint must be left for the
    // user via the pickApprovalButton/hasNegativeApprovalOption anchor, even if the
    // spec predates modal_kind.
    const gate = makeGate();
    const status = modalStatus(undefined, ['1. Default (recommended)', '2. Opus', '3. Sonnet']);
    gate.call(status, 1_000);
    gate.call(status, 1_000 + SETTLE_MS + 50);
    gate.call(status, 1_000 + SETTLE_MS * 3);
    expect(gate.resolves).toEqual([]);
  });

  it("does NOT auto-approve a 'confirm' modal (left to the user)", () => {
    const gate = makeGate();
    const status = modalStatus('confirm', ['Yes', 'No']);
    gate.call(status, 1_000);
    gate.call(status, 1_000 + SETTLE_MS + 50);
    expect(gate.resolves).toEqual([]);
  });

  // ── P1a: tall-diff off-frame decline fallback (#137) ────────────────────────
  it('DOES auto-approve when "No" scrolled off-frame but a grant-scope affirmative remains', async () => {
    // Tall Write/Edit diff pushed "3. No" below the captured frame — only the
    // allow-once "Yes" and the "Yes, allow … this session" grant survive. The
    // grant option is a reliable consent anchor, so the gate still fires and
    // picks the least-permissive "Yes" (index 0), never the broader grant.
    const gate = makeGate();
    const status = modalStatus('approval', [
      'Yes',
      'Yes, allow all edits in tmp/ during this session (shift+tab)',
    ]);
    gate.call(status, 1_000);
    expect(gate.fires).toBe(0);
    gate.call(status, 1_000 + SETTLE_MS + 50);
    expect(gate.fires).toBe(1);
    await new Promise(r => setTimeout(r, 10));
    expect(gate.resolves).toEqual([0]);
  });

  it('still does NOT auto-approve a Yes-only modal with neither a decline nor a grant anchor', () => {
    // "Yes" + "Continue" — an affirmative pair with no decline and no scoped
    // grant. Not a reliable consent prompt; the gate must leave it for the user.
    const gate = makeGate();
    const status = modalStatus('approval', ['Yes', 'Continue']);
    gate.call(status, 1_000);
    gate.call(status, 1_000 + SETTLE_MS + 50);
    gate.call(status, 1_000 + SETTLE_MS * 3);
    expect(gate.resolves).toEqual([]);
    expect(gate.fires).toBe(0);
  });
});

describe('miniSpec sanity', () => {
  it('validates cleanly through the real loader', () => {
    expect(validateFsmSpec(miniSpec())).toEqual([]);
  });
});
