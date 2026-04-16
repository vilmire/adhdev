import { describe, expect, it } from 'vitest'
import {
  getExplicitSessionRevealCommand,
  getPassiveSessionSelectionCommand,
} from '../../../src/components/dashboard/dashboardSessionCommands'

describe('dashboard session command wiring', () => {
  it('uses selection-only command names for passive tab activation paths', () => {
    expect(getPassiveSessionSelectionCommand()).toBe('select_session')
  })

  it('uses explicit reveal command names for Open Panel actions', () => {
    expect(getExplicitSessionRevealCommand()).toBe('open_panel')
  })
})
