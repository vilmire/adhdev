import {
  formatRuntimeOwner,
  getSessionHostRecoveryLabel,
  getSessionHostSurfaceKind,
  type SessionHostRecord,
} from '@adhdev/session-host-core'

function getRuntimeNextAction(record: SessionHostRecord): 'attach' | 'recover' | 'restart' {
  const surfaceKind = getSessionHostSurfaceKind(record)
  if (surfaceKind === 'live_runtime') return 'attach'
  if (surfaceKind === 'recovery_snapshot') return 'recover'
  return 'restart'
}

function formatSurfaceKindLabel(record: SessionHostRecord): string {
  const surfaceKind = getSessionHostSurfaceKind(record)
  if (surfaceKind === 'live_runtime') return 'live runtime'
  if (surfaceKind === 'recovery_snapshot') return 'recovery snapshot'
  return 'inactive record'
}

export function formatMuxRuntimeListHeader(): string {
  return 'Raw session-host records visible to adhmux (may include recovery snapshots and stopped records). Use `adhdev runtime list` for the primary live/recovery view.'
}

export function formatMuxRuntimeListLine(record: SessionHostRecord): string {
  const recovery = getSessionHostRecoveryLabel(record.meta || undefined)
  const extras = [
    `surface=${formatSurfaceKindLabel(record)}`,
    `next=${getRuntimeNextAction(record)}`,
    recovery ? `recovery=${recovery}` : '',
    `owner=${formatRuntimeOwner(record)}`,
    `clients=${record.attachedClients.length}`,
  ].filter(Boolean).join('\t')

  return `${record.runtimeKey}\t${record.lifecycle}\t${record.workspaceLabel}\t${extras}`
}
