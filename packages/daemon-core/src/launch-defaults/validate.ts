import { resolveModelOptions } from '../models/overlay.js';
import type { ModelDiscoverySnapshot } from '../models/types.js';
import { isModelCompatibleWithProvider } from '../mesh/model-provider-compat.js';

export type LaunchRole = 'assistant' | 'coordinator';
export type LaunchField = 'provider' | 'model' | 'thinkingLevel';
export interface LaunchSelection {
    provider: string;
    model?: string;
    thinkingLevel?: string;
}
export type ToolRestriction = 'enforced' | 'prompt_only';
export interface LaunchProviderFacts {
    type: string;
    category: string;
    enabled: boolean;
    detected: boolean;
    quotaGated?: boolean;
    assistant: { supported: boolean; toolRestriction: ToolRestriction };
    coordinator: 'supported' | 'manual' | 'unsupported';
    modelLaunchArgs?: readonly string[];
    modelOptions?: string[];
    modelLaunchValueMap?: Record<string, string>;
    discovery?: ModelDiscoverySnapshot;
    thinkingLaunchArgs?: readonly string[];
    thinkingLevelOptions?: readonly string[];
    /** True only when the adapter actually applies initialThinkingLevel. */
    runtimeThinking?: boolean;
}
/** Read-only snapshots from the existing registry, detection and role planners.
 * Adapters must not install, enable, discover or otherwise mutate providers. */
export interface LaunchValidationPorts {
    resolveAlias(provider: string): string;
    getProvider(canonicalProvider: string, model?: string): LaunchProviderFacts | undefined;
}
export type LaunchValidationReason =
    | 'invalid_schema' | 'provider_unknown' | 'provider_not_cli'
    | 'provider_disabled' | 'provider_not_detected' | 'provider_not_eligible' | 'provider_quota_gated'
    | 'model_unsupported' | 'model_provider_mismatch' | 'model_not_offered'
    | 'thinking_unsupported' | 'thinking_not_offered' | 'catalog_unavailable';
export interface LaunchValidationIssue {
    field: LaunchField;
    reason: LaunchValidationReason;
    candidates?: readonly string[];
}
export type LaunchValidationWarning = 'catalog_unverified' | 'manual_mcp_setup_required';
export type LaunchValidationResult =
    | { ok: false; issue: LaunchValidationIssue }
    | { ok: true; selection: LaunchSelection; warnings: LaunchValidationWarning[];
        toolRestriction: ToolRestriction; lowersToolLock: boolean };

export function isLaunchRole(value: unknown): value is LaunchRole {
    return value === 'assistant' || value === 'coordinator';
}
export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).every(key => keys.includes(key));
}
function isValue(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 512
        && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
/** Null, blank values and unknown keys are errors; omission means CLI default. */
export function selectionSchemaIssue(value: unknown, partial = false): LaunchValidationIssue | undefined {
    if (!isRecord(value) || !hasOnlyKeys(value, ['provider', 'model', 'thinkingLevel'])) {
        return { field: 'provider', reason: 'invalid_schema' };
    }
    for (const field of ['provider', 'model', 'thinkingLevel'] as const) {
        if ((field === 'provider' && !partial || Object.hasOwn(value, field)) && !isValue(value[field])) {
            return { field, reason: 'invalid_schema' };
        }
    }
    return undefined;
}

/** Same validator for explicit setup writes and launch-time revalidation. */
export function validateLaunchDefault(
    role: LaunchRole,
    candidate: unknown,
    ports: LaunchValidationPorts,
    previousToolRestriction?: ToolRestriction,
): LaunchValidationResult {
    const issue = selectionSchemaIssue(candidate);
    if (!isLaunchRole(role) || issue) return { ok: false, issue: issue ?? { field: 'provider', reason: 'invalid_schema' } };
    const selection = { ...candidate as LaunchSelection };
    const fail = (field: LaunchField, reason: LaunchValidationReason, candidates?: readonly string[]): LaunchValidationResult =>
        ({ ok: false, issue: { field, reason, ...(candidates ? { candidates } : {}) } });
    try {
        selection.provider = ports.resolveAlias(selection.provider);
        const facts = ports.getProvider(selection.provider, selection.model);
        if (!facts || facts.type !== selection.provider) return fail('provider', 'provider_unknown');
        if (facts.category !== 'cli') return fail('provider', 'provider_not_cli');
        if (facts.enabled !== true) return fail('provider', 'provider_disabled');
        if (facts.detected !== true) return fail('provider', 'provider_not_detected');
        if (facts.quotaGated === true) return fail('provider', 'provider_quota_gated');
        if (role === 'assistant' ? facts.assistant.supported !== true : !['supported', 'manual'].includes(facts.coordinator)) {
            return fail('provider', 'provider_not_eligible');
        }
        const warnings: LaunchValidationWarning[] = [];
        if (role === 'coordinator' && facts.coordinator === 'manual') warnings.push('manual_mcp_setup_required');
        if (selection.model !== undefined) {
            if (!facts.modelLaunchArgs?.length) return fail('model', 'model_unsupported');
            if (!isModelCompatibleWithProvider(selection.model, selection.provider)) return fail('model', 'model_provider_mismatch');
            const options = resolveModelOptions(facts.modelOptions, facts.discovery, facts.modelLaunchValueMap);
            if (facts.discovery?.status === 'ok') {
                // Empty successful discovery cannot prove any requested model usable.
                if (!facts.discovery.models.length) return fail('model', 'catalog_unavailable');
                if (!options.includes(selection.model)) return fail('model', 'model_not_offered', options);
            } else {
                // The approved design permits custom models with explicit uncertainty.
                warnings.push('catalog_unverified');
            }
        }
        if (selection.thinkingLevel !== undefined) {
            if (!facts.thinkingLaunchArgs?.length && facts.runtimeThinking !== true) return fail('thinkingLevel', 'thinking_unsupported');
            if (!facts.thinkingLevelOptions?.includes(selection.thinkingLevel)) {
                return fail('thinkingLevel', 'thinking_not_offered', facts.thinkingLevelOptions ?? []);
            }
        }
        const toolRestriction = facts.assistant.toolRestriction;
        return { ok: true, selection, warnings, toolRestriction,
            lowersToolLock: role === 'assistant' && previousToolRestriction === 'enforced' && toolRestriction === 'prompt_only' };
    } catch {
        return fail('provider', 'catalog_unavailable');
    }
}
