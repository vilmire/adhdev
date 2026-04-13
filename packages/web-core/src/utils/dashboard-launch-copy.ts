export function getCliLaunchPrimaryActionLabel(isResume: boolean): string {
  return isResume ? 'Resume saved history' : 'Start fresh'
}

export function getCliLaunchBusyLabel(isResume: boolean): string {
  return isResume ? 'Resuming saved history…' : 'Starting fresh…'
}

export function getCliResumeSelectPlaceholder(): string {
  return 'Start fresh'
}

export function getHostedRuntimeReviewButtonLabel(): string {
  return 'Recover hosted runtime'
}

export function getOpenHistoryLabel(): string {
  return 'Open saved history'
}

export function getSavedHistoryModalTitle(): string {
  return 'Saved History'
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
