import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// TERMINAL-ADMISSION-ALL-PATHS — regression suite for the three paths that
// reached a terminal decision WITHOUT consulting evaluateTerminalAdmission.
//
// THE MEASUREMENT THIS SUITE PINS
// -------------------------------
// The admission gate landed guarding the transcript POLL. Live logs then showed
// it had never once run: 49/49 polls declined UPSTREAM of the gate
// (poll_terminal_evidence_timestamp_unusable), 0 completions produced. Every
// real false completion came from a path the gate did not cover.
//
//   (2) provider_event — the 10:49 incident. agent:generating_completed →
//       terminal `completed` committed 296ms later, while the SAME session had
//       logged native_transcript_advancing (msgCount=542) one second earlier.
//   (1) poll — a hard pre-return on an unusable timestamp made the gate
//       unreachable. The real cause was SHAPE (no final assistant selected in a
//       tool-heavy tail), reported as a timestamp verdict.
//   (3) acked-hold synth — fail-OPEN on the same freshness evidence the poll
//       treats as fail-CLOSED, inside the same file.
//
// The contracts under test, in order of importance:
//   A. a MOVING transcript cannot be promoted to terminal on ANY path
//   B. a GENUINE completion still passes on every path (if this breaks, every
//      task in the fleet wedges — it is tested first-class, not incidentally)
//   C. RECLAIM of a dead session still works — a timeout is not completion
//      evidence, but recovery is still owed
// ---------------------------------------------------------------------------

