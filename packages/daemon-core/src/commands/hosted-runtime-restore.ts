export function shouldRestoreHostedRuntime(
  record: { managedBy?: string | null | undefined },
  managerTag?: string,
): boolean {
  if (!managerTag) return true
  const managedBy = typeof record.managedBy === 'string' ? record.managedBy.trim() : ''
  if (!managedBy) return true
  return managedBy === managerTag
}
