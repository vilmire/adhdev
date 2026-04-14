import type { MachineRecentLaunch } from '../pages/machine/types'
import { formatRelativeTime } from './time'

export function getMachineRecentLaunchKindLabel(kind: MachineRecentLaunch['kind']): string {
  if (kind === 'ide') return 'IDE'
  if (kind === 'cli') return 'CLI'
  return 'ACP'
}

export function getMachineRecentLaunchMetaText(launch: Pick<MachineRecentLaunch, 'kind' | 'subtitle' | 'providerSessionId'>): string {
  return [
    getMachineRecentLaunchKindLabel(launch.kind),
    launch.subtitle || '',
    launch.providerSessionId ? 'Saved history' : '',
  ].filter(Boolean).join(' · ')
}

export function getMachineRecentLaunchUpdatedLabel(launch: Pick<MachineRecentLaunch, 'lastLaunchedAt'>): string {
  return launch.lastLaunchedAt ? formatRelativeTime(launch.lastLaunchedAt) : ''
}

export function buildMachineRecentLaunchCardView(
  launch: Pick<MachineRecentLaunch, 'kind' | 'subtitle' | 'providerSessionId' | 'lastLaunchedAt'>,
): { metaText: string; updatedLabel: string } {
  return {
    metaText: getMachineRecentLaunchMetaText(launch),
    updatedLabel: getMachineRecentLaunchUpdatedLabel(launch),
  }
}
