/**
 * Provider trust classification.
 *
 * Each loaded provider gets a `trust` tag that the daemon and dashboard
 * use to decide what to surface and what to gate behind a confirmation
 * prompt. Trust is a function of *where* the provider came from
 * (upstream / external / userDir) and the *shape of the manifest*
 * (spec-only vs. carries JavaScript hooks).
 *
 * Rationale:
 *   - Spec-only manifests are static declarative configuration; the
 *     daemon's spec adapter walks the spec but never executes code
 *     authored by the provider.
 *   - Non-spec manifests ship JavaScript (tui-block builders consumed
 *     by the SDK, scriptDir overrides, or explicit `overrides.* .path`
 *     bindings). That code runs inside the daemon process with the
 *     same privileges as adhdev itself.
 *
 * Source × shape decides the trust label:
 *
 *   layer    | spec-only           | non-spec
 *   ---------|---------------------|-----------------------
 *   user     | user-custom         | user-custom
 *   upstream | trusted             | trusted-with-scripts
 *   external | external-safe       | external-untrusted
 *
 * Dashboards should always show a badge for `trusted-with-scripts`
 * (info — runs official JS), `external-safe` (info — declarative only,
 * but 3rd-party), and `external-untrusted` (warning — runs JS from a
 * 3rd-party). Activation of `external-untrusted` should require an
 * explicit confirmation step that names the source URL.
 */
'use strict';

export type ProviderTrust =
    | 'user-custom'
    | 'trusted'
    | 'trusted-with-scripts'
    | 'external-safe'
    | 'external-untrusted';

export type ProviderLayer = 'user' | 'upstream' | 'external';

export interface ProviderManifestShape {
    /** Has a `tui` block — SDK builders consume it as code paths. */
    hasTui: boolean;
    /** Has a non-empty `overrides` object — JS override paths. */
    hasOverrides: boolean;
    /** compatibility[].scriptDir or defaultScriptDir is set — JS scripts dir. */
    hasScriptDir: boolean;
}

/**
 * Inspect a manifest to decide whether it ships JavaScript hooks.
 * Cheap; pure; safe to call on every provider load.
 */
export function inspectManifestShape(manifest: Record<string, unknown>): ProviderManifestShape {
    const hasTui = !!manifest.tui && typeof manifest.tui === 'object'
        && Object.keys(manifest.tui as Record<string, unknown>).length > 0;
    const hasOverrides = !!manifest.overrides && typeof manifest.overrides === 'object'
        && !Array.isArray(manifest.overrides)
        && Object.keys(manifest.overrides as Record<string, unknown>).length > 0;
    const compat = Array.isArray(manifest.compatibility) ? manifest.compatibility : [];
    const compatHasScriptDir = compat.some((entry: any) => typeof entry?.scriptDir === 'string');
    const hasScriptDir = compatHasScriptDir || typeof manifest.defaultScriptDir === 'string';
    return { hasTui, hasOverrides, hasScriptDir };
}

/**
 * Classify trust given the layer the provider was loaded from + the
 * manifest's JS-hook footprint.
 */
export function classifyTrust(
    layer: ProviderLayer,
    shape: ProviderManifestShape,
): ProviderTrust {
    const isSpecOnly = !shape.hasTui && !shape.hasOverrides && !shape.hasScriptDir;
    switch (layer) {
        case 'user':
            return 'user-custom';
        case 'upstream':
            return isSpecOnly ? 'trusted' : 'trusted-with-scripts';
        case 'external':
            return isSpecOnly ? 'external-safe' : 'external-untrusted';
    }
}

/**
 * Returns true when activation should require an explicit user confirm.
 * Today only `external-untrusted` qualifies; future trust levels may
 * fold in here.
 */
export function requiresConfirmation(trust: ProviderTrust): boolean {
    return trust === 'external-untrusted';
}

/**
 * Render a short human-readable rationale for the trust tag. Used by
 * the dashboard's confirmation modal and the provider catalog tooltip.
 */
export function describeTrust(trust: ProviderTrust): string {
    switch (trust) {
        case 'user-custom':
            return 'Hand-authored in ~/.adhdev/providers/. Runs your own code.';
        case 'trusted':
            return 'Official, declarative-only manifest from the ADHDev registry.';
        case 'trusted-with-scripts':
            return 'Official manifest from the ADHDev registry. Ships JavaScript hooks executed by the daemon.';
        case 'external-safe':
            return 'Manifest from a 3rd-party git source you added. Declarative-only — the daemon never runs JS from this source.';
        case 'external-untrusted':
            return 'Manifest from a 3rd-party git source you added. Ships JavaScript that the daemon will execute. Treat as untrusted code — review the source before enabling.';
    }
}
