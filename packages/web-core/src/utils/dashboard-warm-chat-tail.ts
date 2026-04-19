import type { MobileDashboardMode } from '../components/settings/MobileDashboardModeSection'

export function getDashboardWarmChatTailOptions(args: {
  isMobile: boolean
  mobileViewMode: MobileDashboardMode
}): { recentActivityMs: number } | undefined {
  return args.isMobile && args.mobileViewMode === 'chat'
    ? { recentActivityMs: 0 }
    : undefined
}
