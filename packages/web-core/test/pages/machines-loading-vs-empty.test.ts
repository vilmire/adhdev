import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// MACHINES PAGE — "still loading" must not render as "you have no machines".
//
// `ides` starts as an empty array in BaseDaemonContext, so `machines.length
// === 0` is indistinguishable from "the first `initial_state` has not arrived
// yet". Rendering the first-run onboarding on that condition alone told an
// existing user with four connected machines that they had none, and invited
// them to connect their first — for the ~5s until the WS message landed. The
// header counters made the same claim ("0 burrows / 0 online").
//
// The context already carries the flag that distinguishes the two
// (`initialLoaded`); this page simply never read it. The identical fix already
// shipped for the cloud /dashboard route in web-cloud's App.tsx — these tests
// keep /machines from drifting back.
//
// New users are unaffected: the daemon provider calls markLoaded() on
// `initial_state` even when the payload is empty, so a genuine zero-machine
// account still reaches onboarding on the first round trip. That is why the
// gate is `initialLoaded && length === 0` and never a timer.

const PAGE = path.join(import.meta.dirname, '../../src/pages/Machines.tsx')
const source = fs.readFileSync(PAGE, 'utf8')

const LOCALES = ['en', 'es', 'ja', 'ko', 'zh-CN']

describe('machines page — loading vs empty', () => {
  it('reads initialLoaded from the daemon context', () => {
    expect(source).toMatch(/const\s*\{[^}]*\binitialLoaded\b[^}]*\}\s*=\s*daemonCtx/)
  })

  it('gates the onboarding empty state on initialLoaded', () => {
    // The bare `machines.length === 0 &&` form is the defect.
    expect(source).toContain('{initialLoaded && machines.length === 0 && (')
    expect(source).not.toMatch(/\{machines\.length === 0 && \(/)
  })

  it('renders a neutral placeholder while the first state is in flight', () => {
    expect(source).toContain('{!initialLoaded && (')
    expect(source).toContain("t('machine.card.loading')")
  })

  it('does not assert burrow/online counts before data arrives', () => {
    // "0 burrows / 0 online" is a claim, not a placeholder.
    expect(source).toMatch(/\{initialLoaded && <span>\{t\('machine\.card\.burrowCount'/)
    expect(source).toMatch(/\{initialLoaded && <span className="text-green-500">● \{t\('machine\.card\.onlineCount'/)
  })

  it('keeps the placeholder visually distinct from the onboarding state', () => {
    // The placeholder must not look like either terminal state: no onboarding
    // headline, no install command.
    const start = source.indexOf('{!initialLoaded && (')
    const end = source.indexOf('{/* Empty state', start)
    // Anchor the bounds explicitly. Without this, removing the placeholder
    // makes both indexOf calls return -1, slice() yields a harmless string, and
    // the negative assertions below pass against code that has no placeholder
    // at all — a test that cannot fail.
    expect(start, 'placeholder block should exist').toBeGreaterThanOrEqual(0)
    expect(end, 'empty-state block should follow the placeholder').toBeGreaterThan(start)
    const placeholder = source.slice(start, end)
    expect(placeholder).not.toContain('emptyHeadline')
    expect(placeholder).not.toContain('InstallCommand')
  })

  it('ships the loading string in every locale', () => {
    for (const locale of LOCALES) {
      const file = path.join(import.meta.dirname, `../../src/i18n/locales/${locale}/common.json`)
      const dict = JSON.parse(fs.readFileSync(file, 'utf8'))
      const value = dict?.machine?.card?.loading
      expect(value, `${locale} machine.card.loading`).toBeTruthy()
      expect(typeof value).toBe('string')
    }
  })
})
