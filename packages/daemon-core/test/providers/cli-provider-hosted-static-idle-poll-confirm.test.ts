import { describe, it, expect } from 'vitest';
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js';

// D4 — poll-driven static-idle confirm for hosted CLI sessions.
//
// A hosted antigravity coordinator is attached, not directly spawned: the attach
// path seeds the ready screen as a SINGLE get_snapshot→emitData burst and then goes
// silent. The boot banner drives the CLI FSM into 'busy' (agy spec busy.status =
// 'generating'), leaving the engine at currentStatus='generating',
// isWaitingForResponse=true, currentTurnScope=null (exactly what
// CliStateEngine.applyGenerating leaves when detectStatus fires with no active turn).
//
// agy's ready prompt ('? for shortcuts') is STATIC — no redraw — so no further PTY
// output arrives. Every output-driven busy→idle re-eval (handleOutput /
// resolveStartupState / scheduleSettle) is starved, and the startup-settle loop has
// hard-stopped past spawnAt+10s. currentStatus stays frozen at generating,
// status.updatedAt freezes, and the dashboard disables Send → no message can be
// delivered. (A directly-launched worker keeps redrawing its TUI so handleOutput
// keeps firing and it reaches idle on its own — hosted-only.)
//
// The fix adds a busy→idle re-evaluation on the CURRENT screen buffer in
// getStatus(allowParse:true) — the poll-driven path — that is NOT gated on
// startupParseGate and does NOT require new PTY output. It reuses
// resolveStartupState's proven predicates:
//   (a) no recent output for >= statusActivityHold (the 2000ms stable window),
//   (b) runDetectStatus(current screen) === 'idle' (the same detector),
//   (c) no active/parsed modal (an approval/choice screen is never flipped to idle),
// plus the engine's structural guard (generating + no currentTurnScope + no modal).
//
// These tests drive a real ProviderCliAdapter's getStatus gate directly. The real
// agy spec's '? for shortcuts' / 'esc to cancel' predicates are covered separately
// by providers/spec/fsm-evaluator-antigravity.test.ts; here the inline
// detectStatus/parseApproval mirror those live predicates so the gate is exercised
// deterministically without spinning the FSM driver.

const STATIC_IDLE_SCREEN = [
    '  Welcome to Antigravity CLI',
    '  Type a message to start...',
    '',
    '  ? for shortcuts',
].join('\n');

const BUSY_SCREEN = [
    '  Analyzing your codebase...',
    '  ⠹ Thinking...',
    '',
    '  esc to cancel  ·  ? for shortcuts',
].join('\n');

const APPROVAL_SCREEN = [
    '  agy wants to run: git push origin main',
    '  Do you want to proceed?',
    '  › 1. Yes, run this',
    '    2. No, skip',
    '  ? for shortcuts',
].join('\n');

// Inline scripts mirroring the live agy predicates: 'esc to cancel' → busy,
// an approval modal → waiting_approval, '? for shortcuts' with neither → idle.
function makeScripts() {
    return {
        detectStatus: (input: any) => {
            const text = String(input?.screenText ?? input?.tail ?? '');
            if (/esc to cancel/i.test(text)) return 'generating';
            if (/Do you want to proceed\?/i.test(text)) return 'waiting_approval';
            if (/\? for shortcuts/i.test(text)) return 'idle';
            return null;
        },
        parseApproval: (input: any) => {
            const text = String(input?.screenText ?? input?.buffer ?? input?.tail ?? '');
            if (/Do you want to proceed\?/i.test(text)) {
                return { message: 'Do you want to proceed?', buttons: ['Yes, run this', 'No, skip'] };
            }
            return null;
        },
    };
}

