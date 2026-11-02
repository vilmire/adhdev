/** Pure host-handoff probe contract. Shared so the provider loader can reject
 * an incomplete declaration without importing the mesh executor. */
export interface HostHandoffCanarySpec {
    version: 1;
    privateContextDisabled: true;
    toolsDisabled: true;
    /** Must contain the fixed budget and prompt substitutions. No shell. */
    args: string[];
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

/** Why a manifest cannot be a bounded probe. Undefined means the declared args match this selection. */
export function describeCanaryContract(provider: CanaryContractProvider, selection: CanaryContractSelection): string | undefined {
    const spec = provider.hostHandoffCanary;
    const fail = (reason: string) => `canary_contract_unsupported: ${reason}`;
    if (provider.type !== selection.provider) return fail('provider_mismatch');
    if (!spec) return fail(`missing_declaration:${selection.provider || 'unknown'}`);
    if (spec.version !== 1 || spec.privateContextDisabled !== true || spec.toolsDisabled !== true
        || !Array.isArray(spec.args) || spec.args.some(a => typeof a !== 'string' || a.includes('\0')) || !provider.spawn?.command) {
        return fail('declaration_incomplete');
    }
    if (!spec.args.some(a => a.includes('{{prompt}}'))) return fail('missing_prompt_binding');
    if (!spec.args.some(a => a.includes('{{maxTurns}}'))) return fail('missing_max_turns_binding');
    if (!spec.args.some(a => a.includes('{{maxOutputTokens}}'))) return fail('missing_max_output_tokens_binding');
    if (selection.model !== undefined && !spec.args.some(a => a.includes('{{model}}'))) return fail('missing_model_binding');
    if (selection.thinkingLevel !== undefined && !spec.args.some(a => a.includes('{{thinkingLevel}}'))) return fail('missing_thinking_binding');
    return undefined;
}
