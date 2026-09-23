/**
 * Standalone status payloads — the REST `/api/v1/status` response, the WS
 * `type:'status'` push and its dedup signature. Pure projections of the host
 * runtime's one snapshot builder. Moved out of index.ts (wiring-unification B5).
 */

import * as os from 'os';
import {
  loadConfig,
  buildAvailableProviders,
  buildMachineInfo,
  type HostStatusSnapshot,
  type StatusResponse,
  type StandaloneWsStatusPayload,
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

export function buildStandaloneWsStatus(snapshot: HostStatusSnapshot, providerLoader: Parameters<typeof buildAvailableProviders>[0] | null | undefined): StandaloneWsStatusPayload {
  // The 'live' snapshot omits availableProviders (that field only ships in the
  // heavier 'full'/'metadata' profiles). But the web dashboard reads the
  // provider inventory — including each provider's advisory modelOptions /
  // thinkingLevelOptions — off `daemon.availableProviders`, and that inventory
  // is the single source of truth for the New-session dialog AND the mesh node
  // slot editor. Without it here, both fall back to a free-text Model field.
  // The projection is loader-cache-backed (no per-call disk IO), so attach it.
  const availableProviders = providerLoader
    ? buildAvailableProviders(providerLoader)
    : undefined;
  return {
    instanceId: snapshot.instanceId,
    machine: snapshot.machine,
    timestamp: snapshot.timestamp,
    sessions: snapshot.sessions,
    terminalBackend: snapshot.terminalBackend,
    ...(availableProviders && availableProviders.length ? { availableProviders } : {}),
  };
}

export function buildStandaloneWsStatusSignature(status: StandaloneWsStatusPayload): string {
  return JSON.stringify({
    instanceId: status.instanceId,
    machine: {
      hostname: status.machine.hostname,
      platform: status.machine.platform,
    },
    // Provider inventory rarely changes, but the first status broadcast that
    // carries it (once detection settles) must not be deduped away — otherwise
    // the slot editor / New-session dialog never receive the provider list.
    // Fold a compact per-provider fingerprint (type + machineStatus + advisory
    // option lists) so an inventory change re-broadcasts.
    providers: (status.availableProviders || []).map((p) => ({
      type: p.type,
      machineStatus: p.machineStatus,
      modelOptions: p.modelOptions,
      thinkingLevelOptions: p.thinkingLevelOptions,
    })),
    sessions: status.sessions.map((session: typeof status.sessions[number]) => ({
      id: session.id,
      parentId: session.parentId,
      providerType: session.providerType,
      kind: session.kind,
      transport: session.transport,
      status: session.status,
      title: session.title,
      cdpConnected: session.cdpConnected,
      lastSeenAt: session.lastSeenAt,
      unread: session.unread,
      inboxBucket: session.inboxBucket,
      surfaceHidden: session.surfaceHidden,
      muted: session.muted,
    })),
  });
}
