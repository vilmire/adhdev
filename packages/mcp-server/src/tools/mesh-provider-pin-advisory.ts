import { providerPinsFromRequiredTags } from '@adhdev/daemon-core';

/** Request-only advice. Never infer a restriction from a selected provider/session. */
export function withProviderPinWarning<T extends Record<string, unknown>>(
    response: T, requestedProviders: string[],
): T & { providerPinWarnings?: unknown[] } {
    const pins = [...new Set(requestedProviders.map(p => p.trim()).filter(Boolean))];
    if (!pins.length) return response;
    const recommendation = pins.map(provider => `You explicitly pinned provider ${provider}. Unless there is a specific reason, omit the provider pin and let automatic routing choose.`).join(' ');
    return {
        ...response,
        providerPinWarnings: [
            ...(Array.isArray(response.providerPinWarnings) ? response.providerPinWarnings : []),
            { code: 'explicit_provider_pin', requestedProviders: pins, recommendation },
        ],
    };
}

/** Canonical snake_case wins, including an explicitly empty tag list. */
export function requestedProviderPins(input: unknown): string[] {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
    const args = input as { required_tags?: unknown; requiredTags?: unknown };
    const tags = Object.prototype.hasOwnProperty.call(args, 'required_tags') ? args.required_tags : args.requiredTags;
    return providerPinsFromRequiredTags(Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : []);
}
