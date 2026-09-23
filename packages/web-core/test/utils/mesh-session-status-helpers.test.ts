import { describe, expect, it } from 'vitest'
import {
  classifySessionStatusBucket,
  sessionStatusLabel,
  sessionStatusLabelKey,
} from '../../src/components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers'
import type { MeshGraphSessionDetail } from '../../src/utils/mesh-visualization'

function session(fields: Partial<MeshGraphSessionDetail>): MeshGraphSessionDetail {
  return {
    sessionId: 'sess_1',
    workspace: '/repo',
    ...fields,
  } as MeshGraphSessionDetail
}

describe('sessionStatusLabel (shared MeshGraph status helper)', () => {
  // Golden values: the three labels every one of the three now-removed
  // duplicate copies (MeshGraphView, MeshOverviewCards, MeshGraphPanel) had to
  // keep rendering identically after consolidating onto this one helper.
  it('labels an approval-blocked session "awaiting approval"', () => {
    expect(sessionStatusLabel(session({ chatStatus: 'waiting_approval' }))).toBe('awaiting approval')
    expect(sessionStatusLabel(session({ state: 'awaiting_approval' }))).toBe('awaiting approval')
  })

  it('labels a working session "generating", including raw aliases running/busy', () => {
    expect(sessionStatusLabel(session({ chatStatus: 'generating' }))).toBe('generating')
    expect(sessionStatusLabel(session({ chatStatus: 'running' }))).toBe('generating')
    expect(sessionStatusLabel(session({ chatStatus: 'busy' }))).toBe('generating')
  })

  it('labels a ready session "idle"', () => {
    expect(sessionStatusLabel(session({ chatStatus: 'idle' }))).toBe('idle')
    expect(sessionStatusLabel(session({ chatStatus: 'ready' }))).toBe('idle')
  })

  it('falls through unrecognized spellings to a space-joined raw word (matches MeshGraphView failed/stopped/interrupted branch)', () => {
    expect(sessionStatusLabel(session({ chatStatus: 'stopped' }))).toBe('stopped')
    expect(sessionStatusLabel(session({ chatStatus: 'interrupted' }))).toBe('interrupted')
    expect(sessionStatusLabel(session({ chatStatus: 'some_weird_status' }))).toBe('some weird status')
  })

  it('returns "unknown" when chatStatus/state/lifecycle are all empty', () => {
    expect(sessionStatusLabel(session({}))).toBe('unknown')
  })

  it('reads chatStatus, then state, then lifecycle, in that precedence', () => {
    expect(sessionStatusLabel(session({ chatStatus: '', state: 'idle', lifecycle: 'generating' }))).toBe('idle')
    expect(sessionStatusLabel(session({ chatStatus: '', state: '', lifecycle: 'generating' }))).toBe('generating')
  })
})

describe('classifySessionStatusBucket', () => {
  it('buckets canonical and aliased spellings the same way', () => {
    expect(classifySessionStatusBucket(session({ chatStatus: 'running' })).bucket).toBe('generating')
    expect(classifySessionStatusBucket(session({ chatStatus: 'streaming' })).bucket).toBe('generating')
    expect(classifySessionStatusBucket(session({ chatStatus: 'waiting_choice' })).bucket).toBe('other')
  })
})

describe('sessionStatusLabelKey (i18n variant used by MeshGraphPanel)', () => {
  const keys = { approval: 'k.approval', generating: 'k.generating', idle: 'k.idle' }
  const t = (key: string) => `T:${key}`

  it('routes bucketed statuses through the provided i18n keys', () => {
    expect(sessionStatusLabelKey(session({ chatStatus: 'waiting_approval' }), t, keys)).toBe('T:k.approval')
    expect(sessionStatusLabelKey(session({ chatStatus: 'generating' }), t, keys)).toBe('T:k.generating')
    expect(sessionStatusLabelKey(session({ chatStatus: 'idle' }), t, keys)).toBe('T:k.idle')
  })

  it('falls back to the raw normalized word for unbucketed statuses, same as the English label', () => {
    expect(sessionStatusLabelKey(session({ chatStatus: 'stopped' }), t, keys)).toBe('stopped')
  })
})
