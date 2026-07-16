// COMPLETIONMARKER-FALSEIDLE regression.
//
// A faithful, deterministic replay of the driver's own stable-clock loop
// (trackRegionChanges → evaluateFsm) over a real claude-cli frame sequence, run once
// with the OLD (buggy) ignore_lines and once with the shipped fix, to prove the
// before/after directly on the code path that owns the bug.
//
// Bug: the old busy→idle `ignore_lines` (`^\s*✻\s+\w[^\n]*$`) masked BOTH the active
// ticker (`✻ Polling…`) AND the completion marker (`✻ Worked for 9s`). During a long
// multi-tool turn the ticker repaints keep the un-filtered screen identical, so the
// whole-screen stable clock last moved when the spinner FIRST appeared. Between tools
// the PTY can be quiet ≥8s, so the moment the marker replaces the ticker, busy→idle's
// stable_ms:8000 clause reads TRUE off that stale clock → idle fires while the turn is
// really still going (marker got zero settle time). Fix: narrow ignore_lines so the
// `✻ … for Ns` marker is NOT masked — its appearance resets the clock, and idle only
// fires once the marker itself has been stable ≥8s. Live PTY capture (claude 2.1.170)
// confirms the marker is STATIC after it appears, so this reset happens once and never
// re-wedges busy.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateFsm, stableRegionKey, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { filterIgnoredLines } from '../../../src/providers/spec/fsm-driver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../..');
const SPEC_PATH = path.join(repoRoot, 'adhdev-providers/cli/claude-cli/specs/4.0.json');
const OLD_IGNORE = '^\\s*✻\\s+\\w[^\\n]*$|^\\s*[↑↓]\\s*[\\d.]+[km]?\\s*tokens?[^\\n]*$';

function loadSpec(useOldIgnore: boolean): any {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  if (useOldIgnore) {
    for (const t of spec.transitions) {
      if (t.label === 'busy→idle' || t.label === 'busy→idle-quiet') {
        for (const c of t.when.all) if (typeof c.stable_ms === 'number') c.ignore_lines = OLD_IGNORE;
      }
    }
  }
  return spec;
}

const D = '─'.repeat(64);
const HEAD = ['▗ ▗   ▖ ▖  Claude Code v2.1.153', '  ▘▘ ▝▝    ~/Work/adhdev', ''];
const TAIL = ['', D, '❯ ', D, '  ⏵⏵ accept edits on (shift+tab to cycle)'];
const frame = (...mid: string[]) => [...HEAD, ...mid, ...TAIL].join('\n');

// The transcript body is HELD CONSTANT across the spinner→marker swap — this is the
// real between-tools shape: the last assistant text is already on screen and the ONLY
// thing that changes is the spinner line turning into the completion marker. The
// ticker itself repaints (Polling→Churning) but with the OLD ignore those repaints are
// masked, so the whole-screen stable clock last moved when the spinner FIRST appeared.
type Step = { t: number; screen: string; note: string };
const BODY = '⏺ Analysis complete. Proceeding with the plan.';
const SEQ: Step[] = [
  { t: 0,     screen: frame(BODY, '', '✻ Polling…'),      note: 'busy: active ticker (spinner appears)' },
  { t: 1000,  screen: frame(BODY, '', '✻ Churning…'),     note: 'ticker repaint — masked by ignore' },
  { t: 2000,  screen: frame(BODY, '', '✻ Puzzling…'),     note: 'ticker repaint — masked by ignore' },
  { t: 4000,  screen: frame(BODY, '', '✻ Puzzling…'),     note: 'quiet: ticker still shown' },
  { t: 8000,  screen: frame(BODY, '', '✻ Puzzling…'),     note: 'quiet ≥ 8s since spinner appeared' },
  { t: 8500,  screen: frame(BODY, '', '✻ Puzzling…'),     note: 'quiet, marker not yet' },
  { t: 9000,  screen: frame(BODY, '', '✻ Worked for 9s'), note: 'MARKER appears (turn actually ends)' },
  { t: 12000, screen: frame(BODY, '', '✻ Worked for 9s'), note: 'marker stable +3s' },
  { t: 17500, screen: frame(BODY, '', '✻ Worked for 9s'), note: 'marker stable +8.5s' },
];

