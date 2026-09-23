/**
 * The value a CLI provider receives for a requested model: the manifest's
 * `modelLaunchValueMap` translates a display label to its slug; anything
 * unmapped passes through unchanged. Undefined when nothing was requested.
 *
 * Shared by the argv expansion below and the launch record
 * (`SessionLaunchRecord.model.launchValue`), so the two can never disagree.
 */
export function resolveModelLaunchValue(
    model: string | undefined,
    valueMap: Partial<Record<string, string>> | undefined = undefined,
): string | undefined {
    const requested = typeof model === 'string' ? model.trim() : '';
    if (!requested) return undefined;
    const mapped = valueMap?.[requested];
    return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : requested;
}

/** Expand a CLI provider's model template, mapping display labels when declared. */
export function expandModelLaunchArgs(
    template: string[] | undefined,
    model: string | undefined,
    valueMap: Record<string, string> | undefined = undefined,
): string[] | undefined {
    const mapped = resolveModelLaunchValue(model, valueMap);
    if (!mapped || !Array.isArray(template) || template.length === 0) return undefined;
    return template.map((part) => part.includes('{{model}}')
        ? part.split('{{model}}').join(mapped)
        : part);
}