// Isolate all file I/O (ledger JSONL, MeshRuntimeStore) to a per-run temp dir so
// the suite never touches the production ~/.adhdev/mesh-ledger.
const testTmpDir = path.join(tmpdir(), `adhdev-admission-paths-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
  getMachineId: () => (({ machineId: 'test-machine' }) as any).machineId,
  getMachineNickname: () => (({ machineId: 'test-machine' }) as any).machineNickname ?? null,
}))

const meshConfigMocks = vi.hoisted(() => ({
  listMeshes: vi.fn(() => [] as any[]),
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  listMeshes: meshConfigMocks.listMeshes,
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
}))

import {
  evaluateTerminalAdmission,
  TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS,
} from '../../src/mesh/mesh-terminal-admission.js'
import { getTerminalAdmissionObservations } from '../../src/providers/completion/evidence.js'
// The (1) poll-path and (3) acked-hold-synth describes retired 2026-09-23 with
// mesh-completion-synthesis.ts (wiring-unification C4): the coordinator probe now
// only produces transcript_final evidence (turn-ledger/probe.ts) and the reducer's
// admission rules (turn-ledger/admission.ts) decide — pinned in
// test/turn-ledger/probe.test.ts and the C-W1 admission/reducer tables.

afterEach(() => {
  vi.restoreAllMocks()
})

const NOW = 1_760_000_000_000

// ── The provider-side observation bundle (what feeds the gate) ─────────────

describe('provider observations — transcript freshness is what the live-state gate misses', () => {
  function hostWith(messages: unknown[] | null, snapshot: unknown, modalParked = false) {
    return {
      isModalParked: () => modalParked,
      probeNativeTranscriptSignals: () => ({ snapshot, messages }),
      lastNativeTurnTerminalMarkers: null,
    } as any
  }

  it('★the 10:49 shape: a growing transcript with NO trailing tool bubble is still observed as fresh', () => {
    // This is the exact blind spot. hasTrailingToolActivityAfterFinalAssistant
    // returns false here (nothing trails the assistant), so the live-state gate
    // sees "not pending". The mtime age proves the file is still being written.
    const obs = getTerminalAdmissionObservations(
      hostWith(
        [{ role: 'user', content: 'task', timestamp: NOW - 120_000 },
         { role: 'assistant', content: 'Working on it', timestamp: NOW - 90_000 }],
        { available: true, detail: { msgCount: 542, ageMs: 1_000 } },
      ),
      NOW,
    )
    expect(obs.trailingActivityCount).toBe(0)
    expect(obs.finalAssistantPresent).toBe(true)
    // The mtime (1s) is FRESHER than the newest bubble timestamp (90s) — the
    // freshest observation wins, so the veto engages.
    expect(NOW - obs.newestActivityAtMs!).toBeLessThan(TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS)
  })

  it('takes the FRESHER of bubble timestamp and snapshot mtime (a newer observation can only strengthen the veto)', () => {
    const obs = getTerminalAdmissionObservations(
      hostWith(
        [{ role: 'assistant', content: 'done', timestamp: NOW - 500 }],
        { available: true, detail: { msgCount: 3, ageMs: 90_000 } },
      ),
      NOW,
    )
    expect(obs.newestActivityAtMs).toBe(NOW - 500)
  })

  it('fails OPEN on an unavailable snapshot / null messages / a throwing probe', () => {
    const unavailable = getTerminalAdmissionObservations(hostWith(null, { available: false }), NOW)
    expect(unavailable.newestActivityAtMs).toBeUndefined()
    expect(unavailable.finalAssistantPresent).toBe(false)

    const thrower = getTerminalAdmissionObservations({
      isModalParked: () => false,
      probeNativeTranscriptSignals: () => { throw new Error('read failed') },
      lastNativeTurnTerminalMarkers: null,
    } as any, NOW)
    expect(thrower.newestActivityAtMs).toBeUndefined()
  })

  it('marker FIELD presence discriminates version skew (absent list ≠ authoritative empty list)', () => {
    const absent = getTerminalAdmissionObservations(
      hostWith([], { available: true, detail: { msgCount: 0, ageMs: 60_000 } }), NOW)
    expect(absent.nativeMarkersFieldPresent).toBe(false)

    const present = getTerminalAdmissionObservations({
      isModalParked: () => false,
      probeNativeTranscriptSignals: () => ({ snapshot: { available: true, detail: { msgCount: 1, ageMs: 60_000 } }, messages: [] }),
      lastNativeTurnTerminalMarkers: [],
    } as any, NOW)
    expect(present.nativeMarkersFieldPresent).toBe(true)
  })
})

// ── (1) + (3): the rules the other two paths now share ────────────────────

describe('(1)+(3) shared freshness contract — a timeout is never completion evidence', () => {
  const base = {
    producer: 'unit',
    providerType: 'kimi',
    providerHasNativeMarker: false,
    nativeMarkersFieldPresent: false,
    providerObservedStatus: 'idle',
    activeModalPresent: false,
    finalAssistantPresent: true,
    trailingActivityCount: 0,
    turnStartedAtMs: NOW - 60_000,
    nowMs: NOW,
  }

  it('★no deadline, however old, bypasses the transcript_growing veto', () => {
    // (3)'s death-deadline case: 8 minutes past the ack is NOT evidence the turn
    // ended. Freshness — not the age of the row — decides.
    const v = evaluateTerminalAdmission({
      ...base,
      turnStartedAtMs: NOW - 8 * 60_000,
      newestActivityAtMs: NOW - 1_000,
    })
    expect(v.admit).toBe(false)
    expect(!v.admit && v.reason).toBe('transcript_growing')
  })

  it('★RECLAIM PRESERVED: a DEAD session (no fresh activity) is NOT vetoed by freshness', () => {
    // The distinction that keeps recovery alive: a dead worker's transcript does
    // not grow, so the veto never engages for it and the death-deadline synth /
    // reclaim path proceeds exactly as before. Only a MOVING tail is refused.
    const v = evaluateTerminalAdmission({ ...base, newestActivityAtMs: NOW - 15_518_000 })
    expect(v.admit).toBe(true)
  })

  it('★an unobservable tail (no timestamps at all) never manufactures a veto', () => {
    const v = evaluateTerminalAdmission({ ...base, newestActivityAtMs: undefined })
    expect(v.admit).toBe(true)
  })

  it('the boundary is exactly the quiet window, shared by both paths', () => {
    const justInside = evaluateTerminalAdmission({
      ...base, newestActivityAtMs: NOW - (TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS - 1),
    })
    expect(justInside.admit).toBe(false)

    const justOutside = evaluateTerminalAdmission({
      ...base, newestActivityAtMs: NOW - TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS,
    })
    expect(justOutside.admit).toBe(true)
  })
})

// ── (1) poll path — the timestamp-unusable demotion, end to end ───────────

// ── (3) acked-hold synth — fail-open/fail-closed symmetry ─────────────────
