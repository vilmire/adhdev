import type { AutoApproveMode, AutoApproveModesConfig } from '@adhdev/daemon-core'
import { deriveAutoApproveModeRisk } from './auto-approve-modes'

/**
 * Browser-side mirror of daemon-core resolveDelegatedWorkerAutoApprove (Task1)
 * for DISPLAY ONLY. The daemon remains the single source of truth at launch —
 * this reproduces the same three-stage decision so the MeshDetailView can show a
 * truthful "Effective result" (and the reason a repo-requested mode is downgraded)
 * WITHOUT hiding the machine-local gating behind the committed repo default.
 *
 * Stages (must match repo-mesh-types.ts):
 *   ① ENABLE gate — machine-local delegatedWorkerAutoApprove (node > mesh). false
 *      short-circuits to "off"; a repo-requested mode NEVER re-enables it.
 *   ② MODE selection — repo providerDefaults[type] (validated against the provider
 *      spec; unknown → provider spec default) else the provider spec default.
 *   ③ DANGEROUS gate — a dangerous selection downgrades to a non-dangerous
 *      pty-parse mode unless machine-local delegatedWorkerDangerousModeAllow is set.
 */

export type EffectiveAutoApproveStatus =
  | 'disabled'          // machine ENABLE gate is off → no auto-approve at all
  | 'requested'         // the repo-requested (or provider-default) mode is used as-is
  | 'downgraded'        // requested mode is dangerous + no machine opt-in → pty-parse
  | 'invalid_fallback'  // repo requested an unknown mode id → provider default used
  | 'none'              // no usable non-dangerous mode exists → off

export interface EffectiveAutoApproveResult {
  status: EffectiveAutoApproveStatus
  /** The mode id the repo requested (from mesh.json providerDefaults), if any. */
  requestedModeId?: string
  /** The mode id the provider spec would default to (stage ② fallback). */
  providerDefaultModeId?: string
  /** The mode actually used on this machine after stages ②③, if auto-approve fires. */
  effectiveMode?: AutoApproveMode
  /** True when the requested mode id was not found in the provider spec. */
  requestedModeUnknown: boolean
  /** True when the effective decision was downgraded from a dangerous request. */
  downgraded: boolean
}

function findMode(config: AutoApproveModesConfig, id: string | undefined): AutoApproveMode | undefined {
  if (!id) return undefined
  return config.modes.find(mode => mode.id === id)
}

function firstNonDangerousPty(config: AutoApproveModesConfig): AutoApproveMode | undefined {
  return config.modes.find(mode =>
    mode.strategy === 'pty-parse-default' && deriveAutoApproveModeRisk(mode) !== 'dangerous')
}

export interface ResolveEffectiveArgs {
  config: AutoApproveModesConfig
  /** Repo mesh.json providerDefaults requested mode id for this provider (may be absent). */
  requestedModeId?: string
  /** Machine-local ENABLE gate (mesh policy delegatedWorkerAutoApprove; default true). */
  machineAutoApproveEnabled: boolean
  /** Machine-local dangerous opt-in (delegatedWorkerDangerousModeAllow; default false). */
  machineDangerousAllowed: boolean
}

export function resolveEffectiveAutoApprove({
  config,
  requestedModeId,
  machineAutoApproveEnabled,
  machineDangerousAllowed,
}: ResolveEffectiveArgs): EffectiveAutoApproveResult {
  const providerDefaultMode = findMode(config, config.default)
  const providerDefaultModeId = providerDefaultMode?.id
  const trimmedRequested = requestedModeId?.trim() || undefined

  // ① ENABLE gate (machine-local). A repo-requested mode has NO influence here.
  if (!machineAutoApproveEnabled) {
    return {
      status: 'disabled',
      requestedModeId: trimmedRequested,
      providerDefaultModeId,
      requestedModeUnknown: false,
      downgraded: false,
    }
  }

  // ② MODE selection. A repo-requested id is adopted only if the provider spec
  //    knows it; an unknown id fails closed to the provider default.
  const requestedMode = findMode(config, trimmedRequested)
  const requestedModeUnknown = !!trimmedRequested && !requestedMode
  const selectedMode = requestedMode ?? providerDefaultMode

  // post-boot-command modes and a missing default resolve to "off" (mirrors the daemon).
  if (!selectedMode || selectedMode.strategy === 'post-boot-command') {
    return {
      status: 'none',
      requestedModeId: trimmedRequested,
      providerDefaultModeId,
      requestedModeUnknown,
      downgraded: false,
    }
  }

  // ③ DANGEROUS gate.
  if (deriveAutoApproveModeRisk(selectedMode) === 'dangerous' && !machineDangerousAllowed) {
    const fallback = firstNonDangerousPty(config)
    return {
      status: fallback ? 'downgraded' : 'none',
      requestedModeId: trimmedRequested,
      providerDefaultModeId,
      effectiveMode: fallback,
      requestedModeUnknown,
      downgraded: true,
    }
  }

  return {
    status: requestedModeUnknown ? 'invalid_fallback' : 'requested',
    requestedModeId: trimmedRequested,
    providerDefaultModeId,
    effectiveMode: selectedMode,
    requestedModeUnknown,
    downgraded: false,
  }
}
