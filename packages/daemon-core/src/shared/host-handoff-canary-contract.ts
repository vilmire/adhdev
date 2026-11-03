/** Pure host-handoff probe contract. Shared so the provider loader can reject
 * an incomplete declaration without importing the mesh executor.
 * The host enforces the time and output-byte bounds. A native billable turn
 * cap or output-token cap is not part of this contract and must not be claimed. */
export const HANDOFF_CANARY_HOST_TIMEOUT_MS = 15_000;
export const HANDOFF_CANARY_HOST_MAX_OUTPUT_BYTES = 16_384;

export interface HostHandoffCanarySpec {
    version: 1;
    enforcement: 'host';
    hostTimeoutMs: typeof HANDOFF_CANARY_HOST_TIMEOUT_MS;
    hostMaxOutputBytes: typeof HANDOFF_CANARY_HOST_MAX_OUTPUT_BYTES;
    nativeTurnCap: false;
    nativeOutputTokenCap: false;
    privateContextDisabled: true;
    toolsDisabled: true;
    /** Real argv. Must bind {{prompt}}. Must not bind a native turn or token cap. */
    args: string[];
    /** Inserted before the prompt only when a non-empty thinking level is selected. */
    thinkingArgs?: string[];
}

export interface CanaryContractProvider {
    type: string;
    spawn?: { command?: string };
    hostHandoffCanary?: HostHandoffCanarySpec;
}

export interface CanaryContractSelection {
    provider: string;
    model?: string;
    thinkingLevel?: string;
}

const NATIVE_CAP_PLACEHOLDERS = ['{{maxTurns}}', '{{maxOutputTokens}}'];

function argvTemplate(value: unknown): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0'));
}

/** Why a manifest cannot be a host-enforced probe. Undefined means this selection matches the declaration. */
export function describeCanaryContract(provider: CanaryContractProvider, selection: CanaryContractSelection): string | undefined {
    const spec = provider.hostHandoffCanary;
    const fail = (reason: string) => `canary_contract_unsupported: ${reason}`;
    if (provider.type !== selection.provider) return fail('provider_mismatch');
    if (!spec) return fail(`missing_declaration:${selection.provider || 'unknown'}`);
    const thinkingArgs = spec.thinkingArgs;
    if (spec.version !== 1 || spec.enforcement !== 'host'
        || spec.hostTimeoutMs !== HANDOFF_CANARY_HOST_TIMEOUT_MS
        || spec.hostMaxOutputBytes !== HANDOFF_CANARY_HOST_MAX_OUTPUT_BYTES
        || spec.nativeTurnCap !== false || spec.nativeOutputTokenCap !== false
        || spec.privateContextDisabled !== true || spec.toolsDisabled !== true
        || !argvTemplate(spec.args) || (thinkingArgs !== undefined && !argvTemplate(thinkingArgs))
        || !provider.spawn?.command) {
        return fail('declaration_incomplete');
    }
    const declared = [...spec.args, ...(thinkingArgs ?? [])];
    if (declared.some(arg => NATIVE_CAP_PLACEHOLDERS.some(token => arg.includes(token)))) return fail('native_cap_placeholder');
    if (spec.args.some(arg => arg.includes('{{thinkingLevel}}'))) return fail('thinking_binding_in_base_args');
    if (!spec.args.some(arg => arg.includes('{{prompt}}'))) return fail('missing_prompt_binding');
    const modelBound = spec.args.some(arg => arg.includes('{{model}}'));
    if (selection.model !== undefined && selection.model !== '' && !modelBound) return fail('missing_model_binding');
    if (modelBound && (selection.model === undefined || selection.model === '')) return fail('missing_model_selection');
    if (thinkingArgs !== undefined && !thinkingArgs.some(arg => arg.includes('{{thinkingLevel}}'))) return fail('declaration_incomplete');
    if (typeof selection.thinkingLevel === 'string' && selection.thinkingLevel.length > 0
        && !thinkingArgs?.some(arg => arg.includes('{{thinkingLevel}}'))) return fail('missing_thinking_binding');
    return undefined;
}
