import type { DaemonData } from '../types'

function needsMachineRuntimeRefresh(entry: DaemonData): boolean {
  const info = entry.machine
  return typeof info?.cpus !== 'number'
    || typeof info?.totalMem !== 'number'
    || typeof info?.arch !== 'string'
    || typeof info?.release !== 'string'
}

export function getDashboardMachineRefreshTargets(machineEntries: DaemonData[]) {
  return {
    metadataDaemonIds: machineEntries.map((entry) => entry.id),
    runtimeDaemonIds: machineEntries
      .filter((entry) => needsMachineRuntimeRefresh(entry))
      .map((entry) => entry.id),
  }
}