function replay(spec: any) {
  const descs: { key: number | string; ignoreRe: RegExp | undefined }[] = [];
  for (const lbl of ['busy→idle', 'busy→idle-quiet']) {
    const t = spec.transitions.find((x: any) => x.label === lbl);
    const stable = t.when.all.find((c: any) => typeof c.stable_ms === 'number');
    descs.push({ key: stableRegionKey(stable), ignoreRe: stable.ignore_lines ? new RegExp(stable.ignore_lines, 'm') : undefined });
  }
  descs.push({ key: -1, ignoreRe: undefined });

  const regionLastChangedAt = new Map<number | string, number>();
  let prevLines: string[] = [];
  let state = 'busy';
  const rows: { t: number; state: string; age: number; to?: string; note: string }[] = [];

  for (const step of SEQ) {
    const lines = step.screen.split('\n');
    if (prevLines.length > 0) {
      for (const d of descs) {
        const cur = filterIgnoredLines(lines, d.ignoreRe).join('\n');
        const prev = filterIgnoredLines(prevLines, d.ignoreRe).join('\n');
        if (cur !== prev) regionLastChangedAt.set(d.key, step.t);
      }
    }
    prevLines = lines;
    const clock: FsmClock = { now: step.t, stateEnteredAt: 0, regionLastChangedAt: new Map(regionLastChangedAt) };
    const ev = evaluateFsm(spec, state, step.screen, undefined, undefined, clock);
    const to = ev.fired?.to;
    const age = step.t - (regionLastChangedAt.get(descs[0].key) ?? 0);
    rows.push({ t: step.t, state, age, to, note: step.note });
    if (to) state = to;
  }
  return rows;
}

describe('COMPLETIONMARKER-FALSEIDLE — live before/after replay of real frame sequence', () => {
  it('BEFORE (old ignore masks the marker) → false-idle DURING the between-tools pause', () => {
    const rows = replay(loadSpec(true));
    console.log('\n[BEFORE old-ignore]');
    for (const r of rows) console.log(`  t=${String(r.t).padStart(5)} ${r.state.padEnd(5)} age=${String(r.age).padStart(5)} ${r.to ? '→'+r.to : ''}  [${r.note}]`);
    const firstIdle = rows.find(r => r.to === 'idle');
    // Bug: idle fires the INSTANT the marker appears (t=9000) off a stale spinner
    // clock — the marker itself got ZERO settle time. A real completion needs the
    // marker stable ≥8s (t≥17000); firing at 9000 with age=9000 is the false-idle.
    expect(firstIdle).toBeTruthy();
    expect(firstIdle!.t).toBe(9000);
    expect(firstIdle!.age).toBe(9000); // stale clock: measured from spinner appearance, not the marker
  });

  it('AFTER (new ignore detects the marker) → holds busy through pause, idles only after marker settles ≥8s', () => {
    const rows = replay(loadSpec(false));
    console.log('\n[AFTER new-ignore]');
    for (const r of rows) console.log(`  t=${String(r.t).padStart(5)} ${r.state.padEnd(5)} age=${String(r.age).padStart(5)} ${r.to ? '→'+r.to : ''}  [${r.note}]`);
    const firstIdle = rows.find(r => r.to === 'idle');
    // No false-idle before the marker appears (t=9000).
    const idleBeforeMarker = rows.find(r => r.to === 'idle' && r.t < 9000);
    expect(idleBeforeMarker).toBeUndefined();
    // Idle fires only once the marker itself has been stable ≥8s (t≈17000+).
    expect(firstIdle).toBeTruthy();
    expect(firstIdle!.t).toBeGreaterThanOrEqual(9000 + 8000);
  });
});
