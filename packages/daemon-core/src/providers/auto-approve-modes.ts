import type {
  AutoApproveMode,
  AutoApproveModeRisk,
  AutoApproveModeStrategy,
  ProviderModule,
} from './contracts.js';

const KNOWN_DANGEROUS_LAUNCH_ARGS = new Set([
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  'sandbox_mode=danger-full-access',
  'approval_policy=never',
]);

export interface ResolvedAutoApproveMode {
  active: boolean;
  strategy: AutoApproveModeStrategy;
  modeId: string;
}

function isKnownDangerousLaunchArg(arg: string): boolean {
  const normalized = arg.trim();
  if (KNOWN_DANGEROUS_LAUNCH_ARGS.has(normalized)) return true;
  return normalized.startsWith('--dangerously-skip-permissions=')
    || normalized.startsWith('--dangerously-bypass-approvals-and-sandbox=');
}

/** Runtime defense-in-depth for provider definitions that bypass schema validation. */
export function deriveAutoApproveModeRisk(mode: Pick<AutoApproveMode, 'risk' | 'launchArgs'>): AutoApproveModeRisk {
  return Array.isArray(mode.launchArgs) && mode.launchArgs.some(isKnownDangerousLaunchArg)
    ? 'dangerous'
    : mode.risk;
}

function inactiveMode(modeId = ''): ResolvedAutoApproveMode {
  return { active: false, strategy: 'pty-parse-default', modeId };
}

function resolveConfiguredMode(
  provider: ProviderModule,
  mode: AutoApproveMode,
  settings: Record<string, unknown> | undefined,
): ResolvedAutoApproveMode {
  if (mode.strategy === 'post-boot-command') return inactiveMode(mode.id);
  if (settings?.launchedByCoordinator === true
      && settings.delegatedWorkerDangerousModeAllow !== true
      && deriveAutoApproveModeRisk(mode) === 'dangerous') {
    const fallback = provider.autoApproveModes?.modes.find((candidate) =>
      candidate.strategy === 'pty-parse-default'
      && deriveAutoApproveModeRisk(candidate) !== 'dangerous');
    return fallback
      ? { active: true, strategy: fallback.strategy, modeId: fallback.id }
      : inactiveMode(mode.id);
  }
  return { active: true, strategy: mode.strategy, modeId: mode.id };
}

/**
 * Resolve new mode settings before the legacy boolean. A stale/unknown explicit
 * mode id fails closed instead of falling through to an enabled legacy setting.
 */
export function resolveProviderAutoApproveMode(
  provider: ProviderModule,
  settings: Record<string, unknown> | undefined,
): ResolvedAutoApproveMode {
  const config = provider.autoApproveModes;
  const explicitModeId = settings?.autoApproveMode;
  if (typeof explicitModeId === 'string') {
    const mode = config?.modes.find((candidate) => candidate.id === explicitModeId);
    if (!mode) return inactiveMode(explicitModeId);
    return resolveConfiguredMode(provider, mode, settings);
  }

  const explicitLegacy = settings?.autoApprove;
  const providerLegacyDefault = provider.settings?.autoApprove?.default;
  const legacyActive = typeof explicitLegacy === 'boolean'
    ? explicitLegacy
    : typeof providerLegacyDefault === 'boolean'
      ? providerLegacyDefault
      : false;
  if (!legacyActive) return inactiveMode();

  if (!config) {
    return { active: true, strategy: 'pty-parse-default', modeId: 'legacy' };
  }
  const defaultMode = config.modes.find((mode) => mode.id === config.default);
  if (!defaultMode) return inactiveMode(config.default);
  return resolveConfiguredMode(provider, defaultMode, settings);
}

export function findProviderAutoApproveMode(
  provider: ProviderModule | undefined,
  modeId: string,
): AutoApproveMode | undefined {
  return provider?.autoApproveModes?.modes.find((mode) => mode.id === modeId);
}
