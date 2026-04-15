export function getCliLaunchPrimaryActionLabel(isResume: boolean): string {
  return isResume ? 'Resume saved history' : 'Start fresh'
}

export function getCliLaunchBusyLabel(isResume: boolean): string {
  return isResume ? 'Resuming saved history…' : 'Starting fresh…'
}

export function getCliResumeSelectPlaceholder(): string {
  return 'Start fresh'
}

export type LaunchPrimaryActionKind = 'cli' | 'ide' | 'acp'

export function getLaunchPrimaryActionLabel(kind: LaunchPrimaryActionKind, isResume = false): string {
  if (kind === 'cli') return getCliLaunchPrimaryActionLabel(isResume)
  if (kind === 'ide') return 'Start IDE'
  return 'Start ACP session'
}

export function getLaunchPrimaryBusyLabel(kind: LaunchPrimaryActionKind, isResume = false): string {
  if (kind === 'cli') return getCliLaunchBusyLabel(isResume)
  if (kind === 'ide') return 'Starting IDE…'
  return 'Starting ACP session…'
}

export function getHostedRuntimeReviewButtonLabel(): string {
  return 'Recover hosted runtime'
}

export function getHostedRuntimeRecoveryDescription(): string {
  return 'Fallback recovery for hosted runtimes after interruptions. For normal continuity, open saved history instead.'
}

export function getOpenHistoryLabel(): string {
  return 'Open saved history'
}

export function getSavedHistoryModalTitle(): string {
  return 'Saved History'
}

export function getSavedHistoryHelperLabel(): string {
  return 'Use saved history when you want continuity in the same provider conversation.'
}

export function getSavedHistoryEmptyStateLabel(): string {
  return 'No saved history found yet.'
}

export function getRefreshSavedHistoryLabel(): string {
  return 'Refresh saved history'
}

export function getRefreshingSavedHistoryLabel(): string {
  return 'Refreshing saved history…'
}

export type MachineLaunchConfirmScenario = 'start-fresh' | 'restart-ide' | 'restart-stopped'

export function getMachineLaunchConfirmTitle(scenario: MachineLaunchConfirmScenario, label: string): string {
  if (scenario === 'start-fresh') return `Start fresh with ${label}?`
  return `Restart ${label}?`
}

export function getMachineLaunchConfirmDescription(scenario: MachineLaunchConfirmScenario): string {
  if (scenario === 'start-fresh') {
    return 'Review the provider and target folder before starting fresh.'
  }
  if (scenario === 'restart-ide') {
    return 'Review or change the target workspace before restarting this IDE.'
  }
  return 'Review or change the target workspace before restarting this stopped session.'
}

export function getMachineLaunchConfirmLabel(scenario: MachineLaunchConfirmScenario): string {
  return scenario === 'start-fresh' ? 'Start fresh' : 'Restart'
}

export function getMachineLaunchBusyLabel(scenario: MachineLaunchConfirmScenario): string {
  return scenario === 'start-fresh' ? 'Starting fresh…' : 'Restarting…'
}

export function getRecentHistoryResumeConfirmTitle(label: string): string {
  return `Resume saved history with ${label}?`
}

export function getRecentHistoryResumeConfirmDescription(): string {
  return 'Review or change the target workspace before resuming saved history.'
}
