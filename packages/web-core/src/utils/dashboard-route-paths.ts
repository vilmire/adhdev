export function getDashboardActiveTabHref(targetKey: string): string {
  return `/dashboard?activeTab=${encodeURIComponent(targetKey)}`
}
