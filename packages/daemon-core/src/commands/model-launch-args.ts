/** Expand a CLI provider's model template, mapping display labels when declared. */
export function expandModelLaunchArgs(
    template: string[] | undefined,
    model: string | undefined,
    valueMap: Record<string, string> | undefined = undefined,
): string[] | undefined {
    const requested = typeof model === 'string' ? model.trim() : '';
    if (!requested || !Array.isArray(template) || template.length === 0) return undefined;
    const mapped = typeof valueMap?.[requested] === 'string' && valueMap[requested].trim()
        ? valueMap[requested].trim()
        : requested;
    return template.map((part) => part.includes('{{model}}')
        ? part.split('{{model}}').join(mapped)
        : part);
}
