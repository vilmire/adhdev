export const DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS = 1000
export const DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX = 4

export interface DockviewIdleDragFloatPoint {
    clientX: number
    clientY: number
}

export interface DockviewIdleDragFloatBounds {
    left: number
    right: number
    top: number
    bottom: number
}

export interface DockviewIdleDragFloatDetachEvent extends DockviewIdleDragFloatPoint {
    panelId: string
}

export interface DockviewIdleDragFloatController {
    startDrag: (event: { panelId: string; selfPanelBounds?: DockviewIdleDragFloatBounds | null } & DockviewIdleDragFloatPoint) => void
    markSelfPanel: (point: DockviewIdleDragFloatPoint) => void
    markNonSelfPanel: (point?: DockviewIdleDragFloatPoint) => void
    markNoDropTarget: (point: DockviewIdleDragFloatPoint) => void
    markDockTarget: (point?: DockviewIdleDragFloatPoint) => void
    endDrag: () => void
    isDragging: () => boolean
    hasDetached: () => boolean
    dispose: () => void
}

interface DockviewIdleDragFloatControllerOptions {
    detachDelayMs?: number
    stillnessThresholdPx?: number
    onDetach: (event: DockviewIdleDragFloatDetachEvent) => void
    setTimeoutFn?: typeof globalThis.setTimeout
    clearTimeoutFn?: typeof globalThis.clearTimeout
}

function isPointInsideBounds(point: DockviewIdleDragFloatPoint, bounds: DockviewIdleDragFloatBounds | null) {
    if (!bounds) return false
    return point.clientX >= bounds.left
        && point.clientX <= bounds.right
        && point.clientY >= bounds.top
        && point.clientY <= bounds.bottom
}

function hasMovedBeyondThreshold(
    from: DockviewIdleDragFloatPoint,
    to: DockviewIdleDragFloatPoint,
    thresholdPx: number,
) {
    return Math.abs(to.clientX - from.clientX) > thresholdPx
        || Math.abs(to.clientY - from.clientY) > thresholdPx
}

export function createDockviewIdleDragFloatController({
    detachDelayMs = DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
    stillnessThresholdPx = DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
    onDetach,
    setTimeoutFn = globalThis.setTimeout.bind(globalThis),
    clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
}: DockviewIdleDragFloatControllerOptions): DockviewIdleDragFloatController {
    let draggingPanelId: string | null = null
    let selfPanelBounds: DockviewIdleDragFloatBounds | null = null
    let stillnessOriginPoint: DockviewIdleDragFloatPoint | null = null
    let lastPoint: DockviewIdleDragFloatPoint | null = null
    let detachTimer: ReturnType<typeof setTimeoutFn> | null = null
    let detached = false

    const clearDetachTimer = () => {
        if (detachTimer == null) return
        clearTimeoutFn(detachTimer)
        detachTimer = null
    }

    const resetStillnessWindow = () => {
        clearDetachTimer()
        stillnessOriginPoint = null
    }

    const reset = () => {
        clearDetachTimer()
        draggingPanelId = null
        selfPanelBounds = null
        stillnessOriginPoint = null
        lastPoint = null
        detached = false
    }

    const armDetachTimer = () => {
        if (!draggingPanelId || !stillnessOriginPoint || !lastPoint || detached || detachTimer != null) return
        detachTimer = setTimeoutFn(() => {
            detachTimer = null
            if (!draggingPanelId || !stillnessOriginPoint || !lastPoint || detached) return
            if (!isPointInsideBounds(lastPoint, selfPanelBounds)) return
            if (hasMovedBeyondThreshold(stillnessOriginPoint, lastPoint, stillnessThresholdPx)) return
            detached = true
            onDetach({
                panelId: draggingPanelId,
                clientX: lastPoint.clientX,
                clientY: lastPoint.clientY,
            })
        }, detachDelayMs)
    }

    const markSelfPanel = (point: DockviewIdleDragFloatPoint) => {
        if (!draggingPanelId || detached) return
        if (!isPointInsideBounds(point, selfPanelBounds)) {
            lastPoint = { clientX: point.clientX, clientY: point.clientY }
            resetStillnessWindow()
            return
        }

        if (!stillnessOriginPoint || hasMovedBeyondThreshold(stillnessOriginPoint, point, stillnessThresholdPx)) {
            clearDetachTimer()
            stillnessOriginPoint = { clientX: point.clientX, clientY: point.clientY }
        }
        lastPoint = { clientX: point.clientX, clientY: point.clientY }
        armDetachTimer()
    }

    const markNonSelfPanel = (point?: DockviewIdleDragFloatPoint) => {
        if (!draggingPanelId || detached) return
        if (point) lastPoint = { clientX: point.clientX, clientY: point.clientY }
        resetStillnessWindow()
    }

    return {
        startDrag: event => {
            clearDetachTimer()
            draggingPanelId = event.panelId
            selfPanelBounds = event.selfPanelBounds ?? null
            stillnessOriginPoint = null
            lastPoint = { clientX: event.clientX, clientY: event.clientY }
            detached = false
        },
        markSelfPanel,
        markNonSelfPanel,
        markNoDropTarget: markNonSelfPanel,
        markDockTarget: markNonSelfPanel,
        endDrag: reset,
        isDragging: () => draggingPanelId != null,
        hasDetached: () => detached,
        dispose: reset,
    }
}

export function isDockviewIdleDragFloatEnabled(storage: Storage | null | undefined = typeof window === 'undefined' ? null : window.localStorage) {
    return storage?.getItem('adhdev:dockviewIdleDragFloat') !== 'off'
}
