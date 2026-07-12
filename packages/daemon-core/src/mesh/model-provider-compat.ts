/**
 * Provider ↔ model compatibility guard for brain/slot-derived launch models.
 *
 * WHY THIS EXISTS: the difficulty→brain presets (and MAGI slots) carry
 * provider-agnostic model strings like `opus`/`sonnet`/`haiku`, which are
 * Anthropic (Claude) model names. When a task lands on a node whose provider is
 * NOT Anthropic-backed — `codex-cli` (ChatGPT), `antigravity-cli`, `hermes-cli`
 * — forwarding a `claude-*` model as the launch arg makes that provider convert
 * it to e.g. `-c model='claude-...'`, and a ChatGPT-account codex then rejects
 * the launch with a 400. The model string was never meant to be forced onto a
 * provider that can't honor it (presets are "best-effort at launch").
 *
 * The invariant this enforces: **an Anthropic (`claude-*`) model is never passed
 * as a launch argument to a non-Anthropic provider.** When a preset/slot model is
 * incompatible with the resolved provider, drop the model (the provider then uses
 * its own default) and keep only the provider-neutral axis (thinkingLevel).
 *
 * This is deliberately conservative: it only strips a model that is *known* to be
 * Anthropic when the provider is *known* to be non-Anthropic. Unknown models and
 * unknown providers pass through unchanged so a legitimately provider-specific
 * model (e.g. an operator who configured `gpt-5-codex` on a codex slot) is not
 * clobbered.
 */

/**
 * Provider types that are Anthropic-backed (accept `claude-*` / opus/sonnet/haiku
 * model names). Everything else is treated as non-Anthropic for the guard.
 */
const ANTHROPIC_PROVIDER_TYPES: ReadonlySet<string> = new Set([
    'claude-cli',
]);

/**
 * True when `providerType` is an Anthropic-backed provider (Claude). Matching is
 * case-insensitive and tolerant of surrounding whitespace. An empty/undefined
 * provider is treated as non-Anthropic (unknown → don't assume Claude).
 */
export function isAnthropicProvider(providerType: string | undefined | null): boolean {
    const p = typeof providerType === 'string' ? providerType.trim().toLowerCase() : '';
    return p.length > 0 && ANTHROPIC_PROVIDER_TYPES.has(p);
}

/**
 * True when `model` names an Anthropic (Claude) model — the provider-agnostic
 * brain-preset aliases (`opus`/`sonnet`/`haiku`) or any explicit `claude-*` id.
 * Case-insensitive. Non-Anthropic and unknown models return false so they pass
 * the compatibility check unchanged.
 */
export function isAnthropicModel(model: string | undefined | null): boolean {
    const m = typeof model === 'string' ? model.trim().toLowerCase() : '';
    if (!m) return false;
    if (m.startsWith('claude') || m.startsWith('anthropic')) return true;
    // Provider-agnostic brain-preset aliases (DEFAULT_DIFFICULTY_BRAINS) are Claude
    // model families; a bare `opus`/`sonnet`/`haiku` (optionally with a suffix like
    // `opus-4` or `sonnet-4-5`) means an Anthropic model.
    return /^(opus|sonnet|haiku)(\b|[-_])/.test(m);
}

/**
 * Compatibility check for a brain/slot-derived launch model against the provider
 * it would launch on. Returns false ONLY for the concrete failure mode we guard:
 * an Anthropic model routed to a non-Anthropic provider. Everything else
 * (no model, non-Anthropic model, Anthropic provider, unknown provider) is
 * compatible so nothing legitimate is stripped.
 */
export function isModelCompatibleWithProvider(
    model: string | undefined | null,
    providerType: string | undefined | null,
): boolean {
    if (!isAnthropicModel(model)) return true;      // non-Claude model → no constraint
    if (isAnthropicProvider(providerType)) return true; // Claude model on Claude provider → fine
    return false;                                    // Claude model on non-Claude provider → block
}
