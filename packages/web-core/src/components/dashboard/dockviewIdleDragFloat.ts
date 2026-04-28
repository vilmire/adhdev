export const DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS = 500

export interface DockviewIdleDragFloatPoint {
    clientX: number
    clientY: number
}

export interface DockviewIdleDragFloatDetachEvent extends DockviewIdleDragFloatPoint {
    panelId: string
}

export interface DockviewIdleDragFloatController {
    startDrag: (event: { panelId: string } & DockviewIdleDragFloatPoint) => void
    markNoDropTarget: (point: DockviewIdleDragFloatPoint) => void
    markDockTarget: (point?: DockviewIdleDragFloatPoint) => void
    endDrag: () => void
    isDragging: () => boolean
    hasDetached: () => boolean
    dispose: () => void
}

interface DockviewIdleDragFloatControllerOptions {
    detachDelayMs?: number
    onDetach: (event: DockviewIdleDragFloatDetachEvent) => void
    setTimeoutFn?: typeof globalThis.setTimeout
    clearTimeoutFn?: typeof globalThis.clearTimeout
}

export function createDockviewIdleDragFloatController({
    detachDelayMs = DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
    onDetach,
    setTimeoutFn = globalThis.setTimeout.bind(globalThis),
    clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
}: DockviewIdleDragFloatControllerOptions): DockviewIdleDragFloatController {
    let draggingPanelId: string | null = null
    let lastPoint: DockviewIdleDragFloatPoint | null = null
    let detachTimer: ReturnType<typeof setTimeoutFn> | null = null
    let detached = false

    const clearDetachTimer = () => {
        if (detachTimer == null) return
        clearTimeoutFn(detachTimer)
        detachTimer = null
    }

    const reset = () => {
        clearDetachTimer()
        draggingPanelId = null
        lastPoint = null
        detached = false
    }

    const armDetachTimer = () => {
        if (!draggingPanelId || !lastPoint || detached || detachTimer != null) return
        detachTimer = setTimeoutFn(() => {
            detachTimer = null
            if (!draggingPanelId || !lastPoint || detached) return
            detached = true
            onDetach({
                panelId: draggingPanelId,
                clientX: lastPoint.clientX,
                clientY: lastPoint.clientY,
            })
        }, detachDelayMs)
    }

    return {
        startDrag: event => {
            clearDetachTimer()
            draggingPanelId = event.panelId
            lastPoint = { clientX: event.clientX, clientY: event.clientY }
            detached = false
        },
        markNoDropTarget: point => {
            if (!draggingPanelId || detached) return
            lastPoint = { clientX: point.clientX, clientY: point.clientY }
            armDetachTimer()
        },
        markDockTarget: point => {
            if (!draggingPanelId || detached) return
            if (point) lastPoint = { clientX: point.clientX, clientY: point.clientY }
            clearDetachTimer()
        },
        endDrag: reset,
        isDragging: () => draggingPanelId != null,
        hasDetached: () => detached,
        dispose: reset,
    }
}

export function isDockviewIdleDragFloatEnabled(storage: Storage | null | undefined = typeof window === 'undefined' ? null : window.localStorage) {
    return storage?.getItem('adhdev:dockviewIdleDragFloat') !== 'off'
}
