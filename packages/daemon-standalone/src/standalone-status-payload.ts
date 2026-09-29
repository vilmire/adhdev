/**
 * Standalone REST `/api/v1/status` response — a pure projection of the host
 * runtime's one snapshot builder. (The WS `type:'status'` push that used to
 * live here is gone: dashboard state rides the keyed `daemon.metadata` lane.)
 */

import * as os from 'os';
import {
  loadConfig,
  buildMachineInfo,
  type HostStatusSnapshot,
  type StatusResponse,
} from '@adhdev/daemon-core';

export function buildStandaloneStatusResponse(snapshot: HostStatusSnapshot): StatusResponse {
  const cfgSnap = loadConfig();
  const machineRuntime = buildMachineInfo('full');

  return {
    ...snapshot,
    id: snapshot.instanceId,
    type: 'standalone',
    platform: snapshot.machine.platform,
    hostname: snapshot.machine.hostname,
    userName: cfgSnap.userName || undefined,
    system: {
      cpus: snapshot.machine.cpus ?? machineRuntime.cpus ?? 0,
      totalMem: snapshot.machine.totalMem ?? machineRuntime.totalMem ?? 0,
      freeMem: snapshot.machine.freeMem ?? machineRuntime.freeMem ?? 0,
      availableMem: snapshot.machine.availableMem ?? machineRuntime.availableMem ?? 0,
      loadavg: snapshot.machine.loadavg ?? machineRuntime.loadavg ?? [],
      uptime: snapshot.machine.uptime ?? machineRuntime.uptime ?? 0,
      arch: snapshot.machine.arch ?? machineRuntime.arch ?? os.arch(),
    },
  };
}
