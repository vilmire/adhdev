import type {
    AutoApproveMode,
    AutoApproveModeRisk,
    AutoApproveModesConfig,
} from '@adhdev/daemon-core'

const KNOWN_DANGEROUS_LAUNCH_ARGS = new Set([
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
    'bypassPermissions',
    'sandbox_mode=danger-full-access',
    'approval_policy=never',
])

function isKnownDangerousLaunchArg(arg: string): boolean {
    const normalized = arg.trim()
    return KNOWN_DANGEROUS_LAUNCH_ARGS.has(normalized)
        || normalized.startsWith('--dangerously-skip-permissions=')
        || normalized.startsWith('--dangerously-bypass-approvals-and-sandbox=')
}

/**
 * Browser-side defense in depth. Provider manifests are validated by the daemon,
 * but the launch UI must not trust a registry-supplied risk label by itself.
 */
export function deriveAutoApproveModeRisk(
    mode: Pick<AutoApproveMode, 'risk' | 'launchArgs'>,
): AutoApproveModeRisk {
    return mode.launchArgs?.some(isKnownDangerousLaunchArg) ? 'dangerous' : mode.risk
}

/**
 * Never activate a dangerous manifest default without a user confirmation.
 * Prefer the declared default when it is non-dangerous, then any non-dangerous
 * PTY mode, then any other non-dangerous mode. An all-dangerous config starts off.
 */
export function resolveInitialAutoApproveModeId(
    config: AutoApproveModesConfig | null | undefined,
): string {
    if (!config) return ''
    const declaredDefault = config.modes.find(mode => mode.id === config.default)
    if (declaredDefault && deriveAutoApproveModeRisk(declaredDefault) !== 'dangerous') {
        return declaredDefault.id
    }
    return config.modes.find(mode => (
        mode.strategy === 'pty-parse-default'
        && deriveAutoApproveModeRisk(mode) !== 'dangerous'
    ))?.id || config.modes.find(mode => deriveAutoApproveModeRisk(mode) !== 'dangerous')?.id || ''
}

export function buildAutoApproveLaunchSettings(
    config: AutoApproveModesConfig | null | undefined,
    selectedModeId: string,
    legacyAutoApprove: boolean,
): { autoApprove?: boolean; autoApproveMode?: string } {
    if (!config) return { autoApprove: legacyAutoApprove }
    if (!selectedModeId) return { autoApprove: false }
    return { autoApproveMode: selectedModeId }
}