function buildHostedWedgeAdapter(screen: string, opts: { lastNonEmptyOutputAgoMs: number } = { lastNonEmptyOutputAgoMs: 5000 }) {
    const adapter = new ProviderCliAdapter({
        type: 'antigravity-cli',
        name: 'Antigravity CLI',
        category: 'cli',
        binary: 'agy',
        spawn: { command: 'agy', args: [], shell: true, env: {} },
        scripts: makeScripts(),
        // statusActivityHold defaults to 2000ms; the wedge case is 5s+ quiet.
    } as any, '/tmp/project') as any;

    // Drive the adapter into the hosted static-idle WEDGE state directly: the
    // engine is where applyGenerating left it on the boot banner.
    adapter.startupParseGate = false;                 // startup window elapsed (past spawnAt+10s)
    adapter.spawnAt = Date.now() - 20_000;
    adapter.ready = true;
    adapter.terminalScreen = { getText: () => screen };
    adapter.recentOutputBuffer = screen;
    adapter.lastNonEmptyOutputAt = Date.now() - opts.lastNonEmptyOutputAgoMs;
    adapter.lastOutputAt = adapter.lastNonEmptyOutputAt;

    // Engine wedge: generating with an in-flight flag but NO real turn scope.
    adapter.engine.setStatus('generating', 'boot_banner');
    adapter.engine.isWaitingForResponse = true;
    adapter.engine.currentTurnScope = null;
    adapter.engine.activeModal = null;

    return adapter;
}

describe('ProviderCliAdapter — hosted static-idle poll confirm (D4)', () => {
    it('WEDGE RELEASE: a hosted static-idle ready screen flips busy→idle on the poll', () => {
        const adapter = buildHostedWedgeAdapter(STATIC_IDLE_SCREEN);
        expect(adapter.engine.currentStatus).toBe('generating');

        const status = adapter.getStatus({ allowParse: true });

        expect(status.status).toBe('idle');
        expect(adapter.engine.currentStatus).toBe('idle');
        expect(adapter.engine.isWaitingForResponse).toBe(false);
    });

    it('POST-TURN: a coordinator that finished a turn and went static-idle also flips', () => {
        // Same wedge shape, reached via completion rather than boot: the turn scope
        // has been nulled and the screen is the static ready prompt again.
        const adapter = buildHostedWedgeAdapter(STATIC_IDLE_SCREEN, { lastNonEmptyOutputAgoMs: 8000 });

        const status = adapter.getStatus({ allowParse: true });

        expect(status.status).toBe('idle');
        expect(adapter.engine.currentStatus).toBe('idle');
    });

    it('NEGATIVE: a screen showing "esc to cancel" STAYS generating (real turn)', () => {
        const adapter = buildHostedWedgeAdapter(BUSY_SCREEN);

        const status = adapter.getStatus({ allowParse: true });

        expect(status.status).toBe('generating');
        expect(adapter.engine.currentStatus).toBe('generating');
    });

    it('NEGATIVE: fresh output within the grace window STAYS generating', () => {
        // Screen detects idle, but the session emitted output <statusActivityHold ago
        // — it may still be mid-turn between chunks. Do not flip.
        const adapter = buildHostedWedgeAdapter(STATIC_IDLE_SCREEN, { lastNonEmptyOutputAgoMs: 500 });

        const status = adapter.getStatus({ allowParse: true });

        expect(status.status).toBe('generating');
        expect(adapter.engine.currentStatus).toBe('generating');
    });

    it('NEGATIVE: an approval/modal screen is NOT flipped to idle', () => {
        const adapter = buildHostedWedgeAdapter(APPROVAL_SCREEN);

        const status = adapter.getStatus({ allowParse: true });

        expect(status.status).not.toBe('idle');
        expect(adapter.engine.currentStatus).not.toBe('idle');
    });

    it('does not flip on the non-poll (allowParse:false) path', () => {
        const adapter = buildHostedWedgeAdapter(STATIC_IDLE_SCREEN);

        const status = adapter.getStatus({ allowParse: false });

        // The poll-confirm only runs on the allowParse path (the status tick).
        expect(status.status).toBe('generating');
        expect(adapter.engine.currentStatus).toBe('generating');
    });
});
