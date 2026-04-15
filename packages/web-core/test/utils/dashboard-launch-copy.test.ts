import { describe, expect, it } from 'vitest'
import {
  getCliLaunchPrimaryActionLabel,
  getCliLaunchBusyLabel,
  getCliResumeSelectPlaceholder,
  getHostedRuntimeRecoveryDescription,
  getHostedRuntimeReviewButtonLabel,
  getLaunchPrimaryActionLabel,
  getLaunchPrimaryBusyLabel,
  getMachineLaunchBusyLabel,
  getMachineLaunchConfirmDescription,
  getMachineLaunchConfirmLabel,
  getMachineLaunchConfirmTitle,
  getOpenHistoryLabel,
  getRecentHistoryResumeConfirmDescription,
  getRecentHistoryResumeConfirmTitle,
  getRefreshSavedHistoryLabel,
  getRefreshingSavedHistoryLabel,
  getSavedHistoryEmptyStateLabel,
  getSavedHistoryHelperLabel,
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

  it('exposes shared launch button copy across dashboard and machine flows', () => {
    expect(getLaunchPrimaryActionLabel('cli', false)).toBe('Start fresh')
    expect(getLaunchPrimaryBusyLabel('cli', false)).toBe('Starting fresh…')
    expect(getLaunchPrimaryActionLabel('cli', true)).toBe('Resume saved history')
    expect(getLaunchPrimaryBusyLabel('cli', true)).toBe('Resuming saved history…')
    expect(getLaunchPrimaryActionLabel('ide')).toBe('Start IDE')
    expect(getLaunchPrimaryBusyLabel('ide')).toBe('Starting IDE…')
    expect(getLaunchPrimaryActionLabel('acp')).toBe('Start ACP session')
    expect(getLaunchPrimaryBusyLabel('acp')).toBe('Starting ACP session…')
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
    expect(getSavedHistoryHelperLabel()).toBe('Use saved history when you want continuity in the same provider conversation.')
    expect(getSavedHistoryEmptyStateLabel()).toBe('No saved history found yet.')
    expect(getRefreshSavedHistoryLabel()).toBe('Refresh saved history')
    expect(getRefreshingSavedHistoryLabel()).toBe('Refreshing saved history…')
  })

  it('describes hosted runtime recovery as a fallback path', () => {
    expect(getHostedRuntimeReviewButtonLabel()).toBe('Recover hosted runtime')
    expect(getHostedRuntimeRecoveryDescription()).toBe('Fallback recovery for hosted runtimes after interruptions. For normal continuity, open saved history instead.')
  })

  it('uses explicit machine launch-confirm wording for start-fresh and restart flows', () => {
    expect(getMachineLaunchConfirmTitle('start-fresh', 'Claude Code')).toBe('Start fresh with Claude Code?')
    expect(getMachineLaunchConfirmDescription('start-fresh')).toBe('Review the provider and target folder before starting fresh.')
    expect(getMachineLaunchConfirmLabel('start-fresh')).toBe('Start fresh')
    expect(getMachineLaunchBusyLabel('start-fresh')).toBe('Starting fresh…')

    expect(getMachineLaunchConfirmTitle('restart-ide', 'Cursor')).toBe('Restart Cursor?')
    expect(getMachineLaunchConfirmDescription('restart-ide')).toBe('Review or change the target workspace before restarting this IDE.')
    expect(getMachineLaunchConfirmLabel('restart-ide')).toBe('Restart')
    expect(getMachineLaunchBusyLabel('restart-ide')).toBe('Restarting…')

    expect(getMachineLaunchConfirmTitle('restart-stopped', 'Claude Code')).toBe('Restart Claude Code?')
    expect(getMachineLaunchConfirmDescription('restart-stopped')).toBe('Review or change the target workspace before restarting this stopped session.')
  })

  it('uses saved-history resume wording for recent launch entries with provider history', () => {
    expect(getRecentHistoryResumeConfirmTitle('Claude Code')).toBe('Resume saved history with Claude Code?')
    expect(getRecentHistoryResumeConfirmDescription()).toBe('Review or change the target workspace before resuming saved history.')
  })
})
