import type { TFunction } from 'i18next'

type T = TFunction

export function getCliLaunchPrimaryActionLabel(tOrIsResume: T | boolean, isResume?: boolean): string {
  if (typeof tOrIsResume === 'function') {
    return (isResume ?? false) ? tOrIsResume('launch.resumeSavedHistory') : tOrIsResume('launch.startFresh')
  }
  return tOrIsResume ? 'Resume saved history' : 'Start fresh'
}

export function getCliLaunchBusyLabel(tOrIsResume: T | boolean, isResume?: boolean): string {
  if (typeof tOrIsResume === 'function') {
    return (isResume ?? false) ? tOrIsResume('launch.resumingSavedHistory') : tOrIsResume('launch.startingFresh')
  }
  return tOrIsResume ? 'Resuming saved history…' : 'Starting fresh…'
}

export function getCliResumeSelectPlaceholder(t?: T): string {
  return t ? t('launch.startFresh') : 'Start fresh'
}

export type LaunchPrimaryActionKind = 'cli' | 'ide' | 'acp'

export function getLaunchPrimaryActionLabel(tOrKind: T | LaunchPrimaryActionKind, kindOrIsResume?: LaunchPrimaryActionKind | boolean, isResume = false): string {
  if (typeof tOrKind === 'function') {
    const kind = kindOrIsResume as LaunchPrimaryActionKind
    if (kind === 'cli') return getCliLaunchPrimaryActionLabel(tOrKind, isResume)
    if (kind === 'ide') return tOrKind('launch.startIde')
    return tOrKind('launch.startAcpSession')
  }
  const kind = tOrKind
  const resume = kindOrIsResume as boolean | undefined
  if (kind === 'cli') return getCliLaunchPrimaryActionLabel(resume ?? false)
  if (kind === 'ide') return 'Start IDE'
  return 'Start ACP session'
}

export function getLaunchPrimaryBusyLabel(tOrKind: T | LaunchPrimaryActionKind, kindOrIsResume?: LaunchPrimaryActionKind | boolean, isResume = false): string {
  if (typeof tOrKind === 'function') {
    const kind = kindOrIsResume as LaunchPrimaryActionKind
    if (kind === 'cli') return getCliLaunchBusyLabel(tOrKind, isResume)
    if (kind === 'ide') return tOrKind('launch.startingIde')
    return tOrKind('launch.startingAcpSession')
  }
  const kind = tOrKind
  const resume = kindOrIsResume as boolean | undefined
  if (kind === 'cli') return getCliLaunchBusyLabel(resume ?? false)
  if (kind === 'ide') return 'Starting IDE…'
  return 'Starting ACP session…'
}

export function getHostedRuntimeReviewButtonLabel(t?: T): string {
  return t ? t('launch.recoverHostedRuntime') : 'Recover hosted runtime'
}

export function getHostedRuntimeRecoveryDescription(t?: T): string {
  return t
    ? t('launch.hostedRuntimeRecoveryDescription')
    : 'Fallback recovery for hosted runtimes after interruptions. For normal continuity, open saved history instead.'
}

export function getOpenHistoryLabel(t?: T): string {
  return t ? t('launch.openSavedHistory') : 'Open saved history'
}

export function getSavedHistoryModalTitle(t?: T): string {
  return t ? t('launch.savedHistoryTitle') : 'Saved History'
}

export function getSavedHistoryHelperLabel(t?: T): string {
  return t
    ? t('launch.savedHistoryHelper')
    : 'Use saved history when you want continuity in the same provider conversation.'
}

export function getSavedHistoryEmptyStateLabel(t?: T): string {
  return t ? t('launch.savedHistoryEmpty') : 'No saved history found yet.'
}

export function getRefreshSavedHistoryLabel(t?: T): string {
  return t ? t('launch.refreshSavedHistory') : 'Refresh saved history'
}

export function getRefreshingSavedHistoryLabel(t?: T): string {
  return t ? t('launch.refreshingSavedHistory') : 'Refreshing saved history…'
}

export type MachineLaunchConfirmScenario = 'start-fresh' | 'restart-ide' | 'restart-stopped'

export function getMachineLaunchConfirmTitle(tOrScenario: T | MachineLaunchConfirmScenario, scenarioOrLabel: MachineLaunchConfirmScenario | string, label?: string): string {
  if (typeof tOrScenario === 'function') {
    const scenario = scenarioOrLabel as MachineLaunchConfirmScenario
    const lbl = label as string
    if (scenario === 'start-fresh') return tOrScenario('launch.startFreshWith', { label: lbl })
    return tOrScenario('launch.restart', { label: lbl })
  }
  const scenario = tOrScenario
  const lbl = scenarioOrLabel as string
  if (scenario === 'start-fresh') return `Start fresh with ${lbl}?`
  return `Restart ${lbl}?`
}

export function getMachineLaunchConfirmDescription(tOrScenario: T | MachineLaunchConfirmScenario, scenario?: MachineLaunchConfirmScenario): string {
  if (typeof tOrScenario === 'function') {
    const s = scenario as MachineLaunchConfirmScenario
    if (s === 'start-fresh') return tOrScenario('launch.startFreshReview')
    if (s === 'restart-ide') return tOrScenario('launch.restartIdeReview')
    return tOrScenario('launch.restartStoppedReview')
  }
  const s = tOrScenario
  if (s === 'start-fresh') return 'Review the provider and target folder before starting fresh.'
  if (s === 'restart-ide') return 'Review or change the target workspace before restarting this IDE.'
  return 'Review or change the target workspace before restarting this stopped session.'
}

export function getMachineLaunchConfirmLabel(tOrScenario: T | MachineLaunchConfirmScenario, scenario?: MachineLaunchConfirmScenario): string {
  if (typeof tOrScenario === 'function') {
    const s = scenario as MachineLaunchConfirmScenario
    return s === 'start-fresh' ? tOrScenario('launch.confirmStartFresh') : tOrScenario('launch.confirmRestart')
  }
  return tOrScenario === 'start-fresh' ? 'Start fresh' : 'Restart'
}

export function getMachineLaunchBusyLabel(tOrScenario: T | MachineLaunchConfirmScenario, scenario?: MachineLaunchConfirmScenario): string {
  if (typeof tOrScenario === 'function') {
    const s = scenario as MachineLaunchConfirmScenario
    return s === 'start-fresh' ? tOrScenario('launch.confirmStartingFresh') : tOrScenario('launch.confirmRestarting')
  }
  return tOrScenario === 'start-fresh' ? 'Starting fresh…' : 'Restarting…'
}

export function getRecentHistoryResumeConfirmTitle(tOrLabel: T | string, label?: string): string {
  if (typeof tOrLabel === 'function') {
    return tOrLabel('launch.resumeWith', { label: label as string })
  }
  return `Resume saved history with ${tOrLabel}?`
}

export function getRecentHistoryResumeConfirmDescription(t?: T): string {
  return t
    ? t('launch.resumeReview')
    : 'Review or change the target workspace before resuming saved history.'
}
