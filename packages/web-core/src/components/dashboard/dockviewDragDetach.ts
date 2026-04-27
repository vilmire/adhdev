type DockviewLocationType = 'grid' | 'floating' | 'popout'

export interface DockviewTabDragDetachDecisionInput {
    isDefaultPrevented: boolean
    locationType: DockviewLocationType
    groupPanelCount: number
}

export interface DockviewDragDetachRect {
    left: number
    top: number
    width?: number
    height?: number
}

export interface DockviewDragDetachFloatingOptionsInput {
    rootRect: DockviewDragDetachRect
    tabRect: DockviewDragDetachRect
    defaultWidth?: number
    defaultHeight?: number
}

export interface DockviewDragDetachFloatingOptions {
    x: number
    y: number
    width: number
    height: number
    inDragMode: true
}

export function shouldDetachDockviewTabDrag({
    isDefaultPrevented,
    locationType,
    groupPanelCount,
}: DockviewTabDragDetachDecisionInput) {
    if (isDefaultPrevented) return false
    return !(locationType === 'floating' && groupPanelCount <= 1)
}

export function getDockviewDragDetachFloatingOptions({
    rootRect,
    tabRect,
    defaultWidth = 600,
    defaultHeight = 500,
}: DockviewDragDetachFloatingOptionsInput): DockviewDragDetachFloatingOptions {
    return {
        x: Math.max(0, Math.round(tabRect.left - rootRect.left)),
        y: Math.max(0, Math.round(tabRect.top - rootRect.top)),
        width: defaultWidth,
        height: defaultHeight,
        inDragMode: true,
    }
}
