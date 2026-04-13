import { describe, expect, it } from 'vitest'
import {
  getCliLaunchPrimaryActionLabel,
  getCliLaunchBusyLabel,
  getCliResumeSelectPlaceholder,
  getHostedRuntimeReviewButtonLabel,
  getOpenHistoryLabel,
  getRefreshSavedHistoryLabel,
  getSavedHistoryEmptyStateLabel,
  getSavedHistoryModalTitle,
} from '../../src/utils/dashboard-launch-copy'

describe('dashboard launch copy helpers', () => {
  it('uses Start fresh for non-resume CLI launches', () => {
    expect(getCliLaunchPrimaryActionLabel(false)).toBe('Start fresh')
    expect(getCliLaunchBusyLabel(false)).toBe('Starting fresh…')
  })

  it('uses Resume saved history for resume CLI launches', () => {
    expect(getCliLaunchPrimaryActionLabel(true)).toBe('Resume saved history')
    expect(getCliLaunchBusyLabel(true)).toBe('Resuming saved history…')
  })

  it('uses a short start-fresh placeholder in resume selectors', () => {
    expect(getCliResumeSelectPlaceholder()).toBe('Start fresh')
  })

  it('uses explicit hosted-runtime recovery copy for the session-host entrypoint', () => {
    expect(getHostedRuntimeReviewButtonLabel()).toBe('Recover hosted runtime')
  })

  it('uses a history action label that matches saved-history wording', () => {
    expect(getOpenHistoryLabel()).toBe('Open saved history')
  })

  it('uses saved-history labels inside the history modal flow', () => {
    expect(getSavedHistoryModalTitle()).toBe('Saved History')
    expect(getSavedHistoryEmptyStateLabel()).toBe('No saved history found yet.')
    expect(getRefreshSavedHistoryLabel()).toBe('Refresh saved history')
  })
})
