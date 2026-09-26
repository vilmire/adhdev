/**
 * blueprintViewMode — the Blueprint List / Graph switch, remembered per
 * viewer (this browser) in localStorage. Storage is a convenience: every
 * access is try/catch'd (private windows, blocked site data, previews) and a
 * missing / unreadable value falls back to the structural default.
 *
 * Default when the viewer never chose: Graph as soon as the snapshot HAS
 * structure (a queue dependency or a graph gate/edge — see
 * snapshotHasStructure), List otherwise. The default only ever flips
 * list → graph (the caller latches "structure seen"), so a live poll can
 * never yank an open graph back to the list.
 */
export type BlueprintViewMode = 'list' | 'graph'

export const BLUEPRINT_VIEW_MODE_STORAGE_KEY = 'adhdev.mesh.blueprint.viewMode'

export function readBlueprintViewMode(): BlueprintViewMode | null {
    try {
        const raw = window.localStorage.getItem(BLUEPRINT_VIEW_MODE_STORAGE_KEY)
        return raw === 'list' || raw === 'graph' ? raw : null
    } catch {
        return null
    }
}

export function writeBlueprintViewMode(mode: BlueprintViewMode): void {
    try {
        window.localStorage.setItem(BLUEPRINT_VIEW_MODE_STORAGE_KEY, mode)
    } catch {
        // Storage unavailable — the choice lasts for this mount only.
    }
}

export function resolveBlueprintViewMode(stored: BlueprintViewMode | null, structureSeen: boolean): BlueprintViewMode {
    return stored ?? (structureSeen ? 'graph' : 'list')
}
