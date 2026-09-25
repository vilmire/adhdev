import type { ProviderChannel } from './channel/contract.js';

export interface ProviderAvailabilityState {
  installed: boolean;
  detectedPath: string | null;
}

export type ProviderMachineStatus =
  | 'disabled'
  | 'enabled_unchecked'
  | 'not_detected'
  | 'detected';

/**
 * Read-only verified-channel staleness probe result.
 * staleTypes: pinned providers whose channel entry moved past the local pin.
 * newTypes: activatable channel entries never activated nor installed here
 * (unreachable by activate_provider_updates — needs an explicit install).
 */
export interface ProviderChannelStalenessSnapshot {
  checkedAt: string;
  channel: ProviderChannel;
  staleTypes: string[];
  newTypes: string[];
  error?: string;
}

export interface MachineProviderCheckResult {
  ok: boolean;
  stage?: 'detection' | 'runnable' | 'verification';
  checkedAt?: string;
  message?: string;
  command?: string;
  path?: string | null;
}

export interface MachineProviderConfig {
  enabled?: boolean;
  /**
   * Per-provider quota probe switch. INDEPENDENT of `enabled`, which gates
   * launching instances and mesh claims: a machine can use a provider and
   * still not want its quota probed here. Absent = enabled (backwards
   * compatible); only `false` is meaningful.
   */
  quotaEnabled?: boolean;
  executable?: string;
  args?: string[];
  lastDetection?: MachineProviderCheckResult;
  lastVerification?: MachineProviderCheckResult;
}

export type CliDetectionEntry = {
  id: string;
  displayName: string;
  icon: string;
  command: string;
  args?: string[];
  category: string;
  enabled: boolean;
  versionCommand?: string;
  /**
   * The command install detection resolves, when it differs from `command`.
   * Set only when `spawn.command` is a shell wrapper (e.g. antigravity-cli's
   * `bash -c "… exec agy"`) and the manifest names the real CLI in `binary`:
   * detecting the wrapper would resolve `/bin/bash`, which exists everywhere —
   * the provider looked installed on machines without the CLI, its version was
   * bash's, and model discovery ran `bash models` (2026-09-25).
   */
  detectCommand?: string;
};
